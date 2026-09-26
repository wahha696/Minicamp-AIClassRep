// 本周页（D3/FR-14）的分组逻辑：以「某周周一」为基准排周一到周日 7 天（纯函数，便于单测）。
import type { EventDTO } from '../api/types';
import { shanghaiDayRange } from './time';
import { mondayOf } from './timetable';

export interface WeekItem {
  event: EventDTO;
  at: number;          // 在这一天里显示/排序用的时间
  isDeadline: boolean; // 落位用的是截止时刻（含「只有截止时间」和「开始在本周外、截止在本周内」）
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
 * 每个事件只放进一天：有开始时间且落在本周内 → 按开始时间；否则按截止时间。
 * 两个时间都不在本周内（或都为空）的事件不显示；cancelled 不显示（与后端区间查询一致）。
 * isDeadline = 落位用的是 deadline_at（「开始在周外、截止在周内」也算 DDL，修复 FR-14 的标记漏标）。
 * 每天内按时间升序。
 */
export function groupByDay(events: EventDTO[], monday: number, now = Date.now()): WeekDay[] {
  const days: WeekDay[] = Array.from({ length: WEEK_DAYS }, (_, i) => {
    const from = monday + i * 24 * 3_600_000;
    const today = shanghaiDayRange(0, now);
    return { from, to: from + 24 * 3_600_000, isToday: from === today.from, items: [] };
  });
  const { from, to } = weekRange(monday);
  const inWeek = (ts: number | null): ts is number => ts !== null && ts >= from && ts < to;

  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const byStart = inWeek(event.start_at);
    const byDeadline = inWeek(event.deadline_at);
    const at = byStart ? event.start_at! : byDeadline ? event.deadline_at! : null;
    if (at === null) continue;
    const day = days.find((d) => at >= d.from && at < d.to)!;
    day.items.push({ event, at, isDeadline: !byStart });
  }

  for (const d of days) d.items.sort((a, b) => a.at - b.at || a.event.id - b.event.id);
  return days;
}
