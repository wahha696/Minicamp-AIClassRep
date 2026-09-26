// 桌宠对话框的纯逻辑：把用户的一句话映射成「回答 + 动作」。
// 规则引擎优先（不调 LLM、不发网络请求）：离线可用、零成本、毫秒级回复，还能执行动作；
// 规则没命中的话（matched=false），组件再拿去问 DeepSeek（走后端 /api/pet/chat 代理），
// LLM 也失败时才用本文件的兜底话术。调用方（Pet.tsx）不用关心这个先后顺序之外的细节。
import type { ConnectState, EventDTO, GroupDTO } from '../api/types';
import { petGreeting } from './pet';
import { eventTimeText, hhmm } from './time';

/** 回答时要用的现场数据，全部由组件注入（now 注入以便单测） */
export interface ChatCtx {
  now: number;
  summary?: string;              // 后端今日摘要，如「今天 4 件事，最急的是 14:00 高数小测」
  events: readonly EventDTO[];   // 今日事件
  connect?: ConnectState;        // 当前采集连接状态
}

/** 桌宠能自己执行的动作（组件负责真正去做） */
export type ChatAction = 'sync' | 'stroll' | 'nav-today' | 'nav-week' | 'nav-groups';

export interface PetAnswer {
  text: string;
  action?: ChatAction;
  /** 需要群列表：组件先取 getGroups()，再用 groupListText 追加回答 */
  needGroups?: boolean;
  /** 规则引擎是否命中；false = 兜底话术，组件可以拿同一句话去问 LLM */
  matched: boolean;
}

export const QUICK_QUESTIONS: readonly string[] = ['今天有什么事', '接下来做什么', '最近截止', '同步一下'];

const INTRO =
  '我是 AI 课代表的看板娘，帮你盯着课程群的通知，整理成日历。单击我报日程，右键有更多玩法，双击就能这样跟我聊天~';

const HELP =
  '你可以这样问我：\n· 「今天有什么事」——今日安排\n· 「接下来做什么」——下一件事和倒计时\n· 「最近截止」——快到期的作业\n· 「看看群」——监听中的群\n· 「同步一下」——立即收一遍群消息\n· 「打开本周」——跳到周视图';

const CONNECT_TEXT: Record<ConnectState, string> = {
  online: 'QQ 连接正常，群通知正在实时采集~',
  reconnecting: '连接中断了，我在自动重连，页面照常能用。',
  kicked: '你的 QQ 在另一台电脑登录了，采集暂停。去「连接」页点「重新连接」吧。',
  error: '采集端出问题了，去「连接」页点「重启采集端」吧。',
  qq_conflict: '电脑版 QQ 还开着呢，去「连接」页点「关闭电脑版 QQ 并继续」。',
  waiting_qr: '等你用手机 QQ 扫码登录（仅首次需要），扫完我马上开工~',
  starting: '正在登录 QQ，稍等几秒~',
};

const FALLBACK =
  '这个我还在学…你可以问我「今天有什么事」「接下来做什么」「最近截止」「看看群」，或让我「同步一下」；也可以右键点我，让我走两步。';

/** 今日安排的一段话 */
function todayText(events: readonly EventDTO[], now: number, summary: string | undefined): string {
  const pending = events.filter((e) => e.status === 'active' || e.status === 'pending_confirm');
  const done = events.filter((e) => e.status === 'done');
  if (pending.length > 0) {
    const parts = pending.slice(0, 3).map((e) => `「${e.title}」${eventTimeText(e, now).text}`);
    return `今天 ${pending.length} 件事：${parts.join('；')}${pending.length > 3 ? ' 等' : ''}`;
  }
  if (done.length > 0) return '今天的事都办完啦，干得漂亮！';
  return summary ?? '今天没有待办，轻松一天~';
}

/** 下一个要开始的事 + 倒计时 */
function nextText(events: readonly EventDTO[], now: number): string {
  const next = events
    .filter((e) => e.status === 'active' && e.start_at !== null && e.start_at > now)
    .sort((a, b) => a.start_at! - b.start_at!)[0];
  if (!next) return '今天没有接下来的安排了，好好休息~';
  const min = Math.round((next.start_at! - now) / 60_000);
  return min <= 1
    ? `「${next.title}」马上就开始了，快准备！`
    : `下一个是「${next.title}」，${hhmm(next.start_at!)} 开始，还有 ${min} 分钟。`;
}

/** 快截止的（今天范围内） */
function deadlineText(events: readonly EventDTO[], now: number): string {
  const ds = events
    .filter((e) => e.status === 'active' && e.deadline_at !== null && e.deadline_at >= now)
    .sort((a, b) => a.deadline_at! - b.deadline_at!);
  if (ds.length === 0) return '今天没有要截止的，后面几天的可以去「本周」页看。';
  const parts = ds.slice(0, 2).map((e) => `「${e.title}」${eventTimeText(e, now).text}`);
  return `最近要交的：${parts.join('；')}${ds.length > 2 ? `（共 ${ds.length} 件）` : ''}`;
}

/**
 * 把用户的一句话映射成回答。
 * 匹配顺序即优先级：导航 → 群 → 动作 → 查询 → 闲聊兜底。
 * 命中任意规则 matched=true；只有最后走到兜底话术才是 false（调用方可以转问 LLM）。
 */
export function petReply(input: string, ctx: ChatCtx): PetAnswer {
  const ans = petReplyRules(input, ctx);
  return { ...ans, matched: ans.text !== FALLBACK };
}

function petReplyRules(input: string, ctx: ChatCtx): Omit<PetAnswer, 'matched'> {
  const q = input.trim().toLowerCase();
  if (q.length === 0) return { text: '想说点什么呀？' };
  const has = (...words: string[]): boolean => words.some((w) => q.includes(w));

  // ① 跳页面（「打开/去 + 目标」）
  if (has('今日', '首页') && has('打开', '跳', '去', '回', '切换')) {
    return { text: '这就带你去今日页~', action: 'nav-today' };
  }
  if (has('本周', '这周', '周视图', '周视图')) {
    return { text: '本周的安排在「本周」页，这就带你去~', action: 'nav-week' };
  }
  if (has('群管理') || (has('群') && has('打开', '去', '管理', '页'))) {
    return { text: '群管理页走起~', action: 'nav-groups' };
  }

  // ② 数据问答
  if (has('哪些群', '群列表', '监听', '看看群', '几个群')) return { text: '我看看群名单…', needGroups: true };
  if (has('同步', '刷新', '收消息')) return { text: '好，我去收一遍群消息，稍等~', action: 'sync' };
  if (has('截止', '作业', '交', 'ddl')) return { text: deadlineText(ctx.events, ctx.now) };
  if (has('接下来', '下一步', '马上', '多久', '快开始', '开始')) return { text: nextText(ctx.events, ctx.now) };
  if (has('今天', '日程', '安排', '待办', '有什么事', '几件事')) return { text: todayText(ctx.events, ctx.now, ctx.summary) };

  // ③ 状态与闲聊
  if (has('连接', '掉线', '离线', '断', '扫码', '登录', '在线')) {
    return { text: ctx.connect ? CONNECT_TEXT[ctx.connect] : CONNECT_TEXT.starting };
  }
  if (has('你是谁', '你叫', '介绍', '是什么')) return { text: INTRO };
  if (has('帮', '能做', '会什么', '怎么用', '功能')) {
    return { text: `我能做的事：\n· 报日程：「今天有什么事」「接下来做什么」\n· 查作业：「最近截止」\n· 操作：「同步一下」「走两步」「打开本周」\n· 闲聊：随便说点什么试试~` };
  }
  if (has('几点', '时间', '日期')) return { text: `现在是 ${hhmm(ctx.now)}。` };
  if (has('谢谢', '辛苦', '感谢')) return { text: '不客气~盯着日程是我的本职工作。' };
  if (has('你好', '嗨', '哈喽', 'hello', 'hi', '在吗')) {
    return { text: `${petGreeting(new Date(ctx.now).getHours())}！${ctx.summary ?? '找我玩呀？'}` };
  }
  if (has('再见', '拜拜', '晚安', 'bye')) return { text: '拜拜~有事随时戳我！' };
  if (has('走两步', '走一走', '散步', '跳舞', '动一动', '转一圈')) return { text: '来喽~', action: 'stroll' };

  return { text: FALLBACK };
}

/** 群列表的一段话（needGroups 拿到数据后调用） */
export function groupListText(groups: readonly GroupDTO[]): string {
  if (groups.length === 0) return '还没有监听任何群，去「群管理」页开启一个吧。';
  const on = groups.filter((g) => g.enabled).length;
  const names = groups.slice(0, 4).map((g) => g.name).join('、');
  return `监听中的群 ${on}/${groups.length} 个：${names}${groups.length > 4 ? ' 等' : ''}。要增删监听去「群管理」页~`;
}
