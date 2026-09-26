// 清理任务：删 sent_at 早于 RAW_MSG_TTL_DAYS 天的原始消息（FR-10.3）。
// event_sources 里存的是快照，不受影响。
import { db } from '../db/index.js';
import { env } from '../env.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 清理一次，返回删掉的行数。`now` 可注入，方便测试。 */
export function cleanupOnce(now: number = Date.now()): number {
  const ttlDays = env.RAW_MSG_TTL_DAYS;
  const cutoff = now - ttlDays * DAY_MS;
  const res = db.prepare('DELETE FROM messages WHERE sent_at < ?').run(cutoff);
  const removed = Number(res.changes);
  if (removed > 0) {
    console.log(`已清理 ${removed} 条超过 ${ttlDays} 天的原始消息`);
  }
  return removed;
}

/** 启动时跑一次，之后每小时一次。定时器 unref()，不挡进程退出。 */
export function startCleanupJob(): void {
  try {
    cleanupOnce();
  } catch (err) {
    console.error(`清理任务首次执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const timer = setInterval(() => {
    try {
      cleanupOnce();
    } catch (err) {
      console.error(`清理任务执行失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, HOUR_MS);
  timer.unref();
}
