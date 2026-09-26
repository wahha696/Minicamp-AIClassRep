// 同一节次块的折叠（FR-14）：同一天、blockOf 相同的事件算一个槽位。
// 今日页、本周「按时间」形态、本周网格共用。
import type { EventDTO } from '../api/types';
import { blockOf, shanghaiDayStartTs } from './timetable';

export { blockOf } from './timetable';

type Slotable = Pick<EventDTO, 'id' | 'level' | 'start_at' | 'deadline_at'>;

/**
 * 槽位键 = 上海日期 + '#' + 落位块的块号。
 * 落位时间 = start_at ?? deadline_at；两个都没有的事件不参与分组（返回 null）。
 * 调用方可以传 atOf 改落位规则（如本周页用 item.at——「开始在周外、截止在周内」的条目按截止时刻落位）。
 */
export function slotKey(e: Slotable, atOf?: (item: Slotable) => number | null): string | null {
  const at = atOf ? atOf(e) : e.start_at ?? e.deadline_at;
  if (at === null) return null;
  return `${shanghaiDayStartTs(at)}#${blockOf(at)}`;
}

export interface SlotGroup<T> {
  key: string | null; // 无时间事件的组 key 为 null（每个自己一组）
  items: T[];
  rep: T; // 代表 = 组内最急的（level 降序 → 时间升序 → id 升序）
}

/**
 * 把事件按「同一天 + 同一节次块」合并成组；没有时间的不参与分组（自己一组）。
 * 返回的组保持原列表顺序：每个组放在「组代表在原列表里的位置」——
 * 这样「按时间」「按紧急」两种排序下组的位置都正确。
 */
export function groupBySlot<T extends Slotable>(
  list: readonly T[],
  atOf?: (item: T) => number | null,
): SlotGroup<T>[] {
  const groups: SlotGroup<T>[] = [];
  const groupOf = new Map<string, SlotGroup<T>>();
  const placement = (item: T) => (atOf ? atOf(item) : item.start_at ?? item.deadline_at);

  for (const item of list) {
    const key = slotKey(item, atOf as ((i: Slotable) => number | null) | undefined);
    if (key === null) {
      groups.push({ key: null, items: [item], rep: item });
      continue;
    }
    let g = groupOf.get(key);
    if (!g) {
      g = { key, items: [item], rep: item };
      groupOf.set(key, g);
      groups.push(g);
      continue;
    }
    g.items.push(item);
  }

  // 每组选最急的代表，并把组放到代表在原列表中的位置
  const repRank = (e: T) => [-e.level, placement(e) ?? Number.MAX_SAFE_INTEGER, e.id] as const;
  for (const g of groups) {
    if (g.items.length > 1) {
      g.rep = g.items.reduce((best, x) => (compareRank(repRank(x), repRank(best)) < 0 ? x : best));
    }
  }
  const repIndex = new Map<SlotGroup<T>, number>();
  const itemIndex = new Map<T, number>();
  list.forEach((item, i) => itemIndex.set(item, i));
  groups.forEach((g) => repIndex.set(g, itemIndex.get(g.rep)!));
  groups.sort((a, b) => repIndex.get(a)! - repIndex.get(b)!);
  return groups;
}

function compareRank(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
