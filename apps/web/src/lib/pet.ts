// 桌宠的纯逻辑：台词挑选与数值工具。不碰 DOM，独立成 lib 便于单测（组件在 components/Pet.tsx）。
import type { EventDTO } from '../api/types';

/** 台词只关心这几个字段，方便测试构造 */
export type PetEvent = Pick<EventDTO, 'title' | 'status' | 'start_at' | 'end_at' | 'deadline_at'>;

/** 把 v 夹在 [min, max] 内（min > max 时返回 min，不抛错） */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

/** 等概率随机取一个；rng 可注入（测试用） */
export function pickRandom<T>(arr: readonly T[], rng: () => number = Math.random): T {
  if (arr.length === 0) throw new Error('pickRandom：空数组');
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))]!;
}

/** 按时段打招呼 */
export function petGreeting(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/** 10 分钟内要开始的事 → 提醒一句；没有就 null */
export function nextStartHint(events: readonly PetEvent[], now: number): string | null {
  const next = events
    .filter((e) => e.status === 'active' && e.start_at !== null && e.start_at > now)
    .sort((a, b) => a.start_at! - b.start_at!)[0];
  if (!next) return null;
  const min = Math.round((next.start_at! - now) / 60_000);
  if (min > 10) return null;
  if (min <= 1) return `马上要「${next.title}」了，快准备！`;
  return `距「${next.title}」开始还有 ${min} 分钟`;
}

/** 正在进行的事（已开始、未结束） */
export function ongoingHint(events: readonly PetEvent[], now: number): string | null {
  const cur = events.find(
    (e) => e.status === 'active' && e.start_at !== null && e.start_at <= now && (e.end_at === null || e.end_at > now),
  );
  return cur ? `「${cur.title}」正在进行中` : null;
}

/** 3 小时内要截止、还没完成的 */
export function deadlineHint(events: readonly PetEvent[], now: number): string | null {
  const e = events
    .filter(
      (e) =>
        e.status === 'active' &&
        e.deadline_at !== null &&
        e.deadline_at > now &&
        e.deadline_at - now <= 3 * 3_600_000,
    )
    .sort((a, b) => a.deadline_at! - b.deadline_at!)[0];
  if (!e) return null;
  const h = (e.deadline_at! - now) / 3_600_000;
  return h < 1 ? `「${e.title}」一小时内就要截止了！` : `「${e.title}」${Math.round(h)} 小时后截止，别忘了`;
}

export const IDLE_LINES: readonly string[] = [
  '群里的通知我会盯着的，有安排第一时间告诉你~',
  '单击我聊天，按住我可以拎起来搬家（会自己落地）。',
  '今天也要元气满满哦！',
  '累了就去歇会儿，日程我来记着。',
  '右键点我可以让我走两步。',
];

/**
 * 挑一句台词：有急事（快开始/进行中/快截止）时大概率先报事，否则闲聊。
 * 闲聊池把后端 summary 放在最前——它本来就是写给人看的一句话（如「今天 4 件事，最急的是 14:00 高数小测」）。
 */
export function petLine(
  events: readonly PetEvent[],
  now: number,
  summary: string | undefined,
  rng: () => number = Math.random,
): string {
  const urgent = [nextStartHint(events, now), ongoingHint(events, now), deadlineHint(events, now)].filter(
    (s): s is string => s !== null,
  );
  if (urgent.length > 0 && rng() < 0.7) return pickRandom(urgent, rng);
  const pool: readonly string[] = summary ? [summary, ...IDLE_LINES] : IDLE_LINES;
  return pickRandom(pool, rng);
}
