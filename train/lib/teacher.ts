// DeepSeek 教师模型客户端（操作手册 §2：教师数据制备不占 GPU，走 API）。
// 纯 fetch、零依赖。配置优先级：process.env > 仓库根 .env（经 server 的 env.ts 载入）。
//   LLM_API_KEY   必填（sk-…）
//   LLM_BASE_URL  可选，默认 https://api.deepseek.com/v1
//   TEACHER_MODEL 可选，默认 LLM_MODEL 或 deepseek-chat
// 两个入口：
//   extractOnce() —— 事件提取：与生产 extract.ts 同参（temperature 0 + json_object + max_tokens 4096）
//   generate()    —— 剧本/数据合成：可调温度，自由文本或 JSON
import { env } from '../../apps/server/src/env.js';

export interface TeacherConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export function teacherConfig(): TeacherConfig {
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      '没有教师模型 Key：请在仓库根 .env 里配置 LLM_API_KEY=sk-...（DeepSeek），或设环境变量后重试',
    );
  }
  return {
    baseURL: (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
    apiKey,
    model: process.env.TEACHER_MODEL || env.LLM_MODEL || 'deepseek-chat',
  };
}

export interface ChatResult {
  content: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number } | null;
  ms: number;
}

export class TeacherError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 单次对话补全；429/5xx/网络错误自动退避重试 */
export async function chat(
  body: {
    messages: { role: string; content: string }[];
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object' };
  },
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const cfg = teacherConfig();
  const retries = opts.retries ?? 5;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 限流/抖动：指数退避后重试
        if (RETRYABLE.has(res.status) && attempt < retries) {
          const wait = Math.min(60_000, 2_000 * 2 ** attempt) + Math.random() * 1_000;
          console.warn(`[teacher] HTTP ${res.status}，${Math.round(wait / 1000)}s 后第 ${attempt + 1} 次重试`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        throw new TeacherError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, RETRYABLE.has(res.status));
      }
      const json = (await res.json()) as {
        model?: string;
        usage?: { prompt_tokens: number; completion_tokens: number };
        choices?: { message?: { content?: string } }[];
      };
      return {
        content: json.choices?.[0]?.message?.content?.trim() ?? '',
        model: json.model ?? cfg.model,
        usage: json.usage ?? null,
        ms: Date.now() - t0,
      };
    } catch (e) {
      lastErr = e;
      const retryable = !(e instanceof TeacherError) || e.retryable;
      if (!retryable || attempt >= retries) throw e;
      const wait = Math.min(60_000, 2_000 * 2 ** attempt);
      console.warn(`[teacher] ${(e as Error).message}，${Math.round(wait / 1000)}s 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/** 教师做事件提取：参数与生产 extractOnce 逐项对齐（temperature 0 / json_object / 4096） */
export async function teacherExtract(system: string, user: string): Promise<ChatResult> {
  return chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  });
}

/** 教师做合成/生成（温度可调） */
export async function generate(
  messages: { role: string; content: string }[],
  opts: { temperature?: number; maxTokens?: number; json?: boolean; retries?: number } = {},
): Promise<ChatResult> {
  return chat(
    {
      messages,
      temperature: opts.temperature ?? 1.0,
      max_tokens: opts.maxTokens ?? 8192,
      ...(opts.json ? { response_format: { type: 'json_object' as const } } : {}),
    },
    { retries: opts.retries ?? 5 },
  );
}

/** 从模型输出里抠 JSON（容忍 ```json 包裹 / 前后杂讯） */
export function parseLooseJson(raw: string): unknown | undefined {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    /* fallthrough */
  }
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------- 用量统计（跑批结束打印，费用自查） ----------

export const usage = {
  promptTokens: 0,
  completionTokens: 0,
  calls: 0,
  failures: 0,
  add(r: ChatResult): void {
    this.calls++;
    this.promptTokens += r.usage?.prompt_tokens ?? 0;
    this.completionTokens += r.usage?.completion_tokens ?? 0;
  },
  text(): string {
    return `调用 ${this.calls} 次（失败 ${this.failures}），输入 ${this.promptTokens} tok + 输出 ${this.completionTokens} tok`;
  },
};
