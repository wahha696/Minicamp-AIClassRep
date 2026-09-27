// 清理任务（FR-10.3 + FR-16）：
// 1. sent_at 早于 RAW_MSG_TTL_DAYS 且已处理的原始消息 → 先把 (group_id, message_id, sent_at) 写进
//    message_seen 再删——message_seen 是「处理过」的证据，30 天刷新再拉到时不重复整理；
// 2. 超过 45 天仍未处理的消息强制删除（同样先写 message_seen）；
// 3. message_seen 里 sent_at 早于 40 天的行删掉（表不能无限长）。
// event_sources 里存的是快照，不受影响。
import { beginTx, commitTx, db, rollbackTx } from '../db/index.js';
import { env } from '../env.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HARD_KEEP_DAYS = 45; // 未处理消息的强删线
const SEEN_KEEP_DAYS = 40; // message_seen 保留天数

/** 清理一次，返回删掉的原始消息数。`now` 可注入，方便测试。 */
export function cleanupOnce(now: number = Date.now()): number {
  const ttlDays = env.RAW_MSG_TTL_DAYS;
  const cutoff = now - ttlDays * DAY_MS;
  const hardCutoff = now - HARD_KEEP_DAYS * DAY_MS;
  const seenCutoff = now - SEEN_KEEP_DAYS * DAY_MS;

  let removed = 0;
  beginTx();
  try {
    // 过期且已处理，或超过 45 天还没处理（可能一直没轮到）：都先记 message_seen 再删
    const stale = db
      .prepare(
        'SELECT group_id, message_id, sent_at FROM messages WHERE (sent_at < ? AND processed = 1) OR sent_at < ?',
      )
      .all(cutoff, hardCutoff) as unknown as { group_id: string; message_id: string; sent_at: number }[];
    if (stale.length) {
      const markSeen = db.prepare(
        'INSERT OR IGNORE INTO message_seen (group_id, message_id, sent_at) VALUES (?, ?, ?)',
      );
      // messages 主键是 (group_id, message_id)（schema v2）：删除要带上群，免得误删别群同 id 的消息
      const del = db.prepare('DELETE FROM messages WHERE group_id = ? AND message_id = ?');
      for (const m of stale) {
        markSeen.run(m.group_id, m.message_id, m.sent_at);
        del.run(m.group_id, m.message_id);
      }
      removed = stale.length;
    }
    db.prepare('DELETE FROM message_seen WHERE sent_at < ?').run(seenCutoff);
    commitTx();
  } catch (e) {
    rollbackTx();
    throw e;
  }

  if (removed > 0) {
    console.log(`已清理 ${removed} 条原始消息（已处理且超过 ${ttlDays} 天，或超过 ${HARD_KEEP_DAYS} 天未处理）`);
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
