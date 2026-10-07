// LLM 提取（FR-4）：把一批候选消息交给 LLM，拿回结构化的事件（新建 / 改期 / 取消）。
// 任何失败都只返回 []、不抛异常——调度器照样把消息置为已处理，避免死循环（FR-5.4）。
// 例外是「AI 连不上」：通过 status.llmFailed 告诉调用方，这批留着稍后重试。
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { getLlmConfig } from '../ai-settings.js';
import { groupCourseName, occurrences } from '../timetable.js';
import type { EventType, Level, Message } from '../types.js';
import { memoryEnabled, preferenceRules } from './preferences.js';
import { llmStats } from './stats.js';
import { env } from '../env.js';
import {
  localExtractReady,
  requestLocalExtract,
} from './extract-local.js';

export interface ExtractedEvent {
  action: 'create' | 'update' | 'cancel';
  update_of: number | null;
  type: EventType;
  title: string; // update / cancel 时可能是 ''，表示不改
  description: string;
  start_at: number | null;
  end_at: number | null;
  deadline_at: number | null;
  location: string | null;
  action_required: string | null;
  confidence: number;
  level: Level | null; // null = 不变（update 时）/ 用默认（create 时）
  source_message_ids: string[];
}

/** 给 LLM 看的已有事件（该群近 14 天 active），用来判断改期 / 取消 */
export interface ActiveEventBrief {
  id: number;
  type: EventType;
  title: string;
  start_at: number | null;
  end_at: number | null;
  deadline_at: number | null;
  location: string | null;
  action_required: string | null; // 补充要求时 LLM 要在旧要求上合并，所以得让它看到
  level: number;
}

export interface ExtractInput {
  groupId: string;
  groupName: string;
  candidates: Message[];
  context: Message[];
  now: number;
  activeEvents: ActiveEventBrief[];
}

// ---------- 时间：只有 prompt 里才转成 Asia/Shanghai 文本 ----------

const TZ_OFFSET = 8 * 3600_000; // 中国无夏令时，固定 +8
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 毫秒 → `2026-09-18 14:00 星期五` */
export function fmtShanghai(ms: number): string {
  const d = new Date(ms + TZ_OFFSET);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} 星期${WEEKDAY[d.getUTCDay()]}`
  );
}

const TIME_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** LLM 给的时间串 → 毫秒。缺时区按 +08:00；只有日期按当天 23:59。不认识返回 NaN。 */
export function parseTime(s: string): number {
  const m = TIME_RE.exec(s.trim());
  if (!m) return NaN;
  const [, date, hm = '23:59', zone = '+08:00'] = m;
  return Date.parse(`${date}T${hm}:00${zone}`);
}

// ---------- 输出 schema ----------

const timeField = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v == null || v.trim() === '') return null;
    const ms = parseTime(v);
    if (Number.isNaN(ms)) {
      ctx.addIssue({ code: 'custom', message: `时间格式应为 YYYY-MM-DDTHH:mm+08:00，收到 "${v}"` });
      return z.NEVER;
    }
    return ms;
  });

const textField = z
  .string()
  .nullish()
  .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));

const EventSchema = z.object({
  action: z.enum(['create', 'update', 'cancel']),
  update_of: z.preprocess(
    (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v),
    z.number().int().nullish().transform((v) => v ?? null),
  ),
  // 编出来的类型（如 survey）归到 other，不值得为此重试一次
  type: z.enum(['exam', 'assignment', 'meeting', 'activity', 'announcement', 'other']).catch('other'),
  // update / cancel 只填变化的字段，标题可以不给；这时是 ''，reconcile 按「不改」处理
  title: z.string().nullish().transform((v) => v?.trim() ?? ''),
  description: z.string().nullish().transform((v) => v?.trim() ?? ''),
  start_at: timeField,
  end_at: timeField,
  deadline_at: timeField,
  location: textField,
  action_required: textField,
  confidence: z.number().transform((v) => Math.min(1, Math.max(0, v))),
  // 危机等级 1~4；缺省、越界、乱写的都当 null（update 不改 / create 用默认）
  level: z.number().int().min(1).max(4).nullable().catch(null),
  source_message_ids: z.array(z.union([z.string(), z.number()]).transform(String)),
}).refine((ev) => ev.action !== 'create' || ev.title !== '', {
  message: 'action=create 时 title 不能为空',
  path: ['title'],
});

const OutputSchema = z.object({ events: z.array(EventSchema) });

/** 解析 LLM 的原始输出。成功给事件列表（已丢弃不在输入里的消息 id），失败给错误说明（用于重试）。 */
export function parseExtraction(
  raw: string,
  validIds: ReadonlySet<string>,
): { ok: true; events: ExtractedEvent[] } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${(e as Error).message}` };
  }
  const r = OutputSchema.safeParse(json);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error) };
  const events = r.data.events.map((ev) => ({
    ...ev,
    level: ev.level as Level | null,
    source_message_ids: [...new Set(ev.source_message_ids)].filter((id) => validIds.has(id)),
  }));
  if (events.some((event) => event.source_message_ids.length === 0)) {
    return { ok: false, error: '每个事件必须至少引用一条本批次的有效 source_message_ids' };
  }
  return { ok: true, events };
}

// ---------- prompt ----------

function fmtMsg(m: Message): string {
  return `[${m.message_id}] ${fmtShanghai(m.sent_at)} ${m.sender_name}：${m.text}`;
}

function fmtEvent(e: ActiveEventBrief): string {
  const t = (ms: number | null) => (ms == null ? null : fmtShanghai(ms));
  return JSON.stringify({
    id: e.id,
    type: e.type,
    title: e.title,
    start_at: t(e.start_at),
    end_at: t(e.end_at),
    deadline_at: t(e.deadline_at),
    location: e.location,
    action_required: e.action_required,
    level: e.level,
  });
}

const DAY = 86400_000;

/**
 * 日历（每周从周一开始），让 LLM 查表而不是自己推算星期。
 * 默认上周到下下周；本批有更早的消息（历史补齐）时，从最早那条消息的上一周开始列，最多 8 周。
 */
function calendar(now: number, earliest = now): string {
  const mondayUtc = (ts: number) => {
    const d = new Date(ts + TZ_OFFSET);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return day - ((d.getUTCDay() + 6) % 7) * DAY;
  };
  const thisMonday = mondayUtc(now);
  const start = Math.max(Math.min(mondayUtc(earliest), thisMonday) - 7 * DAY, thisMonday - 5 * 7 * DAY);
  const weeks = Math.round((thisMonday - start) / (7 * DAY)) + 3; // 到下下周为止
  const label = (w: number) => {
    const off = Math.round((start + w * 7 * DAY - thisMonday) / (7 * DAY));
    if (off === -1) return '上周';
    if (off === 0) return '本周';
    if (off === 1) return '下周';
    if (off === 2) return '下下周';
    return `${-off} 周前`;
  };
  return Array.from({ length: weeks }, (_, w) => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const x = new Date(start + w * 7 * DAY + i * DAY);
      return `${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}(${WEEKDAY[x.getUTCDay()]})`;
    });
    return `${label(w)}：${days.join(' ')}`;
  }).join('\n');
}

export function buildSystemPrompt(now: number, earliest = now): string {
  return `你是大学班级群里的「AI 课代表」，负责从群消息里找出需要同学行动或到场的事项。
当前时间：${fmtShanghai(now)}（Asia/Shanghai）。
日历（${new Date(now + TZ_OFFSET).getUTCFullYear()} 年，每周从周一开始，「本周」指当前时间所在的周）：
${calendar(now, earliest)}

规则：
1. 只提取需要学生行动或到场的事项：考试/小测、作业与提交截止、开会、活动、需要照做的通知（选课、填表、缴费等）。**只要说定了具体时间（或日期）要去做的事，不管内容是什么都算**，包括聚餐、吃饭、出游、打球、开黑等约定（type 用 activity），比如「周二早上 6:00 去餐馆吃饭」「周六晚 7 点北门聚餐」。不算的只有：没有定下时间的随口提议或询问（「晚上约饭吗」「有人开黑吗」「有人拼外卖吗」）、闲聊、吐槽、二手买卖、失物招领。没有 @ 任何人的通知视为对全体同学的通知，照常提取；[at] 表示 @全体成员 或 @了我，同样照常提取。
2. 相对时间（今天、明天、后天、今晚、下周三……）以**该消息的发送时间**为基准换算成绝对时间，先在日历里找到发送日期所在的那一行，再查表，不要心算星期：「周五 / 本周五」指发送日期所在那一行的周五，若该时刻在发送时间之前（已经过了）则指下一行的周五；「下周X」指发送日期所在行的下一行的周X——哪怕本周的周X还没到，「下周X」也不是本周的周X（周一发的「下周三」是 9 天后，不是 2 天后；周日发的「下周三」是 3 天后）。
3. 所有时间输出为 "YYYY-MM-DDTHH:mm+08:00" 字符串。考试/会议/活动填 start_at（知道结束时间再填 end_at）；作业/截止类填 deadline_at。只说了日期没说具体时间的截止，按当天 23:59。
4. 不确定的字段给 null，不要编造。
5. 下面会给出本群已有的事件（带 id）。如果某条消息是对已有事件的改期、换地点、补充要求，输出 action="update"、update_of=该事件 id，并**只填变化后的字段**，没变的字段给 null（填了的字段会整个覆盖旧值：补充要求时 action_required 要写「已有事件的 action_required + 新要求」合并后的完整要求，旧要求一条都不能丢；description 除非事项内容本身变了，否则给 null）；如果是取消，输出 action="cancel"、update_of=该事件 id。名字相近但不是同一件事的（比如「高数期中」和「线代期中」）不要混为一谈。已有事件的单纯重复提醒不要输出。
6. 同一批消息里既有原通知又有改动的，只输出一个按改动后信息填写的 create。
7. confidence 是你对「这确实是一个需要行动的事项、且信息理解正确」的把握，0~1。
8. level 是这件事的危机等级，1~4：
   4 紧急：24 小时内要交/要考/要到场，或错过会直接影响成绩；
   3 高：考试、计分作业、必须参加的点名活动，时间在一周内；
   2 中：一般作业、会议、需要行动但不急的事；
   1 低：纯通知、选修/社团活动、可去可不去的事。
   update 时等级没变给 null。
9. source_message_ids 填提供该事项信息的消息 id（方括号里的内容，原样照抄）。
10. 没有任何事项时输出 {"events": []}。

只输出 JSON，格式：
{"events": [{"action": "create", "update_of": null, "type": "exam|assignment|meeting|activity|announcement|other", "title": "简短标题，如：高数第三章小测", "description": "一两句话说明", "start_at": "2026-09-18T14:00+08:00", "end_at": null, "deadline_at": null, "location": "A301", "action_required": "带计算器和学生证", "confidence": 0.9, "level": 3, "source_message_ids": ["消息id"]}]}`;
}

// ---------- 提示词附加段：长期记忆偏好 + 课表 ----------

const LEVEL_TEXT: Record<number, string> = { 1: '低', 2: '中', 3: '高', 4: '紧急' };

/** 记忆开关开且有规则时，提示词末尾追加用户偏好段。db 未开/读失败按无偏好处理。 */
function preferenceSection(): string {
  try {
    if (!memoryEnabled()) return '';
    const rules = preferenceRules();
    if (rules.length === 0) return '';
    const lines = rules.map((r) => `- ${r.text} → ${r.level} ${LEVEL_TEXT[r.level]}`).join('\n');
    return `用户对危机等级的偏好（优先于上面的一般标准）：\n${lines}`;
  } catch {
    return '';
  }
}

const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];
const WEEK_MS = 7 * DAY;

/** 「9/29 周二 10:00-11:40 概率论与数理统计A B座312」 */
function fmtCourse(start: number, end: number, name: string, location: string): string {
  const s = new Date(start + TZ_OFFSET);
  const e = new Date(end + TZ_OFFSET);
  const hm = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${s.getUTCMonth() + 1}/${s.getUTCDate()} 周${WEEKDAY_SHORT[s.getUTCDay()]} ${hm(s)}-${hm(e)} ${name}${location ? ' ' + location : ''}`;
}

/**
 * 课表段：本批最早一条消息所在周的周一 → 最晚一条消息所在周的下一周周日（适配历史补齐的旧消息，
 * 每条消息的「下节课」都查得到）。本批跨度超过 3 周时只列该群对应课程（绑定了 course_name 的话），
 * 避免提示词过长。未导入课表时返回 ''。
 */
function timetableSection(input: ExtractInput): string {
  try {
    const times = input.candidates.map((m) => m.sent_at);
    const first = times.length ? Math.min(...times) : input.now;
    const last = times.length ? Math.max(...times) : first;
    const monday = mondayOfTs(first);
    let occ = occurrences(monday, mondayOfTs(last) + 2 * WEEK_MS);
    const courseName = groupCourseName(input.groupId);
    if (last - first > 3 * WEEK_MS && courseName) {
      occ = occ.filter((o) => o.course.name === courseName);
    }
    if (occ.length === 0) return '';
    const lines = occ.map((o) => fmtCourse(o.start, o.end, o.course.name, o.course.location));
    const mapping = courseName
      ? `本群对应课程：${courseName}（用户指定）`
      : `本群对应哪门课请根据群名「${input.groupName}」判断，判断不出就当作不对应任何一门。`;
    return `本群课表（供参考，不用提取上课本身）：\n${lines.join('\n')}\n${mapping}\n消息里的「下节课 / 这节课 / 下次课 / 课上」按该消息发送时间之后本群对应课程的第一次课解析；地点没说时默认用该课教室。`;
  } catch {
    return '';
  }
}

/** 上海时区 ts 所在周的周一 0 点（毫秒） */
function mondayOfTs(ts: number): number {
  const dayStart = Math.floor((ts + TZ_OFFSET) / DAY) * DAY - TZ_OFFSET;
  const wd = new Date(dayStart + TZ_OFFSET).getUTCDay(); // 0 日 … 6 六
  return dayStart - ((wd + 6) % 7) * DAY;
}

export function buildUserPrompt(input: ExtractInput): string {
  const parts = [`群名：${input.groupName}`];
  parts.push(
    '本群已有事件：\n' + (input.activeEvents.length ? input.activeEvents.map(fmtEvent).join('\n') : '（无）'),
  );
  const timetable = timetableSection(input);
  if (timetable) parts.push(timetable);
  const earliest = input.candidates[0]?.sent_at ?? input.now;
  if (input.now - earliest > 3600_000) {
    parts.push(
      '注意：下面有些新消息是补拉回来的历史消息，发送时间明显早于当前时间。相对时间一律按各自的发送时间换算；' +
        '已有事件可能是根据更晚的消息建立的——旧消息和已有事件说的是同一件事时不要输出，说的是别的事（哪怕标题相近、日期不同）照常 create。',
    );
  }
  if (input.context.length) {
    parts.push('之前的消息（仅供理解上下文，不要从这里提取事项）：\n' + input.context.map(fmtMsg).join('\n'));
  }
  parts.push('需要处理的新消息：\n' + input.candidates.map(fmtMsg).join('\n'));
  return parts.join('\n\n');
}

// ---------- 调用 ----------

/** 只用到 chat.completions.create，测试时可以塞一个假的 */
export interface LlmClient {
  chat: { completions: { create(body: OpenAI.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.ChatCompletion> } };
}

let defaultClient: LlmClient | undefined;
let clientVersion = -1;
function getClient(): LlmClient {
  const cfg = getLlmConfig();
  // 网页上换了 key → 重建客户端
  if (!defaultClient || clientVersion !== cfg.version) {
    defaultClient = new OpenAI({
      baseURL: cfg.baseURL || undefined,
      apiKey: cfg.apiKey,
      timeout: 60_000,
      maxRetries: 2, // 网络抖一下（连不上 / 超时）自动再试，SDK 自带退避
    });
    clientVersion = cfg.version;
  }
  return defaultClient;
}

/** 单次调用的结果标记。按调用传，不看全局计数——多个群并发时别的群失败不会连累这一批。 */
export interface ExtractStatus {
  llmFailed: boolean; // AI 没调通（网络 / 鉴权等），不是输出格式问题
}

export async function extractEvents(
  input: ExtractInput,
  client: LlmClient | undefined = undefined,
  status: ExtractStatus = { llmFailed: false },
): Promise<ExtractedEvent[]> {
  if (input.candidates.length === 0) return [];
  const useLocal = env.EXTRACT_MODE === 'local';
  if (!useLocal && !client && !getLlmConfig().apiKey) {
    llmStats.llm = 'unconfigured';
    return [];
  }
  // local 模式不强制 LLM key；worker 不可用时标记失败留给调度重试
  const llm = useLocal ? (client as LlmClient | undefined) : (client ?? getClient());
  const r = await extractOnce(input, llm, status);
  if (r !== 'truncated') return r;
  // 输出被 max_tokens 截断（一批事项太多，历史补齐时常见）：对半拆开各跑一次，而不是整批丢掉
  if (input.candidates.length <= 1) return [];
  const mid = Math.ceil(input.candidates.length / 2);
  const head = input.candidates.slice(0, mid);
  const tail = input.candidates.slice(mid);
  console.warn(`[extract] 输出被截断，拆成 ${head.length} + ${tail.length} 条重试`);
  const a = await extractEvents({ ...input, candidates: head }, llm, status);
  if (status.llmFailed) return []; // 前半就连不上了，整批留着重试
  const b = await extractEvents(
    { ...input, candidates: tail, context: [...input.context, ...head].slice(-Math.max(input.context.length, 10)) },
    llm,
    status,
  );
  if (status.llmFailed) return []; // 前半的结果也不要：整批重试时会再提取一次，避免重复
  return [...a, ...b];
}

/** 调一次（格式不合法时带着错误再试一次）。输出被截断时返回 'truncated'。 */
async function extractOnce(
  input: ExtractInput,
  llm: LlmClient | undefined,
  status: ExtractStatus,
): Promise<ExtractedEvent[] | 'truncated'> {
  // 本地 v4-DFG：prompt/postprocess 在 Python；这里只做协议 + parseExtraction
  if (env.EXTRACT_MODE === 'local') {
    return extractOnceLocal(input, status);
  }
  if (!llm) {
    status.llmFailed = true;
    llmStats.llm = 'unconfigured';
    return [];
  }
  const validIds = new Set(input.candidates.map((m) => m.message_id));
  const prefs = preferenceSection();
  const earliest = input.candidates[0]?.sent_at ?? input.now;
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(input.now, earliest) + (prefs ? `\n\n${prefs}` : '') },
    { role: 'user', content: buildUserPrompt(input) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    let truncated = false;
    try {
      llmStats.called++;
      const t0 = Date.now();
      const res = await llm.chat.completions.create({
        model: getLlmConfig().model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 4096,
      });
      raw = res.choices[0]?.message.content?.trim() ?? '';
      truncated = res.choices[0]?.finish_reason === 'length';
      llmStats.lastMs = Date.now() - t0;
    } catch (e) {
      llmStats.llm = 'error';
      llmStats.failed++;
      status.llmFailed = true;
      console.warn('[extract] LLM 调用失败：', (e as Error).message);
      return [];
    }
    llmStats.llm = 'ok';

    const r = raw ? parseExtraction(raw, validIds) : ({ ok: false, error: '输出为空' } as const);
    if (r.ok) return r.events;
    if (truncated) return 'truncated';

    console.warn(`[extract] 第 ${attempt + 1} 次输出不合法：${r.error}`);
    messages.push(
      { role: 'assistant', content: raw || '（空）' },
      { role: 'user', content: `上面的输出不合法：${r.error}\n请严格按要求的 JSON 格式重新输出。` },
    );
  }
  return [];
}

/** EXTRACT_MODE=local：走常驻 infer_serve，不使用本文件的 TypeScript prompt。 */
async function extractOnceLocal(
  input: ExtractInput,
  status: ExtractStatus,
): Promise<ExtractedEvent[] | 'truncated'> {
  const validIds = new Set(input.candidates.map((m) => m.message_id));
  if (!localExtractReady()) {
    status.llmFailed = true;
    llmStats.llm = 'error';
    llmStats.failed++;
    console.warn('[extract-local] 未就绪（缺 EXTRACTOR_ROOT/adapter 或退避中）');
    return [];
  }
  llmStats.called++;
  const t0 = Date.now();
  const result = await requestLocalExtract(input);
  llmStats.lastMs = Date.now() - t0;
  if (!result.json) {
    status.llmFailed = true;
    llmStats.llm = 'error';
    llmStats.failed++;
    console.warn(`[extract-local] 调用失败：${result.error || 'null_json'}`);
    return [];
  }
  if (result.truncated) {
    llmStats.llm = 'ok';
    return 'truncated';
  }
  const r = parseExtraction(result.json, validIds);
  if (r.ok) {
    llmStats.llm = 'ok';
    return r.events;
  }
  console.warn(`[extract-local] 输出不合法：${r.error}`);
  llmStats.llm = 'ok';
  return [];
}
