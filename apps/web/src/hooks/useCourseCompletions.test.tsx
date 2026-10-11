// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dateStamp, expandTimetable } from '../../../../shared/timetable';
const api = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../api/course-completions', () => ({ getCourseCompletions: api.get, setCourseCompletion: api.set }));
import { useCourseCompletions } from './useCourseCompletions';
const first = dateStamp('2026-09-07');
const occurrences = expandTimetable({ semester_start: '2026-09-07', courses: [{ id: 'physics', name: '合成物理', teacher: '', location: '', weekday: 1, block: 1, weeks: [1, 2] }] }, first, first + 14 * 86_400_000);
const o = occurrences[0]!;
const complete = { occurrence_id: o.id, date: o.date, start: o.start, end: o.end, done: true, updated_at: 1 };
beforeEach(() => { api.get.mockReset().mockResolvedValue({ revision: 4, completions: [] }); api.set.mockReset().mockImplementation(async (_epoch, input) => { const completion = { ...complete, done: input.done }; api.get.mockResolvedValue({ revision: 4, completions: input.done ? [completion] : [] }); return { revision: 4, completion }; }); });
afterEach(cleanup);
const hook = () => renderHook(({ epoch, readonly = false }) => useCourseCompletions(epoch, '2026-09-07', '2026-09-21', 4, readonly), { initialProps: { epoch: 'A', readonly: false } });
it('单次完成和撤销绑定准确日期、时间、版本，不影响下一周同名课', async () => {
  const { result } = hook(); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  await act(async () => result.current.forOccurrence(o).onToggle?.());
  await waitFor(() => expect(result.current.forOccurrence(o).done).toBe(true));
  expect(result.current.forOccurrence(occurrences[1]!).done).toBe(false);
  expect(api.set).toHaveBeenCalledWith('A', { occurrence_id: o.id, date: '2026-09-07', expected_start: o.start, expected_end: o.end, expected_revision: 4, done: true });
  await waitFor(() => expect(result.current.forOccurrence(o).busy).toBe(false));
  await act(async () => result.current.forOccurrence(o).onToggle?.());
  await waitFor(() => expect(result.current.forOccurrence(o).done).toBe(false));
  expect(api.set.mock.calls[1]?.[1].done).toBe(false);
});
it('版本冲突保存失败如实显示，课程不虚假变为已完成', async () => {
  api.set.mockRejectedValue(new Error('课表已改变，请刷新后重试'));
  const { result } = hook(); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  await act(async () => result.current.forOccurrence(o).onToggle?.());
  await waitFor(() => expect(result.current.forOccurrence(o).error).toContain('课表已改变'));
  expect(result.current.forOccurrence(o).done).toBe(false);
});
it('连堂网格同一课次重复点击只发起一次保存', async () => {
  let resolve!: (value: unknown) => void; api.set.mockReturnValue(new Promise(r => { resolve = r; }));
  const { result } = hook(); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  act(() => { result.current.forOccurrence(o).onToggle?.(); result.current.forOccurrence(o).onToggle?.(); });
  expect(api.set).toHaveBeenCalledOnce(); expect(result.current.forOccurrence(o).busy).toBe(true);
  await act(async () => resolve({ revision: 4, completion: complete }));
});
it('换空间后的迟到写回执不能改变新空间状态', async () => {
  let resolve!: (value: unknown) => void; api.set.mockReturnValue(new Promise(r => { resolve = r; }));
  const { result, rerender } = hook(); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  act(() => result.current.forOccurrence(o).onToggle?.());
  rerender({ epoch: 'B', readonly: false }); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  await act(async () => resolve({ revision: 4, completion: complete }));
  expect(result.current.forOccurrence(o).done).toBe(false);
  expect(api.set.mock.calls[0]?.[0]).toBe('A');
});
it('只读访问没有写操作，读取失败则禁止推断当前完成状态', async () => {
  const { result, rerender } = hook(); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  rerender({ epoch: 'A', readonly: true }); expect(result.current.forOccurrence(o).onToggle).toBeUndefined();
  api.get.mockRejectedValue(new Error('合成读取失败')); await act(async () => result.current.state.refresh());
  expect(result.current.forOccurrence(o).disabled).toBe(true); expect(api.set).not.toHaveBeenCalled();
});
it('写入前开始的旧轮询不能覆盖已确认完成状态', async () => {
  const { result } = hook(); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  let resolveOld!: (value: unknown) => void;
  let resolveFresh!: (value: unknown) => void;
  api.get.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  act(() => { void result.current.state.refresh(); }); await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
  api.set.mockResolvedValue({ revision: 4, completion: complete });
  api.get.mockImplementationOnce(() => new Promise(resolve => { resolveFresh = resolve; }));
  await act(async () => result.current.forOccurrence(o).onToggle?.());
  await waitFor(() => expect(result.current.forOccurrence(o).done).toBe(true));
  await act(async () => resolveOld({ revision: 4, completions: [] }));
  expect(result.current.forOccurrence(o).done).toBe(true);
  await waitFor(() => expect(resolveFresh).toBeTypeOf('function'));
  await act(async () => resolveFresh({ revision: 4, completions: [complete] }));
  await waitFor(() => expect(result.current.forOccurrence(o).busy).toBe(false));
  expect(result.current.forOccurrence(o).done).toBe(true);
});
it('旧空间同课次回执不能释放新空间的在途写锁', async () => {
  let resolveOld!: (value: unknown) => void; let resolveNew!: (value: unknown) => void;
  api.set.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  const { result, rerender } = hook(); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  act(() => result.current.forOccurrence(o).onToggle?.());
  rerender({ epoch: 'B', readonly: false }); await waitFor(() => expect(result.current.forOccurrence(o).disabled).toBe(false));
  act(() => result.current.forOccurrence(o).onToggle?.()); expect(api.set).toHaveBeenCalledTimes(2);
  await act(async () => resolveOld({ revision: 4, completion: complete }));
  expect(result.current.forOccurrence(o).busy).toBe(true);
  act(() => result.current.forOccurrence(o).onToggle?.()); expect(api.set).toHaveBeenCalledTimes(2);
  await act(async () => resolveNew({ revision: 4, completion: complete }));
});
