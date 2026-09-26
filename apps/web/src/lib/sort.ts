// 今日页的两种排序（纯函数，便于单测）。
// - 按时间：开始时间，没有就用截止时间，升序；时间待定的排最后（与后端 /api/today 的顺序一致）。
// - 按紧急（FR-12）：已完成排最后 → 危机等级降序 → urgencyTier → 时间升序。
import type { EventDTO } from '../api/types';

export type SortMode = 'time' | 'urgency';

export const SORT_LABEL: Record<SortMode, string> = { time: '按时间', urgency: '按紧急' };

/** 「很快就到」的窗口：2 小时内开始 / 截止的事顶到最前 */
export const SOON_MS = 2 * 3_600_000;

type Sortable = Pick<EventDTO, 'id' | 'status' | 'level' | 'start_at' | 'deadline_at'>;

function sortTime(e: Sortable): number | null {
  return e.start_at ?? e.deadline_at;
}

/**
 * 紧急档位（越小越急）：
 * 0 两小时内开始 / 截止 → 1 今天稍晚 → 2 时间待定 → 3 已经过了 → 4 已完成
 */
export function urgencyTier(e: Sortable, now = Date.now()): number {
  if (e.status === 'done') return 4;
  const t = sortTime(e);
  if (t === null) return 2;
  if (t < now) return 3;
  return t - now <= SOON_MS ? 0 : 1;
}

function byTime(a: Sortable, b: Sortable): number {
  const ta = sortTime(a);
  const tb = sortTime(b);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  return a.id - b.id;
}

/** 返回排好序的新数组，不改原数组 */
export function sortEvents<T extends Sortable>(events: readonly T[], mode: SortMode, now = Date.now()): T[] {
  const list = [...events];
  if (mode === 'time') return list.sort(byTime);
  return list.sort(
    (a, b) =>
      (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) ||
      b.level - a.level ||
      urgencyTier(a, now) - urgencyTier(b, now) ||
      byTime(a, b),
  );
}
