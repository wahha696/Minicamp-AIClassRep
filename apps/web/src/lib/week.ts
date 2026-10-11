// 本周页（D3/FR-14）的分组逻辑：以「某周周一」为基准排周一到周日 7 天（纯函数，便于单测）。
import type { EventDTO } from '../api/types';
import { shanghaiDayRange } from './time';
import { mondayOf } from './timetable';

export interface WeekItem {
  event: EventDTO;
  at: number;          // 在这一天里显示/排序用的时间
  isDeadline: boolean; // 落位用的是截止时刻（含「只有截止时间」和「开始在本周外、截止在本周内」）
  isContinuation?: true;
}

export interface WeekDay {
  from: number; // 这天 0 点（上海）
  to: number;   // 次日 0 点
  isToday: boolean;
  items: WeekItem[];
}

export const WEEK_DAYS = 7;

/** 给定周周一 0 点 → [周一 0 点, 下周一 0 点) */
export function weekRange(monday: number): { from: number; to: number } {
  return { from: monday, to: monday + WEEK_DAYS * 24 * 3_600_000 };
}

/** 当前上海时间所在周的周一 0 点 */
export function thisMonday(now = Date.now()): number {
  return mondayOf(now);
}

/**
 * Start/continuous days and deadline each remain visible, opening the same
 * business event. Same-day nodes share one entry, preferring its deadline.
 */
export function groupByDay(events: EventDTO[], monday: number, now = Date.now()): WeekDay[] {
  const days: WeekDay[] = Array.from({ length: WEEK_DAYS }, (_, i) => {
    const from = monday + i * 24 * 3_600_000;
    const today = shanghaiDayRange(0, now);
    return { from, to: from + 24 * 3_600_000, isToday: from === today.from, items: [] };
  });
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    for (const day of days) {
      const start = event.start_at, end = event.end_at, deadline = event.deadline_at;
      if (deadline !== null && deadline >= day.from && deadline < day.to) {
        day.items.push({ event, at: deadline, isDeadline: true });
      } else if (start !== null && start >= day.from && start < day.to) {
        day.items.push({ event, at: start, isDeadline: false });
      } else if (start !== null && end !== null && start < day.from && end > day.from && end > start) {
        day.items.push({ event, at: day.from, isDeadline: false, isContinuation: true });
      }
    }
  }

  for (const d of days) d.items.sort((a, b) => a.at - b.at || a.event.id - b.event.id);
  return days;
}
