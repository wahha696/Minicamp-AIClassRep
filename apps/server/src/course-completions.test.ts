import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { db, openDb } from './db/index.js';
import { clearTimetable, getTimetable, saveTimetable } from './timetable.js';
import { listCourseCompletions, listCourseOccurrences, setCourseCompletion } from './course-completions.js';
import { registerTimetableRoutes } from './routes/timetable.js';
import type { CourseCompletionRequest } from '../../../shared/timetable.js';

beforeEach(() => {
  openDb(':memory:');
  saveTimetable({ semester_start: '2026-09-07', courses: [
    { id: 'physics', name: '合成物理', teacher: '', location: '', weekday: 1, block: 1, weeks: [1, 2, 3] },
    { id: 'physics-2', name: '合成物理', teacher: '', location: '', weekday: 1, block: 2, weeks: [1, 2, 3] },
  ] });
});
afterEach(() => db.close());
function request(done = true): CourseCompletionRequest {
  const { revision, occurrences } = listCourseOccurrences('2026-09-07', '2026-09-08');
  const o = occurrences[0]!;
  return { occurrence_id: o.occurrence_id, date: o.date, expected_start: o.start, expected_end: o.end, expected_revision: revision, done };
}
const list = () => listCourseCompletions('2026-09-07', '2026-09-28').completions;
describe('single course occurrence completion', () => {
  it('marks only one dated rule, is idempotent and supports undo without changing timetable', () => {
    const before = getTimetable();
    const first = setCourseCompletion(request());
    expect(setCourseCompletion(request())).toEqual(first);
    expect(list()).toHaveLength(1);
    expect(list()[0]).toMatchObject({ occurrence_id: 'physics@2026-09-07', done: true });
    expect(getTimetable()).toEqual(before);
    expect(setCourseCompletion(request(false)).completion.done).toBe(false);
    expect(list()).toEqual([]);
  });
  it('rejects stale revision, mismatched times, wrong dates and fabricated IDs', () => {
    const input = request();
    expect(() => setCourseCompletion({ ...input, expected_revision: 0 })).toThrow('课表已改变');
    expect(() => setCourseCompletion({ ...input, expected_start: input.expected_start + 1 })).toThrow('课次时间已改变');
    expect(() => setCourseCompletion({ ...input, date: '2026-09-08' })).toThrow('课次不存在');
    expect(() => setCourseCompletion({ ...input, occurrence_id: 'missing' })).toThrow('课次不存在');
    expect(list()).toEqual([]);
  });
  it.each(['cancel', 'move'] as const)('does not apply completed state to %s; restoration recovers the original', kind => {
    const previous = getTimetable(); setCourseCompletion(request());
    saveTimetable({ ...previous, exceptions: [{ id: 'exception', rule_id: 'physics', kind, original_date: '2026-09-07', ...(kind === 'move' ? { date: '2026-09-08' } : {}) }] });
    expect(list()).toEqual([]);
    expect(() => setCourseCompletion({ ...request(), occurrence_id: 'physics@2026-09-07' })).toThrow();
    saveTimetable({ ...previous, revision: undefined });
    expect(list()).toHaveLength(1);
  });
  it('keeps completion on location edits; changes to lesson time/name/semester do not inherit it', () => {
    const before = getTimetable(); setCourseCompletion(request());
    saveTimetable({ ...before, courses: before.courses.map(c => ({ ...c, location: '新教室' })) });
    expect(list()).toHaveLength(1);
    for (const patch of [{ start_time: '08:10' }, { name: '另一门课' }]) {
      saveTimetable({ ...before, revision: undefined, courses: before.courses.map(c => ({ ...c, ...patch })) });
      expect(list()).toEqual([]);
    }
    clearTimetable(); expect(list()).toEqual([]);
    saveTimetable({ ...before, revision: undefined }); expect(list()).toHaveLength(1);
    saveTimetable({ ...before, semester_start: '2026-08-31', revision: undefined }); expect(list()).toEqual([]);
    openDb(':memory:'); expect(db.prepare('SELECT COUNT(*) AS n FROM course_completions').get()?.n).toBe(0);
  });
  it('serves actual manual API with strict validation and bounded date ranges', async () => {
    const app = new Hono(); registerTimetableRoutes(app);
    const put = (input: unknown) => app.request('/api/timetable/completions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    expect((await put({ ...request(), unwanted: true })).status).toBe(400);
    expect((await put(request())).status).toBe(200);
    const response = await app.request('/api/timetable/completions?from=2026-09-07&to=2026-09-14');
    expect((await response.json() as any).completions).toHaveLength(1);
    expect((await app.request('/api/timetable/occurrences?from=2026-09-07&to=2027-09-07')).status).toBe(400);
    expect((await app.request('/api/timetable/occurrences?from=2026-02-30&to=2026-03-07')).status).toBe(400);
  });
});
