// 本周页（D3）的分组逻辑：把事件放进「从今天起 7 天」的每一天里（纯函数，便于单测）。
import type { EventDTO } from '../api/types';
import { shanghaiDayRange } from './time';

export interface WeekItem {
  event: EventDTO;
  at: number;          // 在这一天里显示/排序用的时间
  isDeadline: boolean; // 只有截止时间（没有开始时间）→ 显示为 DDL 条目
}

export interface WeekDay {
  from: number; // 这天 0 点（上海）
  to: number;   // 次日 0 点
  isToday: boolean;
  items: WeekItem[];
}

export const WEEK_DAYS = 7;

/** 本周区间 = 今天 0 点 ~ 第 7 天后的 0 点，与导出、请求用同一个区间 */
export function weekRange(now = Date.now()): { from: number; to: number } {
  return { from: shanghaiDayRange(0, now).from, to: shanghaiDayRange(WEEK_DAYS, now).from };
}

/**
 * 每个事件只放进一天：有开始时间且落在 7 天内 → 按开始时间；否则按截止时间。
 * 两个时间都不在 7 天内（或都为空）的事件不显示；cancelled 不显示（与后端区间查询一致）。
 * 每天内按时间升序。
 */
export function groupByDay(events: EventDTO[], now = Date.now()): WeekDay[] {
  const days: WeekDay[] = Array.from({ length: WEEK_DAYS }, (_, i) => {
    const r = shanghaiDayRange(i, now);
    return { ...r, isToday: i === 0, items: [] };
  });
  const { from, to } = weekRange(now);
  const inWeek = (ts: number | null): ts is number => ts !== null && ts >= from && ts < to;

  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const at = inWeek(event.start_at) ? event.start_at : inWeek(event.deadline_at) ? event.deadline_at : null;
    if (at === null) continue;
    const day = days.find((d) => at >= d.from && at < d.to)!;
    day.items.push({ event, at, isDeadline: event.start_at === null });
  }

  for (const d of days) d.items.sort((a, b) => a.at - b.at || a.event.id - b.event.id);
  return days;
}
