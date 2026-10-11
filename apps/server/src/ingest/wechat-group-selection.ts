import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export interface WechatReadContext { account: string; connectionId: string; epoch: string }
export interface WechatGroup { group_id: string; name: string | null }
export interface WechatSelectedScope extends WechatReadContext { groups: readonly Readonly<WechatGroup>[] }
const group = z.object({ group_id: z.string().regex(/^[\w-]+@chatroom$/),
  name: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 4096).nullable() }).strict();
const context = z.object({ account: z.string().regex(/^wxid_[A-Za-z0-9_-]{1,120}$/),
  connectionId: z.string().uuid(), epoch: z.string().min(1).max(200) }).strict();
const entries = z.array(group).max(10000).refine((rows) => new Set(rows.map((item) => item.group_id)).size === rows.length);

/** RAM-only offers from an owned catalog job. No files, history, DB or AI.
 * A selection authorizes a group scope only; it does not itself start a collector.
 */
export class WechatGroupSelection {
  private offer: { id: string; context: WechatReadContext; groups: WechatGroup[] } | null = null;
  constructor(private readonly current: () => WechatReadContext | null) {}

  private same(expected: WechatReadContext): boolean {
    const current = this.current();
    return current !== null && current.account === expected.account
      && current.connectionId === expected.connectionId && current.epoch === expected.epoch;
  }
  publish(ownedJobContext: WechatReadContext, input: unknown): { catalog_id: string; groups: readonly WechatGroup[] } {
    const source = context.safeParse(ownedJobContext); const parsed = entries.safeParse(input);
    if (!source.success || !parsed.success || !this.same(source.data)) {
      if (this.offer && !this.same(this.offer.context)) this.clear();
      throw new Error('WECHAT_CATALOG_NOT_CURRENT');
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > 1048576) {
      this.clear(); throw new Error('WECHAT_CATALOG_LIMIT');
    }
    this.offer = { id: randomUUID(), context: { ...source.data }, groups: parsed.data };
    return { catalog_id: this.offer.id, groups: this.offer.groups.map((row) => ({ ...row })) };
  }

  select(catalogId: string, expectedEpoch: string, groupIds: readonly string[]): WechatSelectedScope {
    const offer = this.offer;
    if (!offer || offer.id !== catalogId || offer.context.epoch !== expectedEpoch || !this.same(offer.context)) {
      if (offer && !this.same(offer.context)) this.clear();
      throw new Error('WECHAT_CATALOG_NOT_CURRENT');
    }
    if (!Array.isArray(groupIds) || groupIds.length > 10000 || new Set(groupIds).size !== groupIds.length) {
      throw new Error('WECHAT_GROUP_SELECTION_INVALID');
    }
    const available = new Map(offer.groups.map((row) => [row.group_id, row]));
    const selected = groupIds.map((id) => {
      const row = available.get(id);
      if (!row) throw new Error('WECHAT_GROUP_SELECTION_INVALID');
      return Object.freeze({ ...row });
    });
    // Empty selection is permitted: it authorizes no message reads.
    return Object.freeze({ ...offer.context, groups: Object.freeze(selected) });
  }
  clear(): void { this.offer = null; }
}
