// 顶栏「刷新」补拉后的「整理中 N」进度判定（纯函数，便于单测）。
// health.pending 是全部启用群的待整理数，群里一直有人说话时不会归零——
// 所以补拉前先记一个基线，只看「比补拉前多出来的那部分」，且不超过本次补回的条数。
import type { HealthDTO } from '../api/types';

export const TRACK_MAX_MS = 10 * 60_000; // 最多盯 10 分钟，之后交给后台慢慢整理
export const TRACK_MAX_FAILS = 3; // 连续读不到 /health 这么多次就不盯了

export interface SyncTrack {
  total: number; // 本次补回的条数
  base: number; // 补拉前的 pending（读不到按 0）
  startedAt: number;
  fails: number; // 连续读 /health 失败次数
}

export type TrackStep =
  | { kind: 'progress'; left: number }
  | { kind: 'done' }
  | { kind: 'stop'; message: string };

/** 本次补回的消息还剩多少没整理 */
export function syncLeft(t: SyncTrack, pending: number): number {
  return Math.min(Math.max(pending - t.base, 0), t.total);
}

/** health 为 null 表示这次没读到；调用方据此自增 fails 后再传进来 */
export function trackStep(t: SyncTrack, health: Pick<HealthDTO, 'pending' | 'llm'> | null, now: number): TrackStep {
  if (health === null) {
    return t.fails >= TRACK_MAX_FAILS
      ? { kind: 'stop', message: '连不上后台，暂时看不到整理进度' }
      : { kind: 'progress', left: -1 }; // -1：沿用上一次的数字
  }
  const left = syncLeft(t, health.pending);
  if (left === 0) return { kind: 'done' };
  if (health.llm === 'unconfigured') return { kind: 'stop', message: '还没配置 AI，补回的消息暂不整理' };
  if (now - t.startedAt >= TRACK_MAX_MS) return { kind: 'stop', message: '消息较多，剩下的在后台继续整理' };
  return { kind: 'progress', left };
}
