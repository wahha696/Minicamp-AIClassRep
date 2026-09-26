// 清理任务：删 sent_at 早于 RAW_MSG_TTL_DAYS 天的原始消息（FR-10.3）。
// event_sources 里存的是快照，不受影响。实现见 B7。
import { env } from '../env.js';

/** 启动时跑一次，之后每小时一次 */
export function startCleanupJob(): void {
  // 空实现
}

/** 清理一次，返回删掉的行数 */
export function cleanupOnce(_now: number = Date.now()): number {
  const _ttlDays = env.RAW_MSG_TTL_DAYS;
  return 0;
}
