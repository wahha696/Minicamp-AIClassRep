import { ApiError, getTimetable, isMock } from './client';
import type { CourseCompletionRequest, CourseCompletionResponse, CourseCompletionsResponse } from '../../../../shared/timetable';

const demo = new Map<string, Map<string, CourseCompletionResponse['completion']>>();
async function request<T>(epoch: string, url: string, method: string, body?: unknown): Promise<T> {
  if (!epoch) throw new Error('正在核对当前空间，请稍后再操作课程。');
  const response = await fetch(url, { method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-ClassRep-Account-Epoch': epoch },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) throw new ApiError(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `课程状态操作失败（${response.status}）`, response.status);
  if (!data) throw new Error('无法读取课程完成状态');
  return data as T;
}
export async function getCourseCompletions(epoch: string, from: string, to: string): Promise<CourseCompletionsResponse> {
  if (isMock) return { revision: (await getTimetable()).revision ?? 0, completions: [...(demo.get(epoch)?.values() ?? [])].filter(item => item.done && item.date >= from && item.date < to).map(item => ({ ...item, done: true })) };
  return request(epoch, `/api/timetable/completions?${new URLSearchParams({ from, to })}`, 'GET');
}
export async function setCourseCompletion(epoch: string, input: CourseCompletionRequest): Promise<CourseCompletionResponse> {
  if (isMock) {
    const items = demo.get(epoch) ?? new Map(); demo.set(epoch, items);
    const completion = { occurrence_id: input.occurrence_id, date: input.date, start: input.expected_start, end: input.expected_end, done: input.done, updated_at: Date.now() };
    items.set(input.occurrence_id, completion); return { revision: input.expected_revision, completion };
  }
  return request(epoch, '/api/timetable/completions', 'PUT', input);
}
