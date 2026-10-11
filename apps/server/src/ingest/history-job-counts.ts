import { db } from '../db/index.js';

/** Called only inside the verified WeChat business-delivery transaction. The
 * progress count commits with the actual messages, even if the IPC reply dies. */
export function recordHistoryJobMessages(id: string, groupId: string, inserted: number): void {
  if (!db.isTransaction) throw new Error('HISTORY_COUNT_TRANSACTION_REQUIRED');
  if (!inserted) return;
  const row = db.prepare("SELECT value FROM kv WHERE key='history_job_v1:wechat'").get();
  if (typeof row?.value !== 'string') throw new Error('HISTORY_COUNT_TASK_MISSING');
  const job = JSON.parse(row.value);
  const group = Array.isArray(job.groups) ? job.groups.find((g: { group_id: string }) => g.group_id === groupId) : undefined;
  if (job.id !== id || !['running', 'cancelling'].includes(job.status) || !group || job.current_group_id !== groupId) {
    throw new Error('HISTORY_COUNT_TASK_CHANGED');
  }
  group.messages += inserted; job.messages += inserted; job.updated_at = Date.now();
  db.prepare("UPDATE kv SET value=? WHERE key='history_job_v1:wechat'").run(JSON.stringify(job));
}
