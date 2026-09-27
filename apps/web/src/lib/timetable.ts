// 课表工具（FR-13）：CLASS_BLOCKS / blockOf / 周次计算 / parseTimetable。
// 后端有一份同款拷贝（apps/server/src/timetable.ts），两边用同一组用例保证一致。

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
export { parseTimetable, parseWeeks, type ParsedTimetable } from '../../../../shared/timetable-import';
