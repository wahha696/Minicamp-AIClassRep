// 桌宠对话的 LLM 通道（PET-15）：对话框里说的每句话都发到这里，
// 由服务端持 key 调 DeepSeek（OpenAI 兼容协议）。key 永远不进前端。
// 失败（没配 key / 超时 / 服务出错）一律抛错，调用方如实提示用户——前端已无规则引擎兜底。
import { accountScopedFetch, isMock } from '../api/client';
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

/** mock/演示模式没有后端，调用方据此给出「演示模式」提示 */
export function llmAvailable(): boolean {
  return !isMock;
}

/** 问一句 DeepSeek（后端代理）。失败抛错，由调用方决定回退话术。style = 用户自定义人设/说话风格（可选） */
export async function askPetLlm(message: string, history: readonly PetLlmMsg[], ctx: PetLlmCtx, style?: string): Promise<string> {
  if (isMock) throw new Error('mock 模式没有 LLM');
  const res = await accountScopedFetch('/api/pet/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      style: style?.trim() ? style.trim().slice(0, 120) : undefined, // 空则服务端用默认奶龙人设
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
