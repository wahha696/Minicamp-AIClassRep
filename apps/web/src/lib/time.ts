// 页面显示用的时间工具：一律按 Asia/Shanghai（中国无夏令时，按固定 +8 算「第几天」）。
// 格式如「今天 14:00」「明天 23:59」「周五 14:00」「10/8 09:00」。
import type { EventDTO } from '../api/types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OFFSET = 8 * HOUR;

const hhmmFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 上海时间的「第几天」（自 1970-01-01 起），用来比较是不是同一天 */
function dayIndex(ts: number): number {
  return Math.floor((ts + OFFSET) / DAY);
}

/** 'HH:mm' */
export function hhmm(ts: number): string {
  return hhmmFmt.format(new Date(ts));
}

/** 上海时间某天的 [0 点, 次日 0 点)，dayOffset=0 为今天。与后端 /api/today 的区间一致 */
export function shanghaiDayRange(dayOffset = 0, now = Date.now()): { from: number; to: number } {
  const from = (dayIndex(now) + dayOffset) * DAY - OFFSET;
  return { from, to: from + DAY };
}

/** 日期部分：今天 / 明天 / 后天 / 昨天 / 7 天内的周几 / M/D */
export function dayLabel(ts: number, now = Date.now()): string {
  const diff = dayIndex(ts) - dayIndex(now);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff === -1) return '昨天';
  const d = new Date(ts + OFFSET); // 平移后用 UTC 读数 = 上海时间
  if (diff > 0 && diff < 7) return WEEKDAYS[d.getUTCDay()]!;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 本周页列标题：「周三 10/1」 */
export function weekdayDate(ts: number): string {
  const d = new Date(ts + OFFSET);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 「今天 14:00」「周五 14:00」 */
export function formatWhen(ts: number, now = Date.now()): string {
  return `${dayLabel(ts, now)} ${hhmm(ts)}`;
}

/**
 * 卡片上的时间：
 * - 有开始时间 → 「14:00–14:45」（今天）或「周五 14:00」；
 * - 只有截止时间 → 「23:59 截止」，isDeadline=true（页面用红字）；
 * - 都没有 → 「时间待定」。
 * 今日页只放今天的事，所以今天的时间省略「今天」两字。
 */
export function eventTimeText(
  e: Pick<EventDTO, 'start_at' | 'end_at' | 'deadline_at'>,
  now = Date.now(),
): { text: string; isDeadline: boolean } {
  const short = (ts: number) => (dayIndex(ts) === dayIndex(now) ? hhmm(ts) : formatWhen(ts, now));
  if (e.start_at !== null) {
    let text = short(e.start_at);
    if (e.end_at !== null && e.end_at > e.start_at) {
      text += `–${dayIndex(e.end_at) === dayIndex(e.start_at) ? hhmm(e.end_at) : short(e.end_at)}`;
    }
    return { text, isDeadline: false };
  }
  if (e.deadline_at !== null) return { text: `${short(e.deadline_at)} 截止`, isDeadline: true };
  return { text: '时间待定', isDeadline: false };
}
