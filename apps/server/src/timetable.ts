// 课表（FR-13）：courses 表 + kv.semester_start。
// weekOf / occurrences / blockOf 给本周网格、提取提示词共用。
// 时间约定不变：对外一律毫秒时间戳；只有展示/提示词才转 Asia/Shanghai 文本。
import { beginTx, commitTx, db, rollbackTx } from './db/index.js';
import type { CourseDTO, TimetableDTO } from './types.js';

const DAY_MS = 86400_000;
const TZ = 8 * 3600_000; // Asia/Shanghai 固定 +8

/** 6 个节次块（两节一块），分钟数从当天 0:00 起。前端有一份同款拷贝（web/src/lib/timetable.ts）。 */
export const CLASS_BLOCKS: ReadonlyArray<{ block: number; startMin: number; endMin: number }> = [
  { block: 1, startMin: 8 * 60, endMin: 9 * 60 + 40 }, // 1–2 节 08:00–09:40
  { block: 2, startMin: 10 * 60, endMin: 11 * 60 + 40 }, // 3–4 节 10:00–11:40
  { block: 3, startMin: 14 * 60, endMin: 15 * 60 + 40 }, // 5–6 节 14:00–15:40
  { block: 4, startMin: 16 * 60, endMin: 17 * 60 + 40 }, // 7–8 节 16:00–17:40
  { block: 5, startMin: 19 * 60, endMin: 20 * 60 + 40 }, // 9–10 节 19:00–20:40
  { block: 6, startMin: 21 * 60, endMin: 22 * 60 + 40 }, // 11–12 节 21:00–22:40
];

/** 每节次的上下课分钟数（当天 0:00 起）。课次存的是节次范围，展开成具体时刻用它。 */
export const SECTION_TIMES: ReadonlyArray<{ startMin: number; endMin: number }> = [
  { startMin: 8 * 60, endMin: 8 * 60 + 45 }, // 1 节 08:00–08:45
  { startMin: 8 * 60 + 55, endMin: 9 * 60 + 40 }, // 2 节 08:55–09:40
  { startMin: 10 * 60, endMin: 10 * 60 + 45 }, // 3 节 10:00–10:45
  { startMin: 10 * 60 + 55, endMin: 11 * 60 + 40 }, // 4 节 10:55–11:40
  { startMin: 14 * 60, endMin: 14 * 60 + 45 }, // 5 节 14:00–14:45
  { startMin: 14 * 60 + 55, endMin: 15 * 60 + 40 }, // 6 节 14:55–15:40
  { startMin: 16 * 60, endMin: 16 * 60 + 45 }, // 7 节 16:00–16:45
  { startMin: 16 * 60 + 55, endMin: 17 * 60 + 40 }, // 8 节 16:55–17:40
  { startMin: 19 * 60, endMin: 19 * 60 + 45 }, // 9 节 19:00–19:45
  { startMin: 19 * 60 + 55, endMin: 20 * 60 + 40 }, // 10 节 19:55–20:40
  { startMin: 21 * 60, endMin: 21 * 60 + 45 }, // 11 节 21:00–21:45
  { startMin: 21 * 60 + 55, endMin: 22 * 60 + 40 }, // 12 节 21:55–22:40
];

export const MAX_SECTION = SECTION_TIMES.length;

/** 归块：当天时刻 t 属于「开始时间 ≤ t 的最后一块」；比第 1 块开始还早的归第 1 块。 */
export function blockOf(ts: number): 1 | 2 | 3 | 4 | 5 | 6 {
  const d = new Date(ts + TZ);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  let block: 1 | 2 | 3 | 4 | 5 | 6 = 1;
  for (const b of CLASS_BLOCKS) {
    if (b.startMin <= mins) block = b.block as 1 | 2 | 3 | 4 | 5 | 6;
  }
  return block;
}

/** ts（按上海时间算）所在天的 0 点，毫秒时间戳 */
export function shanghaiDayStartTs(ts: number): number {
  return Math.floor((ts + TZ) / DAY_MS) * DAY_MS - TZ;
}

/** 上海时间星期几：1=周一 … 7=周日 */
export function weekdayOf(ts: number): number {
  return ((new Date(ts + TZ).getUTCDay() + 6) % 7) + 1;
}

/** ts 所在周的周一 0 点（上海时间），毫秒时间戳 */
export function mondayOf(ts: number): number {
  const start = shanghaiDayStartTs(ts);
  return start - (weekdayOf(ts) - 1) * DAY_MS;
}

/** 本学期第一周周一 'YYYY-MM-DD'（kv.semester_start；D2 默认留空，导入课表时才写） */
export function semesterStart(): string {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'semester_start'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

/** ts 落在第几周（semester_start 所在周 = 1；开学前为 ≤0）；semester_start 未设置返回 NaN */
export function weekOf(ts: number): number {
  const start = Date.parse(`${semesterStart()}T00:00:00+08:00`);
  return Math.floor((mondayOf(ts) - start) / (7 * DAY_MS)) + 1;
}

// ---------- 存取 ----------

interface CourseRow {
  name: string;
  teacher: string;
  location: string;
  weekday: number;
  start_section: number;
  end_section: number;
  weeks: string;
}

function listCourses(): CourseDTO[] {
  const rows = db
    .prepare('SELECT name, teacher, location, weekday, start_section, end_section, weeks FROM courses ORDER BY weekday, start_section, id')
    .all() as unknown as CourseRow[];
  return rows.map((r) => ({
    name: r.name,
    teacher: r.teacher,
    location: r.location,
    weekday: r.weekday as CourseDTO['weekday'],
    start: r.start_section,
    end: r.end_section,
    weeks: safeWeeks(r.weeks),
  }));
}

/** weeks 是 JSON 数组；坏数据当空数组（一门都不上），不让整个接口挂掉 */
function safeWeeks(raw: string): number[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

export function getTimetable(): TimetableDTO {
  return { semester_start: semesterStart(), courses: listCourses() };
}

/** 事务里整表替换 courses + 写 semester_start（调用方负责 zod 校验） */
export function saveTimetable(t: TimetableDTO): void {
  beginTx();
  try {
    db.prepare('DELETE FROM courses').run();
    const ins = db.prepare(
      'INSERT INTO courses (name, teacher, location, weekday, start_section, end_section, weeks) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const c of t.courses) {
      ins.run(c.name, c.teacher, c.location, c.weekday, c.start, c.end, JSON.stringify(c.weeks));
    }
    db.prepare(
      "INSERT INTO kv (key, value) VALUES ('semester_start', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(t.semester_start);
    commitTx();
  } catch (e) {
    rollbackTx();
    throw e;
  }
}

export function clearTimetable(): void {
  db.prepare('DELETE FROM courses').run();
}

/** 用户在群管理里指定的对应课程名；没指定返回 null */
export function groupCourseName(groupId: string): string | null {
  const row = db.prepare('SELECT course_name FROM groups WHERE group_id = ?').get(groupId) as
    | { course_name: string | null }
    | undefined;
  return row?.course_name ?? null;
}

// ---------- 展开课次 ----------

export interface CourseOccurrence {
  course: CourseDTO;
  start: number;
  end: number;
}

/** 把 [from, to) 内的每一天 × 每门课按 weekday / weeks 展开成具体课次，按开始时间排序 */
export function occurrences(from: number, to: number): CourseOccurrence[] {
  const courses = listCourses();
  if (courses.length === 0 || to <= from) return [];
  const out: CourseOccurrence[] = [];
  for (let day = shanghaiDayStartTs(from); day < to; day += DAY_MS) {
    const wd = weekdayOf(day);
    const week = weekOf(day);
    if (!Number.isFinite(week) || week < 1) continue; // semester_start 未设置 / 开学前
    for (const course of courses) {
      if (course.weekday !== wd || !course.weeks.includes(week)) continue;
      // 节次范围 → 当天起止时刻（节次越界的脏数据裁到 1–12，不让整个展开挂掉）
      const s = SECTION_TIMES[Math.min(Math.max(course.start, 1), MAX_SECTION) - 1]!;
      const e = SECTION_TIMES[Math.min(Math.max(course.end, 1), MAX_SECTION) - 1]!;
      out.push({
        course,
        start: day + s.startMin * 60_000,
        end: day + e.endMin * 60_000,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
