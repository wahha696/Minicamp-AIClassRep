// 顶栏补拉后的「全局待整理 N」状态判定。health.pending 是全部启用群的待整理数，
// 新消息进入时可能增加，不能用它计算本次补拉还剩多少条。
import type { HealthDTO } from '../api/types';


export interface SyncTrack {
  total: number; // 本次补回的条数
  base: number; // 补拉前的 pending（读不到按 0）
  startedAt: number;
  fails: number; // 连续读 /health 失败次数
}

export type TrackStep =
  | { kind: 'progress'; left: number; message?: string }
  | { kind: 'done' }
  | { kind: 'stop'; message: string };

/** 所有启用群当前的待整理数 */
export function syncLeft(_t: SyncTrack, pending: number): number {
  return Math.max(pending, 0);
}

/** health 为 null 表示这次没读到；调用方据此自增 fails 后再传进来 */
export function trackStep(t: SyncTrack, health: Pick<HealthDTO, 'pending' | 'llm'> | null, _now: number): TrackStep {
  if (health === null) {
    return { kind: 'progress', left: -1, message: '暂时看不到整理进度，正在重连后台' };
  }
  const left = syncLeft(t, health.pending);
  if (left === 0) return { kind: 'done' };
  if (health.llm === 'unconfigured') return { kind: 'stop', message: '还没配置 AI，补回的消息暂不整理' };
  return { kind: 'progress', left };
}
