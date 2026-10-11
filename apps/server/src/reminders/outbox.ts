import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, dbGeneration } from '../db/index.js';
import type { ReminderNode } from './plan.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = z.string().regex(/^[a-f0-9]{64}$/);
const nodeSchema = z.object({ key, event_id: z.number().int().positive(), event_version: z.number().int().positive(),
  deadline_at: z.number().int().nonnegative(), covered_keys: z.array(key).min(1).max(16) }).strict();
const recordSchema = z.object({ version: z.literal(1), scope: key, id: key, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  attempted_at: z.number().int().nonnegative(), remind_at: z.number().int(),
  state: z.enum(['sending', 'accepted', 'channel_reported_sent', 'failed', 'unknown']),
  receipt: z.string().min(1).max(512).nullable(), nodes: z.array(nodeSchema).min(1).max(1000),
}).strict();
type Record = z.infer<typeof recordSchema>;
export type ReminderAttemptState = Record['state'];
export type ReminderReservation = { status: 'reserved' | 'existing'; attempt: Record }
  | { status: 'quota' | 'stale' | 'already_settled' };

/** Inert local ledger; no timer or transport. Reserve durably BEFORE a request.
 * A crash/unknown result stays settled and must never trigger blind re-sending.
 * The sender supplies its budget date explicitly; this layer invents no timezone.
 */
export class ReminderOutbox {
  private readonly target: typeof db;
  private readonly generation: number;
  private readonly scope: string;
  private readonly prefix: string;
  constructor(private readonly space: string, private readonly recipient: string) {
    this.target = db; this.generation = dbGeneration();
    if (!space.trim() || !recipient.trim() || space.length > 256 || recipient.length > 256 || !this.target?.isOpen) throw new Error('REMINDER_SCOPE_INVALID');
    this.scope = digest([space, recipient]); this.prefix = `reminder_attempt_v1:${this.scope}:`;
  }
  private check(): void {
    if (db !== this.target || dbGeneration() !== this.generation || !this.target.isOpen) throw new Error('REMINDER_SPACE_CHANGED');
  }
  list(): Record[] {
    this.check();
    try {
      return this.target.prepare('SELECT key,value FROM kv WHERE key GLOB ?').all(this.prefix + '*').map(row => {
        if (typeof row.value !== 'string' || Buffer.byteLength(row.value) > 1024 * 1024) throw new Error();
        const record = recordSchema.parse(JSON.parse(row.value));
        if (record.scope !== this.scope || row.key !== this.prefix + record.id
          || record.id !== digest(record.nodes.map(node => node.key).sort())) throw new Error();
        return record;
      });
    } catch { throw new Error('REMINDER_OUTBOX_INVALID'); }
  }
  settledKeys(): Set<string> { return new Set(this.list().flatMap(record => record.nodes.flatMap(node => node.covered_keys))); }

  reserve(nodes: ReminderNode[], input: { now: number; budgetDay: string; dailyLimit: number }): ReminderReservation {
    this.check();
    if (!Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(input.dailyLimit) || input.dailyLimit <= 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(input.budgetDay) || !nodes.length || nodes.length > 1000
      || new Set(nodes.map(node => node.key)).size !== nodes.length
      || nodes.some(node => node.space_id !== this.space || node.target_id !== this.recipient
        || !Number.isSafeInteger(node.remind_at) || node.remind_at > input.now || node.remind_at !== nodes[0]!.remind_at
        || !Number.isSafeInteger(node.event_id) || !Number.isSafeInteger(node.event_version))) throw new Error('REMINDER_RESERVATION_INVALID');
    if (this.target.isTransaction) throw new Error('REMINDER_OUTBOX_OUTER_TRANSACTION');
    const id = digest(nodes.map(node => node.key).sort());
    const record = recordSchema.parse({ version: 1, scope: this.scope, id, day: input.budgetDay, attempted_at: input.now,
      remind_at: nodes[0]!.remind_at, state: 'sending', receipt: null,
      nodes: nodes.map(node => ({ key: node.key, event_id: node.event_id, event_version: node.event_version,
        deadline_at: node.deadline_at, covered_keys: node.covered_keys })),
    });
    this.target.exec('BEGIN IMMEDIATE');
    try {
      const result = this.reserveInTransaction(record, input.dailyLimit, input.now);
      this.target.exec('COMMIT'); return result;
    } catch (error) { this.target.exec('ROLLBACK'); throw error; }
  }
  private reserveInTransaction(record: Record, limit: number, now: number): ReminderReservation {
    const previous = this.list(); const existing = previous.find(value => value.id === record.id);
    if (existing) return { status: 'existing', attempt: existing };
    const settled = new Set(previous.flatMap(value => value.nodes.flatMap(node => node.covered_keys)));
    if (record.nodes.some(node => node.covered_keys.some(value => settled.has(value)))) return { status: 'already_settled' };
    const current = this.target.prepare('SELECT version,status,deadline_at FROM events WHERE id=?');
    for (const node of record.nodes) {
      const event = current.get(node.event_id);
      if (!event || event.version !== node.event_version || event.status !== 'active'
        || event.deadline_at !== node.deadline_at || node.deadline_at <= now) return { status: 'stale' };
    }
    // One aggregate is one attempted request. Failures and unknown outcomes count.
    if (previous.filter(value => value.day === record.day).length >= limit) return { status: 'quota' };
    const value = JSON.stringify(record);
    if (Buffer.byteLength(value) > 1024 * 1024) throw new Error('REMINDER_ATTEMPT_TOO_LARGE');
    this.target.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run(this.prefix + record.id, value);
    return { status: 'reserved', attempt: record };
  }
  recordOutcome(id: string, state: Exclude<ReminderAttemptState, 'sending'>, receipt: string | null): void {
    this.check();
    if (!key.safeParse(id).success || !['accepted', 'channel_reported_sent', 'failed', 'unknown'].includes(state)
      || (receipt !== null && (typeof receipt !== 'string' || !receipt.length || receipt.length > 512))) throw new Error('REMINDER_OUTCOME_INVALID');
    if (this.target.isTransaction) throw new Error('REMINDER_OUTBOX_OUTER_TRANSACTION');
    this.target.exec('BEGIN IMMEDIATE');
    try {
      const record = this.list().find(value => value.id === id);
      if (!record) throw new Error('REMINDER_ATTEMPT_MISSING');
      if ((record.state === 'channel_reported_sent' || record.state === 'failed') && record.state !== state) throw new Error('REMINDER_OUTCOME_FINAL');
      if (record.receipt && receipt && record.receipt !== receipt) throw new Error('REMINDER_RECEIPT_MISMATCH');
      record.state = state; record.receipt = receipt ?? record.receipt;
      this.target.prepare('UPDATE kv SET value=? WHERE key=?').run(JSON.stringify(record), this.prefix + id);
      this.target.exec('COMMIT');
    } catch (error) { this.target.exec('ROLLBACK'); throw error; }
  }
}
