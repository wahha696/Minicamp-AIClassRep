// LLM 提取（FR-4）：把一批候选消息交给 LLM，拿回结构化的事件（新建 / 改期 / 取消）。
// 任何失败都只返回 []、不抛异常——调度器照样把消息置为已处理，避免死循环（FR-5.4）。
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { getLlmConfig } from '../llm-settings.js';
import type { EventType, Message } from '../types.js';
import { llmStats } from './stats.js';

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
}

export interface ExtractInput {
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
    source_message_ids: [...new Set(ev.source_message_ids)].filter((id) => validIds.has(id)),
  }));
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
  });
}

const DAY = 86400_000;

/** 上周到下下周的日历（每周从周一开始），让 LLM 查表而不是自己推算星期 */
function calendar(now: number): string {
  const d = new Date(now + TZ_OFFSET);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monday = today - ((d.getUTCDay() + 6) % 7) * DAY;
  const labels = ['上周', '本周', '下周', '下下周'];
  return labels
    .map((label, w) => {
      const days = Array.from({ length: 7 }, (_, i) => {
        const x = new Date(monday + (w - 1) * 7 * DAY + i * DAY);
        return `${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}(${WEEKDAY[x.getUTCDay()]})`;
      });
      return `${label}：${days.join(' ')}`;
    })
    .join('\n');
}

export function buildSystemPrompt(now: number): string {
  return `你是大学班级群里的「AI 课代表」，负责从群消息里找出需要同学行动或到场的事项。
当前时间：${fmtShanghai(now)}（Asia/Shanghai）。
日历（${new Date(now + TZ_OFFSET).getUTCFullYear()} 年，每周从周一开始，「本周」指当前时间所在的周）：
${calendar(now)}

规则：
1. 只提取需要学生行动或到场的事项：考试/小测、作业与提交截止、开会、活动、需要照做的通知（选课、填表、缴费等）。闲聊、约饭、开黑、拼车、吐槽都不算。没有 @ 任何人的通知视为对全体同学的通知，照常提取；[at] 表示 @全体成员 或 @了我，同样照常提取。
2. 相对时间（今天、明天、后天、今晚、下周三……）以**该消息的发送时间**为基准换算成绝对时间，先在日历里找到发送日期所在的那一行，再查表，不要心算星期：「周五 / 本周五」指发送日期所在那一行的周五，若该时刻在发送时间之前（已经过了）则指下一行的周五；「下周X」指发送日期所在行的下一行的周X——哪怕本周的周X还没到，「下周X」也不是本周的周X（周一发的「下周三」是 9 天后，不是 2 天后；周日发的「下周三」是 3 天后）。
3. 所有时间输出为 "YYYY-MM-DDTHH:mm+08:00" 字符串。考试/会议/活动填 start_at（知道结束时间再填 end_at）；作业/截止类填 deadline_at。只说了日期没说具体时间的截止，按当天 23:59。
4. 不确定的字段给 null，不要编造。
5. 下面会给出本群已有的事件（带 id）。如果某条消息是对已有事件的改期、换地点、补充要求，输出 action="update"、update_of=该事件 id，并**只填变化后的字段**，没变的字段给 null（填了的字段会整个覆盖旧值：补充要求时 action_required 要写「已有事件的 action_required + 新要求」合并后的完整要求，旧要求一条都不能丢；description 除非事项内容本身变了，否则给 null）；如果是取消，输出 action="cancel"、update_of=该事件 id。名字相近但不是同一件事的（比如「高数期中」和「线代期中」）不要混为一谈。已有事件的单纯重复提醒不要输出。
6. 同一批消息里既有原通知又有改动的，只输出一个按改动后信息填写的 create。
7. confidence 是你对「这确实是一个需要行动的事项、且信息理解正确」的把握，0~1。
8. source_message_ids 填提供该事项信息的消息 id（方括号里的内容，原样照抄）。
9. 没有任何事项时输出 {"events": []}。

只输出 JSON，格式：
{"events": [{"action": "create", "update_of": null, "type": "exam|assignment|meeting|activity|announcement|other", "title": "简短标题，如：高数第三章小测", "description": "一两句话说明", "start_at": "2026-09-18T14:00+08:00", "end_at": null, "deadline_at": null, "location": "A301", "action_required": "带计算器和学生证", "confidence": 0.9, "source_message_ids": ["消息id"]}]}`;
}

export function buildUserPrompt(input: ExtractInput): string {
  const parts = [`群名：${input.groupName}`];
  parts.push(
    '本群已有事件：\n' + (input.activeEvents.length ? input.activeEvents.map(fmtEvent).join('\n') : '（无）'),
  );
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

export async function extractEvents(
  input: ExtractInput,
  client: LlmClient | undefined = undefined,
): Promise<ExtractedEvent[]> {
  if (input.candidates.length === 0) return [];
  if (!client && !getLlmConfig().apiKey) {
    llmStats.llm = 'unconfigured';
    return [];
  }
  const llm = client ?? getClient();
  const validIds = new Set(input.candidates.map((m) => m.message_id));
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(input.now) },
    { role: 'user', content: buildUserPrompt(input) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      llmStats.called++;
      const res = await llm.chat.completions.create({
        model: getLlmConfig().model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 4096,
      });
      raw = res.choices[0]?.message.content?.trim() ?? '';
    } catch (e) {
      llmStats.llm = 'error';
      llmStats.failed++;
      console.warn('[extract] LLM 调用失败：', (e as Error).message);
      return [];
    }
    llmStats.llm = 'ok';

    const r = raw ? parseExtraction(raw, validIds) : ({ ok: false, error: '输出为空' } as const);
    if (r.ok) return r.events;

    console.warn(`[extract] 第 ${attempt + 1} 次输出不合法：${r.error}`);
    messages.push(
      { role: 'assistant', content: raw || '（空）' },
      { role: 'user', content: `上面的输出不合法：${r.error}\n请严格按要求的 JSON 格式重新输出。` },
    );
  }
  return [];
}
