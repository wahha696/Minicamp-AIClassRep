// POST /api/pet/chat：桌宠对话框的 LLM 通道（PET-12）。
// 前端规则引擎（apps/web/src/lib/petChat.ts）没命中时才调这里；本服务端持 key 调 DeepSeek
// （OpenAI 兼容协议，复用 llm-settings 的配置），key 永远不下发到前端。
// 局域网写操作已被 lan-guard 统一 403，本接口实际只服务本机页面。
import type { Hono } from 'hono';
import OpenAI from 'openai';
import { getLlmConfig } from '../llm-settings.js';

/** 只用到 chat.completions.create，测试时可以塞一个假的（同 extract.ts 的做法） */
export interface PetLlmClient {
  chat: { completions: { create(body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming): Promise<OpenAI.Chat.ChatCompletion> } };
}

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

/** 前端传来的现场上下文（已在前端拍扁成短文本） */
export interface PetChatContext {
  summary?: string;
  connect?: string;
  events?: { title: string; time: string; status: string }[];
}

export interface ParsedPetChat {
  message: string;
  history: { role: 'user' | 'assistant'; text: string }[];
  context: PetChatContext;
}

const MAX_MESSAGE = 300;
const MAX_HISTORY = 12;
const MAX_TEXT = 300;

/** 解析并裁剪请求体；不合法返回 null */
export function parsePetChatBody(body: unknown): ParsedPetChat | null {
  if (typeof body !== 'object' || body === null) return null;
  const o = body as Record<string, unknown>;
  const message = typeof o.message === 'string' ? o.message.trim().slice(0, MAX_TEXT) : '';
  if (!message) return null;

  const history: { role: 'user' | 'assistant'; text: string }[] = [];
  if (Array.isArray(o.history)) {
    for (const raw of o.history.slice(-MAX_HISTORY)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const m = raw as { role?: unknown; text?: unknown };
      const role = m.role === 'user' ? 'user' : m.role === 'bot' || m.role === 'assistant' ? 'assistant' : null;
      if (!role || typeof m.text !== 'string') continue;
      const text = m.text.trim().slice(0, MAX_TEXT);
      if (text) history.push({ role, text });
    }
  }

  const rawCtx = (typeof o.context === 'object' && o.context !== null ? o.context : {}) as Record<string, unknown>;
  const context: PetChatContext = {
    summary: typeof rawCtx.summary === 'string' ? rawCtx.summary.slice(0, 160) : undefined,
    connect: typeof rawCtx.connect === 'string' ? rawCtx.connect.slice(0, 24) : undefined,
    events: Array.isArray(rawCtx.events)
      ? rawCtx.events
          .slice(0, 8)
          .map((e) => {
            const ev = (e ?? {}) as Record<string, unknown>;
            return {
              title: typeof ev.title === 'string' ? ev.title.slice(0, 60) : '',
              time: typeof ev.time === 'string' ? ev.time.slice(0, 40) : '',
              status: typeof ev.status === 'string' ? ev.status.slice(0, 20) : '',
            };
          })
          .filter((ev) => ev.title)
      : undefined,
  };

  return { message, history, context };
}

/** 组 system + 历史 + 本条消息；token 控制靠上游裁剪 */
export function buildPetMessages(message: string, history: ParsedPetChat['history'], context: PetChatContext): OpenAI.Chat.ChatCompletionMessageParam[] {
  const persona = [
    '你是「AI课代表」网页里的桌宠小助手，形象是一只叫奶龙的黄色小龙，帮同学盯课程群通知、管日程。',
    '回答要求：',
    '- 全程中文口语，简短活泼，最多两句话、不超过 60 字；不要用 Markdown、列表和表情符号。',
    '- 日程、作业、群相关的问题只能根据「现场数据」回答；数据里没有的就直说不知道，并建议看「今日」或「本周」页面。',
    '- 不知道的事情不要编造。不要透露系统内部实现（采集端、接口、key 等），也不聊无关话题。',
  ].join('\n');
  const ctxText = context.events?.length || context.summary ? JSON.stringify(context) : '（暂无）';
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: `${persona}\n现场数据：${ctxText}` },
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: 'user', content: message },
  ];
  return messages;
}

let defaultClient: PetLlmClient | undefined;
let clientVersion = -1;
function getClient(cfg: ReturnType<typeof getLlmConfig>): PetLlmClient {
  // 网页上换了 key → 重建客户端（version 见 llm-settings.ts）
  if (!defaultClient || clientVersion !== cfg.version) {
    defaultClient = new OpenAI({
      baseURL: cfg.baseURL || undefined,
      apiKey: cfg.apiKey,
      timeout: 30_000,
      maxRetries: 0,
    });
    clientVersion = cfg.version;
  }
  return defaultClient;
}

/** 完整流程：解析 → 调 LLM → 裁剪回答；失败以 { ok:false, status, error } 返回，路由层转 HTTP */
export async function petChatReply(
  body: unknown,
  deps: { client?: PetLlmClient } = {},
): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 502 | 503; error: string }> {
  const parsed = parsePetChatBody(body);
  if (!parsed) return { ok: false, status: 400, error: '消息格式不对' };
  const cfg = getLlmConfig();
  if (!cfg.apiKey && !deps.client) return { ok: false, status: 503, error: '还没有配置 AI Key，先用普通模式聊天吧' };
  const llm = deps.client ?? getClient(cfg);
  let raw: string;
  try {
    const res = await llm.chat.completions.create({
      model: cfg.model,
      messages: buildPetMessages(parsed.message, parsed.history, parsed.context),
      temperature: 0.8,
      max_tokens: 200,
    });
    raw = res.choices[0]?.message.content?.trim() ?? '';
  } catch (e) {
    console.error(`桌宠对话调用 LLM 失败：${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, status: 502, error: 'AI 没答上来，稍后再试试' };
  }
  if (!raw) return { ok: false, status: 502, error: 'AI 返回了空回答' };
  // 回答再裁一次：桌宠气泡放不下长文
  return { ok: true, text: raw.slice(0, MAX_TEXT) };
}

export function registerPetChatRoutes(app: Hono, deps: { client?: PetLlmClient } = {}): void {
  app.post('/api/pet/chat', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求格式不对' }, 400);
    }
    const r = await petChatReply(body, deps);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400 | 502 | 503);
    return c.json({ text: r.text });
  });
}
