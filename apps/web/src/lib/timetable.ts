// 课表工具（FR-13）：CLASS_BLOCKS / blockOf / 周次计算 / parseTimetable。
// 后端有一份同款拷贝（apps/server/src/timetable.ts），两边用同一组用例保证一致。
import type { CourseDTO } from '../api/types';

const DAY = 86_400_000;
const TZ = 8 * 3_600_000; // Asia/Shanghai 固定 +8

/** 5 个节次块（两节一块）：起止分钟数（当天 0:00 起）+ 显示文案 */
export const CLASS_BLOCKS: ReadonlyArray<{ block: number; startMin: number; endMin: number; label: string; time: string }> = [
  { block: 1, startMin: 8 * 60, endMin: 9 * 60 + 40, label: '1–2 节', time: '08:00–09:40' },
  { block: 2, startMin: 10 * 60, endMin: 11 * 60 + 40, label: '3–4 节', time: '10:00–11:40' },
  { block: 3, startMin: 14 * 60, endMin: 15 * 60 + 40, label: '5–6 节', time: '14:00–15:40' },
  { block: 4, startMin: 16 * 60, endMin: 17 * 60 + 40, label: '7–8 节', time: '16:00–17:40' },
  { block: 5, startMin: 19 * 60, endMin: 20 * 60 + 40, label: '9–10 节', time: '19:00–20:40' },
];

/** 归块：当天时刻 t 属于「开始时间 ≤ t 的最后一块」；比第 1 块开始还早的归第 1 块。 */
export function blockOf(ts: number): 1 | 2 | 3 | 4 | 5 {
  const d = new Date(ts + TZ);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  let block: 1 | 2 | 3 | 4 | 5 = 1;
  for (const b of CLASS_BLOCKS) {
    if (b.startMin <= mins) block = b.block as 1 | 2 | 3 | 4 | 5;
  }
  return block;
}

/** ts 所在天的上海 0 点 */
export function shanghaiDayStartTs(ts: number): number {
  return Math.floor((ts + TZ) / DAY) * DAY - TZ;
}

/** 上海时间星期几：1=周一 … 7=周日 */
export function weekdayOf(ts: number): number {
  return ((new Date(ts + TZ).getUTCDay() + 6) % 7) + 1;
}

/** ts 所在周的周一 0 点（上海时间） */
export function mondayOf(ts: number): number {
  const start = shanghaiDayStartTs(ts);
  return start - (weekdayOf(ts) - 1) * DAY;
}

/** 第几周：semesterStart（'YYYY-MM-DD'，周一）所在周 = 1；开学前为 ≤0 */
export function weekOf(ts: number, semesterStart: string): number {
  const start = Date.parse(`${semesterStart}T00:00:00+08:00`);
  if (Number.isNaN(start)) return 1;
  return Math.floor((mondayOf(ts) - start) / (7 * DAY)) + 1;
}

// ---------- 教务系统 xls 解析 ----------

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
// 表头里的「星期X」→ 周几（1=周一 … 7=周日）
const WEEKDAY_VALUE: Record<string, number> = {
  星期一: 1,
  星期二: 2,
  星期三: 3,
  星期四: 4,
  星期五: 5,
  星期六: 6,
  星期日: 7,
};

/** 节次行的第一列：「1－2」「3-4」等（全角/半角横线都认）→ 块号；11–12 返回 6 表示超范围 */
const BLOCK_ROW_RE = /^(\d+)\s*[－\-–—]\s*(\d+)$/;

export interface ParsedTimetable {
  courses: CourseDTO[];
  warnings: string[];
}

/**
 * 解析 sheet_to_json(ws, {header: 1, defval: ''}) 的结果（纯函数，不测 xls 本身）。
 * 规则见 docs/拓展功能-开发计划.md §4.6。
 */
export function parseTimetable(rows: string[][]): ParsedTimetable {
  const warnings: string[] = [];
  const courses: CourseDTO[] = [];

  // 1) 表头行：同时包含「星期一」和「星期日」的那一行；列序按表头文字定位（星期日可能在第一列）
  const headerIdx = rows.findIndex(
    (r) => r.some((c) => String(c).trim() === '星期一') && r.some((c) => String(c).trim() === '星期日'),
  );
  if (headerIdx < 0) {
    return { courses, warnings: ['没找到表头行（应包含「星期一」…「星期日」）'] };
  }
  const header = rows[headerIdx]!;
  // weekday 1..7 → 列下标
  const colOf = new Map<number, number>();
  header.forEach((cell, i) => {
    const wd = WEEKDAY_VALUE[String(cell).trim()];
    if (wd !== undefined) colOf.set(wd, i);
  });

  // 2) 表头之后：第一列是节次的行才是课；「备注」开头 / 其他行忽略
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const first = String(rows[r]?.[0] ?? '').trim();
    if (first.startsWith('备注')) continue;
    const m = BLOCK_ROW_RE.exec(first);
    if (!m) continue;
    const p1 = Number(m[1]);
    const p2 = Number(m[2]);
    const block = Math.ceil(p1 / 2); // 1-2→1, 3-4→2 … 9-10→5
    if (p1 < 1 || p2 < p1 || p2 > 10 || block < 1 || block > 5) {
      // 11–12 节：有课才警告，空行直接忽略
      const content = rows[r]!.slice(1).map((c) => String(c).trim()).find((c) => c !== '');
      if (content !== undefined) warnings.push(`第 ${p1}–${p2} 节不在作息表内，已忽略：${content.split('\n')[0]}`);
      continue;
    }
    const row = rows[r]!;
    for (const [weekday, col] of colOf) {
      const cell = String(row[col] ?? '');
      if (cell.trim() === '') continue;
      parseCell(cell, weekday as CourseDTO['weekday'], block as CourseDTO['block'], courses, warnings);
    }
  }
  return { courses, warnings };
}

const WEEKS_RE = /\[周\]/;

/** 一个格子可能有多门课：以「周次行」（含 [周] 的行）为锚点切段 */
function parseCell(
  cell: string,
  weekday: CourseDTO['weekday'],
  block: CourseDTO['block'],
  courses: CourseDTO[],
  warnings: string[],
): void {
  const lines = cell
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const anchors = lines.map((l, i) => (WEEKS_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  const dayText = `周${['一', '二', '三', '四', '五', '六', '日'][weekday - 1]}`;
  if (anchors.length === 0) {
    warnings.push(`${dayText} 第${block}块有内容但没有周次信息，已忽略：${lines[0] ?? ''}`);
    return;
  }

  let prevAnchor = -1;
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k]!;
    const nextA = anchors[k + 1];

    // 本门课的「课名+教师」行区间。
    // 上一锚点与本锚点之间的行 = [上一门教室?] + [本门课名, 本门教师]：
    // 课名/教师至少要占两行，所以中间行 ≥3 时第一行才算上一门的教室，否则当它没有教室。
    const headerStart =
      k === 0 ? 0 : prevAnchor + 1 + (a - prevAnchor - 1 >= 3 ? 1 : 0);
    const headers = lines.slice(headerStart, a);
    const name = headers[0] ?? '';
    const teacher = headers.slice(1).join(' ');

    if (name === '') {
      warnings.push(`${dayText} 第${block}块有一门课没解析出课名，已忽略`);
      prevAnchor = a;
      continue;
    }

    const weeks = parseWeeks(lines[a]!);
    if (weeks === null) {
      warnings.push(`「${name}」的周次「${lines[a]!}」没解析出来，已跳过这门课`);
      prevAnchor = a;
      continue;
    }

    // 教室 = 本锚点之后、下一锚点之前的首行；但如果本锚点是最后一个，则直接取下一行
    let location = '';
    const after = lines.slice(a + 1, nextA ?? lines.length);
    if (nextA === undefined) {
      // 最后一门：之后第一行是教室（没有就是空，如体育）
      location = after[0] ?? '';
      if (after.length > 1) {
        warnings.push(`${dayText} 第${block}块「${name}」之后还有内容没有周次信息，已忽略：${after[1]}`);
      }
    } else {
      // 非最后一门：「之后到下一锚点」至少要有课名+教师 2 行，多出的第一行才是教室
      location = after.length >= 3 ? after[0]! : '';
    }

    courses.push({ name, teacher, location, weekday, block, weeks });
    prevAnchor = a;
  }
}

/** 「3-16」「8,12」「1-15单」「1-16双」→ 周次数组；解析不了返回 null */
export function parseWeeks(text: string): number[] | null {
  const body = text.replace('[周]', '').replace(/\s/g, '');
  if (body === '') return null;
  const weeks = new Set<number>();
  for (const part of body.split(',')) {
    const rangeM = /^(\d+)-(\d+)(单|双)?$/.exec(part);
    const singleM = /^(\d+)(单|双)?$/.exec(part);
    if (rangeM) {
      const a = Number(rangeM[1]);
      const b = Number(rangeM[2]);
      if (b < a) return null;
      for (let w = a; w <= b; w++) {
        if (rangeM[3] === '单' && w % 2 === 0) continue;
        if (rangeM[3] === '双' && w % 2 === 1) continue;
        if (w >= 1 && w <= 30) weeks.add(w);
      }
    } else if (singleM) {
      const w = Number(singleM[1]);
      if (singleM[2] === '单' && w % 2 === 0) continue;
      if (singleM[2] === '双' && w % 2 === 1) continue;
      if (w >= 1 && w <= 30) weeks.add(w);
    } else {
      return null;
    }
  }
  return weeks.size === 0 ? null : [...weeks].sort((x, y) => x - y);
}
