/** Shared course rules and dated occurrences. `block` is only a legacy display hint. */
export interface SourceRef {
  sheet: string;
  row: number;
  column: number;
  raw: string;
  item_id: string;
}
export interface CourseDTO {
  id?: string;
  course_id?: string;
  name: string;
  teacher: string;
  location: string;
  campus?: string;
  class_name?: string;
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  block: number;
  start_period?: number;
  end_period?: number;
  start_time?: string;
  end_time?: string;
  weeks: number[];
  source?: SourceRef;
  user_modified?: boolean;
}
export interface Bell {
  period: number;
  start: string;
  end: string;
}
export interface CourseException {
  id: string;
  rule_id: string;
  kind: 'cancel' | 'move' | 'add' | 'keep';
  original_date: string;
  date?: string;
  start_time?: string;
  end_time?: string;
  location?: string;
  note?: string;
}
export interface ImportItem {
  id: string;
  sheet: string;
  row: number;
  column: number;
  raw: string;
  status: 'parsed' | 'pending' | 'ignored';
  course_ids: string[];
  message?: string;
}
export interface TimetableDTO {
  semester_start: string;
  courses: CourseDTO[];
  term_name?: string;
  school?: string;
  campus?: string;
  term_weeks?: number;
  bells?: Bell[];
  exceptions?: CourseException[];
  revision?: number;
  import_items?: ImportItem[];
}
export interface TimetableSaveRequest extends TimetableDTO {
  mode?: 'merge' | 'replace';
  expected_revision?: number;
  confirm_loss?: boolean;
}
export interface TimetableVersion {
  id: number;
  created_at: number;
  reason: string;
  timetable: TimetableDTO;
}
export const DAY = 86_400_000;
export const TZ = 8 * 3_600_000;
/** Example only: schools must confirm their own bells before saving an import. */
export const DEFAULT_BELLS: Bell[] = [
  ['08:00', '08:45'],
  ['08:55', '09:40'],
  ['10:00', '10:45'],
  ['10:55', '11:40'],
  ['14:00', '14:45'],
  ['14:55', '15:40'],
  ['16:00', '16:45'],
  ['16:55', '17:40'],
  ['19:00', '19:45'],
  ['19:55', '20:40'],
  ['20:50', '21:35'],
  ['21:45', '22:30'],
].map(([start, end], i) => ({ period: i + 1, start: start!, end: end! }));
export function minutes(time: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}
export function dateStamp(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const t = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isFinite(t) && dateString(t) === date ? t : NaN;
}
export function dateString(ts: number): string {
  return new Date(ts + TZ).toISOString().slice(0, 10);
}
export function periods(c: CourseDTO): [number, number] {
  return [c.start_period ?? c.block * 2 - 1, c.end_period ?? c.block * 2];
}
// Deterministic across server and browser; duplicate rules are disambiguated by source/ordinal.
export function stableId(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}
export function courseKey(c: CourseDTO): string {
  return JSON.stringify([
    c.name,
    c.teacher,
    c.location,
    c.campus ?? '',
    c.class_name ?? '',
    c.weekday,
    ...periods(c),
    c.start_time ?? '',
    c.end_time ?? '',
    [...c.weeks].sort((a, b) => a - b),
  ]);
}
export function normalizeCourses(courses: CourseDTO[]): CourseDTO[] {
  const seen = new Map<string, number>();
  return courses.map((c) => {
    const key = stableId(courseKey(c));
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    const [start_period, end_period] = periods(c);
    const id = c.id || `rule-${key}-${ordinal}`;
    return {
      ...c,
      id,
      course_id: c.course_id || id,
      start_period,
      end_period,
      block: Math.ceil(start_period / 2),
      weeks: [...new Set(c.weeks)].sort((a, b) => a - b),
    };
  });
}
export function ruleTimes(c: CourseDTO, bells: Bell[] = DEFAULT_BELLS): [string, string] {
  const [a, b] = periods(c);
  return [
    c.start_time || bells.find((x) => x.period === a)?.start || '',
    c.end_time || bells.find((x) => x.period === b)?.end || '',
  ];
}
export interface Occurrence {
  id: string;
  course: CourseDTO;
  date: string;
  start: number;
  end: number;
  exception?: CourseException;
}
export function expandTimetable(t: TimetableDTO, from: number, to: number): Occurrence[] {
  const origin = dateStamp(t.semester_start);
  if (!Number.isFinite(origin) || to <= from) return [];
  const out: Occurrence[] = [];
  const courses = normalizeCourses(t.courses);
  const push = (course: CourseDTO, date: string, exception?: CourseException) => {
    const day = dateStamp(date),
      times = ruleTimes(course, t.bells);
    const start = day + minutes(exception?.start_time || times[0]) * 60_000;
    const end = day + minutes(exception?.end_time || times[1]) * 60_000;
    if (Number.isFinite(start) && end > start && start < to && end > from) {
      out.push({
        id: `${course.id}@${date}${exception ? `:${exception.id}` : ''}`,
        date,
        course: exception?.location !== undefined ? { ...course, location: exception.location } : course,
        start,
        end,
        exception,
      });
    }
  };
  for (let day = Math.floor((from + TZ) / DAY) * DAY - TZ; day < to; day += DAY) {
    const week = Math.floor((day - origin) / (7 * DAY)) + 1;
    if (week < 1 || week > (t.term_weeks ?? 60)) continue;
    const weekday = ((new Date(day + TZ).getUTCDay() + 6) % 7) + 1;
    const date = dateString(day);
    for (const c of courses) {
      if (c.weekday !== weekday || !c.weeks.includes(week)) continue;
      const exceptions = (t.exceptions ?? []).filter((e) => e.rule_id === c.id && e.original_date === date);
      if (exceptions.some((e) => e.kind === 'cancel' || e.kind === 'move')) continue;
      push(
        c,
        date,
        exceptions.find((e) => e.kind === 'keep'),
      );
    }
  }
  for (const e of t.exceptions ?? []) {
    if (e.kind !== 'move' && e.kind !== 'add') continue;
    const c = courses.find((c) => c.id === e.rule_id);
    if (c && e.date) push(c, e.date, e);
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
export interface Conflict {
  left: string;
  right: string;
  start: number;
  end: number;
  kind: 'course' | 'event';
}
export function findConflicts(
  occurrences: Occurrence[],
  events: { id: string; start: number; end: number; deadline?: boolean }[] = [],
): Conflict[] {
  const out: Conflict[] = [];
  const overlap = (a: Occurrence, b: { id: string; start: number; end: number }, kind: Conflict['kind']) => {
    const start = Math.max(a.start, b.start),
      end = Math.min(a.end, b.end);
    if (start < end) out.push({ left: a.id, right: b.id, start, end, kind });
  };
  occurrences.forEach((a, i) => {
    occurrences.slice(i + 1).forEach((b) => overlap(a, b, 'course'));
    events.filter((e) => !e.deadline && e.end > e.start).forEach((b) => overlap(a, b, 'event'));
  });
  return out;
}
/** Match exact rules, or the same source position. Never deduplicate by course name. */
export function reconcileCourses(saved: CourseDTO[], incoming: CourseDTO[], mode: 'merge' | 'replace') {
  const changes: { before: CourseDTO; incoming: CourseDTO; protected: boolean }[] = [];
  const old = normalizeCourses(saved),
    used = new Set<string>();
  let added = 0,
    changed = 0,
    unchanged = 0,
    protectedEdits = 0;
  const result = normalizeCourses(incoming).map((c) => {
    const candidates = old.filter((o) => !used.has(o.id!));
    const match =
      candidates.find((o) => o.id === c.id) ||
      candidates.find((o) => courseKey(o) === courseKey(c)) ||
      candidates.find(
        (o) => c.source && o.source?.item_id === c.source.item_id && o.source.sheet === c.source.sheet,
      );
    if (!match) {
      added++;
      return c;
    }
    used.add(match.id!);
    if (courseKey(match) !== courseKey(c))
      changes.push({ before: match, incoming: c, protected: !!match.user_modified && mode === 'merge' });
    if (courseKey(match) === courseKey(c)) {
      unchanged++;
      return {
        ...c,
        id: match.id,
        course_id: match.course_id,
        user_modified: match.user_modified || c.user_modified,
      };
    } else if (match.user_modified && mode === 'merge') {
      protectedEdits++;
      return match;
    } else changed++;
    return { ...c, id: match.id, course_id: match.course_id };
  });
  const missing = old.filter((o) => !used.has(o.id!));
  return {
    courses: mode === 'merge' ? [...result, ...missing] : result,
    changes,
    added,
    changed,
    unchanged,
    protectedEdits,
    removed: mode === 'replace' ? missing.length : 0,
    retained: mode === 'merge' ? missing.length : 0,
  };
}
