import { ApiError, isMock } from './client';

/** The caller pins the visible space epoch: never silently replay an old plan in a new space. */
export async function assistantRequest<T>(epoch: string, path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  if (isMock) throw new Error('演示模式未连接 AI；请启动后端并在设置中配置用户自己的模型。');
  if (!epoch) throw new Error('正在确认当前空间，请稍后再试。');
  if (!path.startsWith('/api/assistant/')) throw new Error('助手接口路径无效');
  const response = await fetch(path, {
    method, credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', 'X-ClassRep-Account-Epoch': epoch },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) throw new ApiError(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `助手请求失败（${response.status}）`, response.status);
  if (data === null) throw new Error('助手返回了无效响应');
  return data as T;
}
