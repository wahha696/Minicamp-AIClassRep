import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./client', async () => ({ isMock: false, getTimetable: vi.fn(), ...await import('./error') }));
import { getCourseCompletions, setCourseCompletion } from './course-completions';
afterEach(() => vi.unstubAllGlobals());
it('读取使用日期范围，写入带冻结空间epoch和具体课次校验字段', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revision: 1, completions: [] }), { status: 200 })); vi.stubGlobal('fetch', fetch);
  await getCourseCompletions('epoch-one', '2026-09-07', '2026-09-14');
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/timetable/completions?from=2026-09-07&to=2026-09-14');
  const input = { occurrence_id: 'synthetic@2026-09-07', date: '2026-09-07', expected_start: 1, expected_end: 2, expected_revision: 1, done: true };
  fetch.mockResolvedValue(new Response(JSON.stringify({ revision: 1, completion: { ...input } }), { status: 200 }));
  await setCourseCompletion('epoch-one', input);
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-ClassRep-Account-Epoch': 'epoch-one' }, body: JSON.stringify(input) });
});
it('空间或版本冲突保留服务端原因，不重试写入', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '课表版本已改变' }), { status: 409 })); vi.stubGlobal('fetch', fetch);
  await expect(setCourseCompletion('A', { occurrence_id: 'a', date: '2026-09-07', expected_start: 1, expected_end: 2, expected_revision: 1, done: false })).rejects.toThrow('课表版本已改变');
  expect(fetch).toHaveBeenCalledOnce();
});
