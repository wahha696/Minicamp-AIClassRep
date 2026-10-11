import { createHash } from 'node:crypto';
import { getLlmConfig } from '../ai-settings.js';
import { beginTx, commitTx, db, dbGeneration, rollbackTx } from '../db/index.js';
import type { GroupProcessingFailureDTO, ProcessingFailureReason } from '../types.js';

// 用户已确认：连续失败三次暂停该群；手动重试或修改 AI 配置后可恢复。
export const MAX_FAILED_ATTEMPTS = 3;
export const LLM_RETRY_MS = 60_000;

interface FailureRow {
  group_id: string;
  reason: ProcessingFailureReason;
  failed_attempts: number;
  last_failed_at: number;
  next_retry_at: number;
  config_fingerprint: string;
}

// 写库失败时仍在当前进程控制重试；此兜底严格跟随数据库代次，不能串号。
let fallbackGeneration = -1;
const fallback = new Map<string, FailureRow>();
function fallbackForCurrentDb(): Map<string, FailureRow> {
  if (fallbackGeneration !== dbGeneration()) {
    fallback.clear();
    fallbackGeneration = dbGeneration();
  }
  return fallback;
}

/** 仅用于判断配置是否真正改变；不持久化密钥本身，也不把指纹返回前端。 */
export function llmConfigFingerprint(): string {
  const cfg = getLlmConfig();
  return createHash('sha256').update(JSON.stringify([cfg.baseURL, cfg.model, cfg.apiKey])).digest('hex');
}

function readFailure(groupId: string): FailureRow | undefined {
  const cached = fallbackForCurrentDb().get(groupId);
  if (cached) return cached;
  return db.prepare('SELECT * FROM pipeline_failures WHERE group_id = ?').get(groupId) as FailureRow | undefined;
}

function writeFailure(row: FailureRow): void {
  const cached = fallbackForCurrentDb();
  const ownTransaction = !db.isTransaction;
  try {
    if (ownTransaction) beginTx();
    db.prepare(`INSERT INTO pipeline_failures
      (group_id, reason, failed_attempts, last_failed_at, next_retry_at, config_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET reason = excluded.reason,
        failed_attempts = excluded.failed_attempts, last_failed_at = excluded.last_failed_at,
        next_retry_at = excluded.next_retry_at, config_fingerprint = excluded.config_fingerprint`)
      .run(row.group_id, row.reason, row.failed_attempts, row.last_failed_at, row.next_retry_at, row.config_fingerprint);
    db.prepare('UPDATE messages SET keep_until_processed = 1 WHERE group_id = ? AND processed = 0')
      .run(row.group_id);
    if (ownTransaction) commitTx();
    cached.delete(row.group_id);
  } catch {
    if (ownTransaction) rollbackTx();
    cached.set(row.group_id, row);
    console.warn('[pipeline] 失败状态无法写入数据库，当前进程继续控制重试');
  }
}

export function recordGroupFailure(groupId: string, reason: ProcessingFailureReason, fingerprint: string): void {
  let previous: FailureRow | undefined;
  try { previous = readFailure(groupId); } catch { previous = fallbackForCurrentDb().get(groupId); }
  const failedAttempts = previous?.config_fingerprint === fingerprint ? previous.failed_attempts + 1 : 1;
  const now = Date.now();
  writeFailure({
    group_id: groupId, reason, failed_attempts: failedAttempts, last_failed_at: now,
    next_retry_at: now + LLM_RETRY_MS, config_fingerprint: fingerprint,
  });
}

/** 保留失败记录用于展示与保护消息，仅重新开始尝试计数和等待。 */
export function resetGroupFailure(groupId: string, fingerprint = llmConfigFingerprint()): void {
  const row = readFailure(groupId);
  if (row) writeFailure({ ...row, failed_attempts: 0, next_retry_at: 0, config_fingerprint: fingerprint });
}

export function clearGroupFailure(groupId: string): void {
  // 首批恢复时也将内存兜底的保护落到剩余消息，避免清掉失败状态后丢失积压保护。
  if (readFailure(groupId)) {
    db.prepare('UPDATE messages SET keep_until_processed = 1 WHERE group_id = ? AND processed = 0').run(groupId);
  }
  db.prepare('DELETE FROM pipeline_failures WHERE group_id = ?').run(groupId);
  fallbackForCurrentDb().delete(groupId);
}

/** 检查实际时间；调度器的测试 now 参数只影响攒批阈值，不绕过失败等待。 */
export function groupCanRetry(groupId: string, fingerprint: string): boolean {
  const row = readFailure(groupId);
  if (!row) return true;
  if (row.config_fingerprint !== fingerprint) {
    resetGroupFailure(groupId, fingerprint);
    return true;
  }
  return row.failed_attempts < MAX_FAILED_ATTEMPTS && Date.now() >= row.next_retry_at;
}

export function getGroupFailure(groupId: string): GroupProcessingFailureDTO | null {
  const row = readFailure(groupId);
  if (!row) return null;
  const pending = (db.prepare('SELECT COUNT(*) n FROM messages WHERE group_id = ? AND processed = 0')
    .get(groupId) as { n: number }).n;
  if (pending === 0) return null;
  const paused = row.failed_attempts >= MAX_FAILED_ATTEMPTS;
  return {
    pending_count: pending, failed_attempts: row.failed_attempts, reason: row.reason, paused,
    next_retry_at: paused ? null : row.next_retry_at || null, last_failed_at: row.last_failed_at,
    state_saved: !fallbackForCurrentDb().has(groupId),
  };
}

/** 即使无法保存失败记录，当前进程的清理任务也应保护这些群的积压。 */
export function unsavedFailureGroupIds(): string[] {
  return [...fallbackForCurrentDb().keys()];
}

/** 仅供测试重置等待，不改变暂停状态。 */
export function resetRetryWaitForTest(): void {
  db.prepare('UPDATE pipeline_failures SET next_retry_at = 0').run();
  for (const [id, row] of fallbackForCurrentDb()) fallback.set(id, { ...row, next_retry_at: 0 });
}
