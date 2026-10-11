// Desired selected groups only. This record never authorizes account access or
// starts a source reader. Activation tokens must be committed with source cursors.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, dbGeneration } from '../db/index.js';
import { wechatGroupId } from './wechat.js';
import type { WechatSelectedScope, WechatReadContext } from './wechat-group-selection.js';

const text = (max: number) => z.string().refine((value) => Buffer.byteLength(value) <= max
  && Buffer.from(value).toString('utf8') === value);
const rowSchema = z.object({ group_id: z.string().regex(/^[\w-]+@chatroom$/), name: text(4096).nullable(),
  enabled: z.boolean(), activation_id: z.string().uuid(),
  pending: z.enum(['first', 'reenable']).nullable(), activated: z.boolean() }).strict();
const stateSchema = z.object({ version: z.literal(1), destination: text(256), account: text(256),
  groups: z.array(rowSchema).max(10000) }).strict();
export type WechatStoredGroup = z.infer<typeof rowSchema>;
type State = z.infer<typeof stateSchema>;

/** Binds the exact workspace DB and current admitted identity. Callers still
 * obtain fresh identity before applying a catalog selection; remembered data
 * alone cannot authorize a read. No I/O on construction beyond binding handles.
 */
export class WechatSelectionStore {
  private readonly target: typeof db;
  private readonly generation: number;
  private readonly key: string;
  constructor(private readonly destination: string, private readonly account: string,
              private readonly current: () => WechatReadContext | null) {
    this.target = db; this.generation = dbGeneration();
    if (!text(256).safeParse(destination).success || !destination.trim()
        || !/^wxid_[A-Za-z0-9_-]{1,120}$/.test(account) || !this.target?.isOpen) {
      throw new Error('WECHAT_SELECTION_SCOPE_INVALID');
    }
    this.key = 'wechat_selection_v1:' + createHash('sha256').update(JSON.stringify([destination, account])).digest('hex');
  }
  private check(expected?: WechatReadContext): void {
    const now = this.current();
    if (db !== this.target || dbGeneration() !== this.generation || !this.target.isOpen
        || !now || now.account !== this.account || (expected && (now.account !== expected.account
          || now.connectionId !== expected.connectionId || now.epoch !== expected.epoch))) {
      throw new Error('WECHAT_SELECTION_NOT_CURRENT');
    }
  }
  private read(): State {
    this.check();
    const value = this.target.prepare('SELECT value FROM kv WHERE key=?').get(this.key)?.value;
    if (value === undefined) return { version: 1, destination: this.destination, account: this.account, groups: [] };
    try {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 4194304) throw new Error();
      const state = stateSchema.parse(JSON.parse(value));
      if (state.account !== this.account || state.destination !== this.destination
          || new Set(state.groups.map((group) => group.group_id)).size !== state.groups.length
          || state.groups.some((group) => (group.pending === null && !group.activated)
            || (group.pending === 'first' && group.activated)
            || (group.pending === 'reenable' && !group.activated))) throw new Error();
      return state;
    } catch { throw new Error('WECHAT_SELECTION_STATE_INVALID'); }
  }
  list(): WechatStoredGroup[] { return this.read().groups; }
  private write(work: (state: State) => void): void {
    this.check();
    if (this.target.isTransaction) throw new Error('WECHAT_SELECTION_OUTER_TRANSACTION');
    this.target.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read(); work(state);
      const value = JSON.stringify(state);
      if (Buffer.byteLength(value) > 4194304 || state.groups.length > 10000) throw new Error('WECHAT_SELECTION_LIMIT');
      this.target.prepare('INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key, value);
      this.target.exec('COMMIT');
    } catch (error) {
      this.target.exec('ROLLBACK');
      if (error instanceof Error && error.message.startsWith('WECHAT_SELECTION_')) throw error;
      throw new Error('WECHAT_SELECTION_SAVE_FAILED');
    }
  }
  apply(scope: WechatSelectedScope, availableGroupIds: readonly string[]): void {
    this.check(scope);
    const selected = z.array(rowSchema.pick({ group_id: true, name: true })).max(10000).safeParse(scope.groups);
    const available = new Set(availableGroupIds);
    if (!selected.success || available.size !== availableGroupIds.length || available.size > 10000
        || availableGroupIds.some((id) => !/^[\w-]+@chatroom$/.test(id))
        || new Set(selected.data.map((group) => group.group_id)).size !== selected.data.length
        || selected.data.some((group) => !available.has(group.group_id))) {
      throw new Error('WECHAT_SELECTION_SCOPE_INVALID');
    }
    this.write((state) => {
      const previous = new Map(state.groups.map((group) => [group.group_id, group]));
      const wanted = new Set(selected.data.map((group) => group.group_id));
      for (const group of state.groups) {
        if (available.has(group.group_id) && !wanted.has(group.group_id)) {
          group.enabled = false;
          this.target.prepare('UPDATE groups SET enabled=0 WHERE group_id=? AND adapter=?')
            .run(wechatGroupId(this.account, group.group_id), 'wechat');
        }
      }
      for (const group of selected.data) {
        let row = previous.get(group.group_id);
        if (!row) {
          row = { ...group, enabled: true, activation_id: randomUUID(), pending: 'first', activated: false };
          state.groups.push(row);
        } else {
          if (!row.enabled) {
            row.activation_id = randomUUID();
            row.pending = row.activated ? 'reenable' : 'first';
          }
          row.enabled = true; row.name = group.name;
        }
        const id = wechatGroupId(this.account, group.group_id);
        const known = this.target.prepare('SELECT adapter FROM groups WHERE group_id=?').get(id);
        if (known && known.adapter !== 'wechat') throw new Error('WECHAT_SELECTION_GROUP_CONFLICT');
        this.target.prepare(`INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES (?,?,1,'wechat',?)
          ON CONFLICT(group_id) DO UPDATE SET name=excluded.name,enabled=1`).run(id, group.name ?? group.group_id, Date.now());
      }
    });
  }
  /** Internal collector acknowledgement ONLY after its receipt activation token
   * and baseline have committed atomically. Stale activations cannot clear a
   * newer re-enable. Repeating the same acknowledgement is harmless.
   */
  activated(context: WechatReadContext, groupId: string, activationId: string): void {
    this.check(context);
    this.write((state) => {
      const group = state.groups.find((row) => row.group_id === groupId);
      if (!group?.enabled || group.activation_id !== activationId) throw new Error('WECHAT_SELECTION_ACTIVATION_STALE');
      group.pending = null; group.activated = true;
    });
  }
}
