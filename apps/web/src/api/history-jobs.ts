import type { HistoryJobDTO } from '../../../../shared/history-jobs';
import type { HistoryDays } from '../lib/historySync';

export class HistoryRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const demoJobs = new Map<string, HistoryJobDTO[]>();
function mockRequest(epoch: string, method: string, path: string, body?: unknown): { jobs: HistoryJobDTO[] } | { job: HistoryJobDTO } {
  const jobs = demoJobs.get(epoch) ?? [];
  if (method === 'GET') return { jobs: structuredClone(jobs) };
  if (path === '') {
    const input = body as { platform: 'qq' | 'wechat'; days: HistoryDays };
    const job: HistoryJobDTO = { id: `demo-${input.platform}`, platform: input.platform, days: input.days,
      status: 'completed', created_at: Date.now(), updated_at: Date.now(), groups_total: 0,
      groups_completed: 0, pages: 0, messages: 0, current_group_id: null, error: null, retryable: false, groups: [] };
    demoJobs.set(epoch, [...jobs.filter(item => item.platform !== job.platform), job]);
    return { job: structuredClone(job) };
  }
  const id = decodeURIComponent(path.split('/')[1] ?? '');
  const job = jobs.find(item => item.id === id);
  if (!job) throw new HistoryRequestError('未找到演示任务', 404);
  return { job: structuredClone(job) };
}
// This connection deadline only bounds a short control/status request. It never
// stops the server-owned history job or declares that job failed.
async function request<T>(epoch: string, method: string, path: string, body?: unknown): Promise<T> {
  if (import.meta.env.VITE_MOCK === '1') return mockRequest(epoch, method, path, body) as T;
  let response: Response;
  try {
    response = await fetch(`/api/history-jobs${path}`, {
      method, headers: { 'X-ClassRep-Account-Epoch': epoch, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HistoryRequestError('暂时无法确认后台状态，正在重连；已补入记录保留，请勿重复启动。', 0);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HistoryRequestError(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error : `读取任务状态失败（${response.status}）`, response.status);
  }
  if (!data || typeof data !== 'object') throw new HistoryRequestError('未读到有效任务状态，正在重连后台', 0);
  return data as T;
}
export const getHistoryJobs = (epoch: string) => request<{ jobs: HistoryJobDTO[] }>(epoch, 'GET', '');
export const startHistoryJob = (epoch: string, platform: 'qq' | 'wechat', days: HistoryDays) =>
  request<{ job: HistoryJobDTO }>(epoch, 'POST', '', { expected_account_epoch: epoch, platform, days,
    ...(platform === 'wechat' ? { approve_history_read: true } : {}) });
export const cancelHistoryJob = (epoch: string, id: string) =>
  request<{ job: HistoryJobDTO }>(epoch, 'POST', `/${encodeURIComponent(id)}/cancel`, { expected_account_epoch: epoch });
export const retryHistoryJob = (epoch: string, id: string) =>
  request<{ job: HistoryJobDTO }>(epoch, 'POST', `/${encodeURIComponent(id)}/retry`, { expected_account_epoch: epoch });
