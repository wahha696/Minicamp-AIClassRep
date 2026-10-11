import { db } from './db/index.js';
import { getTimetable } from './timetable.js';
import { DAY, dateStamp, expandTimetable, type Occurrence, type TimetableDTO,
  type CourseCompletionDTO, type CourseCompletionRequest, type CourseCompletionResponse,
  type CourseCompletionsResponse } from '../../../shared/timetable.js';

export class CourseCompletionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}

// Retain inactive records so restoring a timetable version restores its completion
// state. A changed date/time/name cannot silently inherit an old lesson's state.
function key(timetable: TimetableDTO, occurrence: Occurrence): string {
  return JSON.stringify([timetable.semester_start, occurrence.id, occurrence.course.name, occurrence.start, occurrence.end]);
}
function state(timetable: TimetableDTO, occurrence: Occurrence): CourseCompletionDTO {
  const saved = db.prepare('SELECT done, updated_at FROM course_completions WHERE completion_key=?').get(key(timetable, occurrence));
  return { occurrence_id: occurrence.id, date: occurrence.date, start: occurrence.start, end: occurrence.end,
    done: saved?.done === 1, updated_at: Number(saved?.updated_at ?? 0) };
}
export function courseOccurrences(from: string, to: string) {
  const start = dateStamp(from), end = dateStamp(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 70 * DAY)
    throw new CourseCompletionError('日期范围无效：请查询不超过 70 天的具体课次', 400);
  const timetable = getTimetable();
  return { timetable, occurrences: expandTimetable(timetable, start, end) };
}
export function listCourseCompletions(from: string, to: string): CourseCompletionsResponse {
  const { timetable, occurrences } = courseOccurrences(from, to);
  return { revision: timetable.revision ?? 0, completions: occurrences.map(o => state(timetable, o)).filter(o => o.done) };
}
/** A bounded, source-free list for the assistant; IDs and times are server owned. */
export function listCourseOccurrences(from: string, to: string) {
  const { timetable, occurrences } = courseOccurrences(from, to);
  return { revision: timetable.revision ?? 0, truncated: occurrences.length > 300,
    occurrences: occurrences.slice(0, 300).map(o => ({ ...state(timetable, o), rule_id: o.course.id!, name: o.course.name })) };
}
export function setCourseCompletion(input: CourseCompletionRequest): CourseCompletionResponse {
  const timetable = getTimetable();
  if (input.expected_revision !== (timetable.revision ?? 0))
    throw new CourseCompletionError('课表已改变，请刷新后核对具体课次', 409);
  const day = dateStamp(input.date);
  if (!Number.isFinite(day)) throw new CourseCompletionError('课次日期无效', 400);
  const occurrence = expandTimetable(timetable, day, day + DAY).find(o => o.id === input.occurrence_id && o.date === input.date);
  if (!occurrence) throw new CourseCompletionError('该日期的课次不存在或已停课、调课，请刷新课表', 404);
  if (occurrence.start !== input.expected_start || occurrence.end !== input.expected_end)
    throw new CourseCompletionError('课次时间已改变，请刷新后重新确认', 409);
  const previous = state(timetable, occurrence);
  // Idempotent retries leave the receipt timestamp unchanged.
  if (previous.done !== input.done) {
    db.prepare(`INSERT INTO course_completions(completion_key,occurrence_id,date,start,end,done,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(completion_key) DO UPDATE SET done=excluded.done,updated_at=excluded.updated_at`)
      .run(key(timetable, occurrence), occurrence.id, occurrence.date, occurrence.start, occurrence.end, input.done ? 1 : 0, Date.now());
  }
  return { revision: timetable.revision ?? 0, completion: state(timetable, occurrence) };
}
