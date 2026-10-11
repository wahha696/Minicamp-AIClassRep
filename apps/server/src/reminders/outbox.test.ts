import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultReminderRules } from '../../../../shared/reminders.js';
import { db, openDb } from '../db/index.js';
import { groupReminderNodes, planDeadlineReminders } from './plan.js';
import { ReminderOutbox } from './outbox.js';
const now = Date.parse('2026-10-10T08:00:00Z');
const scope = { spaceId: 'synthetic-space', targetId: 'synthetic-target' };
const rules = { ...defaultReminderRules(), enabled: true, before_minutes: [120] };
const budget = { now, budgetDay: '2026-10-10', dailyLimit: 1 };
const directories: string[] = [];
beforeEach(() => openDb(':memory:'));
afterEach(() => { db.close(); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function seed(id: number, deadline = now + 3600_000) {
  db.prepare("INSERT INTO events(id,group_id,type,title,status,confidence,deadline_at,created_at,updated_at) VALUES(?,'synthetic','assignment','人工作业','active',1,?,1,1)").run(id, deadline);
}
function nodes(ids: number[], settledKeys?: Set<string>) {
  return planDeadlineReminders({ ...scope, rules, now, settledKeys,
    events: ids.map(id => ({ id, version: 1, status: 'active', deadline_at: now + 3600_000 })) }).nodes;
}
it('同一时刻多件合为一个尝试；失败也占额度，不影响其他收件人的独立额度', () => {
  [1, 2, 3].forEach(id => seed(id));
  const outbox = new ReminderOutbox(scope.spaceId, scope.targetId);
  const group = groupReminderNodes(nodes([1, 2]))[0]!;
  const result = outbox.reserve(group.nodes, budget); expect(result.status).toBe('reserved');
  if (result.status !== 'reserved') throw new Error();
  outbox.recordOutcome(result.attempt.id, 'failed', null);
  expect(outbox.reserve(nodes([3]), budget)).toEqual({ status: 'quota' });
  const other = new ReminderOutbox(scope.spaceId, 'other-recipient');
  expect(other.reserve(nodes([3]).map(node => ({ ...node, target_id: 'other-recipient' })), budget).status).toBe('reserved');
});
it('写前确认事项版本、完成状态和截止；已过期不占额度', () => {
  seed(1); seed(2); seed(3); const outbox = new ReminderOutbox(scope.spaceId, scope.targetId);
  db.exec("UPDATE events SET version=2 WHERE id=1; UPDATE events SET status='done' WHERE id=2;");
  expect(outbox.reserve(nodes([1]), budget)).toEqual({ status: 'stale' });
  expect(outbox.reserve(nodes([2]), budget)).toEqual({ status: 'stale' });
  expect(outbox.reserve(nodes([3]), { ...budget, now: now + 3600_000 })).toEqual({ status: 'stale' });
  expect(outbox.list()).toHaveLength(0);
});
it('进程在请求后崩溃或结果未知，重开仍不能重复发送；受理不伪装到达', () => {
  const directory = mkdtempSync(join(tmpdir(), 'classrep-outbox-')); directories.push(directory);
  const path = join(directory, 'test.db'); openDb(path); seed(1);
  const old = new ReminderOutbox(scope.spaceId, scope.targetId);
  const result = old.reserve(nodes([1]), budget); expect(result.status).toBe('reserved');
  openDb(path); expect(() => old.list()).toThrow('REMINDER_SPACE_CHANGED');
  const resumed = new ReminderOutbox(scope.spaceId, scope.targetId);
  expect(resumed.reserve(nodes([1]), budget).status).toBe('existing');
  expect(nodes([1], resumed.settledKeys())).toHaveLength(0);
  if (result.status !== 'reserved') throw new Error();
  resumed.recordOutcome(result.attempt.id, 'accepted', 'synthetic-receipt');
  expect(resumed.list()[0]!.state).toBe('accepted');
  resumed.recordOutcome(result.attempt.id, 'unknown', null);
  expect(nodes([1], resumed.settledKeys())).toHaveLength(0);
});
it('提交失败不占用额度或确认节点，换空间和混合目标明确拒绝', () => {
  seed(1); const outbox = new ReminderOutbox(scope.spaceId, scope.targetId);
  db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON kv BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  expect(() => outbox.reserve(nodes([1]), budget)).toThrow();
  expect(outbox.list()).toHaveLength(0); expect(db.isTransaction).toBe(false);
  db.exec('DROP TRIGGER synthetic_failure');
  expect(() => outbox.reserve(nodes([1]).map(node => ({ ...node, space_id: 'other-space' })), budget)).toThrow('REMINDER_RESERVATION_INVALID');
  expect(outbox.reserve(nodes([1]), budget).status).toBe('reserved');
  openDb(':memory:'); expect(() => outbox.settledKeys()).toThrow('REMINDER_SPACE_CHANGED');
});
it('损坏的投递记录阻止新尝试，不能当作从未发送', () => {
  seed(1); const outbox = new ReminderOutbox(scope.spaceId, scope.targetId);
  outbox.reserve(nodes([1]), budget);
  db.exec("UPDATE kv SET value='damaged' WHERE key GLOB 'reminder_attempt_v1:*'");
  expect(() => outbox.reserve(nodes([1]), budget)).toThrow('REMINDER_OUTBOX_INVALID');
  expect(db.isTransaction).toBe(false);
});
