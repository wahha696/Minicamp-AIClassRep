// 桌宠对话的 LLM 通道（PET-12）：规则引擎没命中时，把消息发给后端 /api/pet/chat，
// 由服务端持 key 调 DeepSeek（OpenAI 兼容协议）。key 永远不进前端。
// 失败（没配 key / 超时 / 服务出错）一律抛错，调用方回退规则兜底话术，用户无感。
import { isMock } from '../api/client';
import { eventTimeText } from './time';
import type { ConnectState, EventDTO } from '../api/types';

/** 发给后端的现场上下文（拍扁成短文本，控制 token） */
export interface PetLlmCtx {
  now: number;
  summary?: string;
  events: readonly EventDTO[];
  connect?: ConnectState;
}

export interface PetLlmMsg {
  role: 'bot' | 'user';
  text: string;
}

/** mock 模式没有后端，直接走规则兜底 */
export function llmAvailable(): boolean {
  return !isMock;
}

/** 问一句 DeepSeek（后端代理）。失败抛错，由调用方决定回退话术 */
export async function askPetLlm(message: string, history: readonly PetLlmMsg[], ctx: PetLlmCtx): Promise<string> {
  if (isMock) throw new Error('mock 模式没有 LLM');
  const res = await fetch('/api/pet/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      // 只带最近 8 条，防止越聊越长；角色名映射到 OpenAI 协议在服务端做
      history: history.slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 300) })),
      context: {
        summary: ctx.summary ?? '',
        connect: ctx.connect ?? '',
        events: ctx.events.slice(0, 8).map((e) => ({
          title: e.title,
          time: eventTimeText(e, ctx.now).text,
          status: e.status,
        })),
      },
    }),
    signal: AbortSignal.timeout(15_000), // 15s 超时，LLM 慢了就回退规则
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `AI 服务没响应（${res.status}）`;
    throw new Error(msg);
  }
  const text = (data as { text?: unknown } | null)?.text;
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('AI 返回了空回答');
  return text.trim();
}
