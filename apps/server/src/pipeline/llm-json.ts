// 自定义 OpenAI 兼容服务不一定支持 response_format=json_object（常见返回 400）。
// 先按 JSON 模式请求，遇到 400 再去掉该参数重试一次；提示词本身已要求只输出 JSON。
import type OpenAI from 'openai';

type Create = (body: OpenAI.ChatCompletionCreateParamsNonStreaming) => Promise<OpenAI.ChatCompletion>;

export async function createJsonCompletion(
  client: { chat: { completions: { create: Create } } },
  body: Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'response_format'>,
): Promise<OpenAI.ChatCompletion> {
  try {
    return await client.chat.completions.create({ ...body, response_format: { type: 'json_object' } });
  } catch (e) {
    const status = e && typeof e === 'object' && 'status' in e ? e.status : undefined;
    if (status !== 400) throw e;
    return client.chat.completions.create(body);
  }
}

/** 去掉 ```json 代码块等包裹，只保留最外层 {...} */
export function jsonBody(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}
