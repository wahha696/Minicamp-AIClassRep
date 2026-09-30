// 口语时间 → 时间戳 归一化（把"下周三""本周五 23:59 前"这类表达落到具体时间）。
//
// 定位：**模型负责识别"有这么一件事"，代码负责换算时间**。prompt 里已经给了日历表让 LLM 查表，
// 但 1.7B 小模型在相对日期上系统性出错（本机考卷：教师 6/6，学生 0/6，失败项里时间类占 31~62%），
// 而这类换算是纯日历算术，交给代码既准确又可测。
//
// 口径与 extract.ts 的 calendar() 严格一致：Asia/Shanghai（无夏令时）、每周从周一开始。
// 不触碰 prompt，因此不会让 PROMPT_VERSION 变更、既有训练数据不作废。
//
// 用法（由调用方决定策略）：
//   const { events, filled, corrected } = completeTimes(events, messages, Date.now(), 'prefer');
// 两种策略：
//   'fill'   —— 只补 null，绝不覆盖模型给出的非空值（保守，适合先上线观察）
//   'prefer' —— 来源消息能解析出**强信号**就以代码为准（模型给错的日期也会被纠正）
// 两种策略都只接受 strong 结果：实测闲聊里的弱信号（「一点没看」「四点左右」）会被解析成时间，
// 放开会把 chatter 写成事件时间（见 train/BATCH-SHAPE.md 的误报审计：弱信号占 13%）。

const HOUR = 3600_000;
const DAY = 86400_000;
const WEEKDAY: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

/** 上海时区下某时间戳所在周的周一 00:00（真实 epoch） */
function weekStart(now: number): number {
  const sh = new Date(now + 8 * HOUR);
  const dow = (sh.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  return Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate()) - dow * DAY - 8 * HOUR;
}

/** 某天的上海 HH:MM 对应的时间戳（真实 epoch） */
function atShanghai(dayTs: number, hour: number, minute: number): number {
  const sh = new Date(dayTs + 8 * HOUR);
  return Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate(), hour, minute) - 8 * HOUR;
}

export interface Resolved {
  /** 解析出的时间戳 */
  at: number;
  /** 文本里有明确时刻 */
  hasTime: boolean;
  /** 文本带「之前/前/截止」这类截止语义 */
  isDeadline: boolean;
  /** 含"日期级"信号（周X / X月Y号 / 明天后天今晚明晚 / 截止语）；只有时刻或泛指的「今天」不算 */
  strong: boolean;
}

/**
 * 从一条消息文本里解析相对日期/时间；解析不出返回 null。
 * @param defaultKind 只有日期没有时刻时的兜底语义：deadline→当天 23:59；start→当天 00:00
 *                    （调用方知道事件类型：作业/问卷=deadline，考试/会议=start）
 */
export function resolveWhen(text: string, now: number, defaultKind: 'deadline' | 'start' = 'start'): Resolved | null {
  const t = text.replace(/\s+/g, '');
  let dayTs: number | null = null;
  let hasTime = false;
  let pmContext = false;
  let hour = 0;
  let minute = 0;
  let strong = false;

  // 1) 相对日
  const rel = /(大后天|后天|明天|今天|明晚|今晚)/.exec(t);
  if (rel) {
    const offset = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 后天: 2, 大后天: 3 }[rel[1]!]!;
    const sh = new Date(now + 8 * HOUR);
    dayTs = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() + offset) - 8 * HOUR;
    if (rel[1] === '今晚' || rel[1] === '明晚') pmContext = true;
    if (rel[1] !== '今天') strong = true; // 「今天」单独出现太泛，只有带时刻才算强信号
  }

  // 2) 周X / 本周X / 下周X
  if (dayTs === null) {
    const wk = /(下{1,2}周|下{1,2}星期|本?周|这周|星期)([一二三四五六日天])/.exec(t);
    if (wk) {
      const weekOffset = /^下{1,2}/.test(wk[1]!) ? (wk[1]!.startsWith('下下') ? 2 : 1) : 0;
      dayTs = weekStart(now) + (weekOffset * 7 + WEEKDAY[wk[2]!]!) * DAY;
      strong = true;
    }
  }

  // 3) 绝对日期 X月Y号
  if (dayTs === null) {
    const md = /(\d{1,2})月(\d{1,2})[号日]/.exec(t);
    if (md) {
      const sh = new Date(now + 8 * HOUR);
      let year = sh.getUTCFullYear();
      if (Date.UTC(year, Number(md[1]) - 1, Number(md[2])) - 8 * HOUR < now - 30 * DAY) year += 1;
      dayTs = Date.UTC(year, Number(md[1]) - 1, Number(md[2])) - 8 * HOUR;
      strong = true;
    }
  }

  // 4) 时刻
  const hm = /(\d{1,2})[：:](\d{2})/.exec(t);
  if (hm) {
    hour = Number(hm[1]);
    minute = Number(hm[2]);
    hasTime = true;
  } else {
    const cn = /(上午|下午|晚上|中午|早上)?(\d{1,2}|[一二三四五六七八九十两]{1,3})点(半)?/.exec(t);
    if (cn) {
      const cnNum: Record<string, number> = {
        一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12,
      };
      let h = cnNum[cn[2]!] ?? Number(cn[2]);
      const part = cn[1] ?? '';
      if (part === '下午' || part === '晚上') h = h < 12 ? h + 12 : h;
      if (part === '中午' && h < 12) h += 12;
      if (!part && pmContext && h < 12) h += 12; // 「今晚 8 点」→ 20:00
      hour = h;
      minute = cn[3] ? 30 : 0;
      hasTime = true;
    }
  }

  if (dayTs === null && !hasTime) return null;
  const base = dayTs ?? atShanghai(now, 0, 0);
  const deadlineWord = /(之前|以前|前|截止|deadline)/.test(t);
  if (deadlineWord && dayTs !== null) strong = true;
  const isDeadline = deadlineWord || (!hasTime && defaultKind === 'deadline');
  let fh = isDeadline ? 23 : 0;
  let fm = isDeadline ? 59 : 0;
  if (!hasTime && !isDeadline && pmContext) {
    fh = 19; // 「今晚」没写时刻 → 当晚 19:00（而不是当天 00:00）
    fm = 0;
  }
  const at = hasTime ? atShanghai(base, hour, minute) : atShanghai(base, fh, fm);
  return { at, hasTime, isDeadline, strong };
}

/** 与 extract.ts 的 ExtractedEvent 对齐的最小字段集 */
export interface EventLike {
  type: string;
  start_at?: number | null;
  deadline_at?: number | null;
  source_message_ids?: string[];
}

export interface MessageLike {
  message_id: string;
  text: string;
}

/** 作业/问卷/通知类用 deadline 语义；考试/会议/活动用 start 语义 */
const DEADLINE_TYPES = new Set(['assignment', 'announcement', 'other']);

/**
 * 用来源消息补全/校正事件的时间字段（结果为新对象数组，不改原数组）。
 * 只接受 strong 解析——弱信号宁可留 null，也不把闲聊写成事件时间。
 */
export function completeTimes<T extends EventLike>(
  events: T[],
  messages: MessageLike[],
  now: number,
  mode: 'fill' | 'prefer' = 'fill',
): { events: T[]; filled: number; corrected: number } {
  const byId = new Map(messages.map((m) => [m.message_id, m]));
  let filled = 0;
  let corrected = 0;
  const out = events.map((ev) => {
    const e = { ...ev } as T;
    const kind: 'deadline' | 'start' = DEADLINE_TYPES.has(e.type) ? 'deadline' : 'start';
    const field = kind === 'deadline' ? 'deadline_at' : 'start_at';
    const current = e[field];
    if (current != null && mode === 'fill') return e;
    for (const id of e.source_message_ids ?? []) {
      const m = byId.get(id);
      if (!m) continue;
      const r = resolveWhen(m.text, now, kind);
      if (!r || !r.strong) continue;
      if (current == null) filled++;
      else if (r.at !== current) corrected++;
      e[field] = r.at;
      break;
    }
    return e;
  });
  return { events: out, filled, corrected };
}
