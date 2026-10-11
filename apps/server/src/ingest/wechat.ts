// Internal opt-in receiver only. No HTTP route, process scan, polling or auto-login.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { accountDataState, accountEpoch } from '../accounts.js';
import { beginTx, commitTx, db, dbGeneration, rollbackTx } from '../db/index.js';
import { ingestMessagesInTransaction } from './index.js';

const text = (maxBytes: number) => z.string().refine(
  (s) => Buffer.byteLength(s, 'utf8') <= maxBytes && Buffer.from(s, 'utf8').toString('utf8') === s,
);
const itemSchema = z.object({
  event_id: z.string().regex(/^[a-f0-9]{64}$/),
  group_id: z.string().regex(/^[\w-]+@chatroom$/),
  group_name: text(4096),
  sender_name: text(4096),
  text: text(262144),
  sent_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const batchSchema = z.object({
  version: z.literal(1),
  destination: text(256).refine((s) => s.trim().length > 0),
  wechat_account: text(256).refine((s) => s.trim().length > 0),
  batch_id: z.string().regex(/^[a-f0-9]{64}$/),
  messages: z.array(itemSchema).min(1).max(100),
}).strict();
export type WechatDelivery = z.infer<typeof batchSchema>;
export interface WechatAcknowledgement {
  version: 1;
  destination: string;
  wechat_account: string;
  batch_id: string;
  event_ids: string[];
  accepted: true;
  inserted: number;
  replayed: boolean;
}

export class WechatDeliveryError extends Error {
  constructor(code: string) { super(code); this.name = 'WechatDeliveryError'; }
}

function digest(fields: string[]): string {
  const hash = createHash('sha256');
  for (const value of fields) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

export function wechatGroupId(account: string, group: string): string {
  return `wechat:${digest(['wechat-group-v1', account, group])}`;
}

export function wechatBatchId(batch: Pick<WechatDelivery, 'destination' | 'wechat_account' | 'messages'>): string {
  return digest(['wechat-delivery-v1', batch.destination, batch.wechat_account,
    String(batch.messages.length), ...batch.messages.flatMap((m) => [
      m.event_id, m.group_id, m.group_name, m.sender_name, m.text, String(m.sent_at),
    ])]);
}

/** Captures this exact DB generation; caller supplies an explicitly selected workspace. */
export function bindWechatDestination(destination: string, wechatAccount: string, groups: readonly string[]) {
  if (!text(256).refine((s) => s.trim().length > 0).safeParse(destination).success
      || !text(256).refine((s) => s.trim().length > 0).safeParse(wechatAccount).success
      || !groups.length || new Set(groups).size !== groups.length
      || groups.some((g) => !/^[\w-]+@chatroom$/.test(g)) || !db?.isOpen
      || accountDataState() !== 'ready') {
    throw new WechatDeliveryError('WECHAT_EXPLICIT_BINDING_REQUIRED');
  }
  const target = db;
  const generation = dbGeneration();
  const epoch = accountEpoch();
  const selected = new Set(groups);

  return (input: unknown): WechatAcknowledgement => {
    const parsed = batchSchema.safeParse(input);
    if (!parsed.success) throw new WechatDeliveryError('WECHAT_DELIVERY_INVALID');
    const batch = parsed.data;
    if (db !== target || dbGeneration() !== generation || !target.isOpen
        || accountDataState() !== 'ready' || accountEpoch() !== epoch) {
      throw new WechatDeliveryError('WECHAT_DESTINATION_CHANGED');
    }
    if (batch.destination !== destination || batch.wechat_account !== wechatAccount
        || batch.messages.some((m) => !selected.has(m.group_id))) {
      throw new WechatDeliveryError('WECHAT_DELIVERY_SCOPE_MISMATCH');
    }
    const eventIds = batch.messages.map((m) => m.event_id);
    if (new Set(eventIds).size !== eventIds.length || batch.batch_id !== wechatBatchId(batch)
        || batch.messages.reduce((sum, m) => sum + Buffer.byteLength(m.text), 0) > 1048576) {
      throw new WechatDeliveryError('WECHAT_DELIVERY_DIGEST_OR_LIMIT');
    }
    // Never let a nested call commit a caller's transaction and acknowledge early.
    if (target.isTransaction) throw new WechatDeliveryError('WECHAT_OUTER_TRANSACTION');
    let inserted = 0;
    let replayed = false;
    beginTx();
    try {
      const existing = target.prepare(`SELECT message_count FROM wechat_delivery_batches
        WHERE destination=? AND wechat_account=? AND batch_id=?`).get(destination, wechatAccount, batch.batch_id);
      if (existing) {
        if (existing.message_count !== batch.messages.length) {
          throw new WechatDeliveryError('WECHAT_RECEIPT_CONFLICT');
        }
        replayed = true;
      } else {
        for (const m of batch.messages) {
          const group = target.prepare('SELECT enabled,adapter FROM groups WHERE group_id=?')
            .get(wechatGroupId(wechatAccount, m.group_id));
          if (!group || group.enabled !== 1 || group.adapter !== 'wechat') {
            throw new WechatDeliveryError('WECHAT_GROUP_NOT_ENABLED');
          }
        }
        inserted = ingestMessagesInTransaction(batch.messages.map((m) => ({
          message_id: `wechat:${m.event_id}`,
          group_id: wechatGroupId(wechatAccount, m.group_id),
          group_name: m.group_name,
          sender_name: m.sender_name,
          text: m.text,
          sent_at: m.sent_at,
        })), 'wechat').inserted;
        target.prepare(`INSERT INTO wechat_delivery_batches
          (destination,wechat_account,batch_id,message_count,created_at) VALUES (?,?,?,?,?)`)
          .run(destination, wechatAccount, batch.batch_id, batch.messages.length, Date.now());
      }
      commitTx();
    } catch (error) {
      rollbackTx();
      if (error instanceof WechatDeliveryError) throw error;
      throw new WechatDeliveryError('WECHAT_DELIVERY_NOT_COMMITTED');
    }
    return { version: 1, destination, wechat_account: wechatAccount, batch_id: batch.batch_id,
      event_ids: eventIds, accepted: true, inserted, replayed };
  };
}
