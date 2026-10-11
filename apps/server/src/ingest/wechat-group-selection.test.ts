import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WechatGroupSelection, type WechatReadContext } from './wechat-group-selection.js';

function fixture() {
  const context = { account: 'wxid_synthetic_group_selection', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
  let current: WechatReadContext | null = context;
  const catalog = new WechatGroupSelection(() => current);
  const groups = [{ group_id: 'synthetic_a@chatroom', name: '同名课程群' }, { group_id: 'synthetic_b@chatroom', name: '同名课程群' }];
  return { context, groups, catalog, current: (value: WechatReadContext | null) => { current = value; } };
}

describe('memory-only selected WeChat scope (no reader or business writes)', () => {
  it('same-named groups remain distinct; empty selection cannot authorize any message read', () => {
    const f = fixture(); const offer = f.catalog.publish(f.context, f.groups);
    expect(f.catalog.select(offer.catalog_id, f.context.epoch, [f.groups[1]!.group_id]).groups).toEqual([f.groups[1]]);
    expect(f.catalog.select(offer.catalog_id, f.context.epoch, []).groups).toEqual([]);
  });
  it('a published response cannot mutate the internally verified group list', () => {
    const f = fixture(); const offer = f.catalog.publish(f.context, f.groups);
    (offer.groups[0] as { group_id: string }).group_id = 'injected@chatroom';
    expect(() => f.catalog.select(offer.catalog_id, f.context.epoch, ['injected@chatroom'])).toThrow('WECHAT_GROUP_SELECTION_INVALID');
    expect(Object.isFrozen(f.catalog.select(offer.catalog_id, f.context.epoch, [f.groups[0]!.group_id]).groups)).toBe(true);
  });
  it.each(['account', 'connectionId', 'epoch', 'logout'])('drops a stale offer after %s changes', (field) => {
    const f = fixture(); const offer = f.catalog.publish(f.context, f.groups);
    f.current(field === 'logout' ? null : { ...f.context,
      ...(field === 'account' ? { account: 'wxid_synthetic_other' } : field === 'connectionId' ? { connectionId: randomUUID() } : { epoch: 'new-epoch' }) });
    expect(() => f.catalog.select(offer.catalog_id, f.context.epoch, [f.groups[0]!.group_id])).toThrow('WECHAT_CATALOG_NOT_CURRENT');
    f.current(f.context);
    expect(() => f.catalog.select(offer.catalog_id, f.context.epoch, [])).toThrow('WECHAT_CATALOG_NOT_CURRENT');
  });
  it('does not accept private contacts, duplicate IDs, guessed groups or extra private fields', () => {
    const f = fixture();
    for (const rows of [[{ group_id: 'wxid_private', name: 'private' }], [f.groups[0], f.groups[0]],
      [{ ...f.groups[0], body: 'private text' }]]) {
      expect(() => f.catalog.publish(f.context, rows)).toThrow('WECHAT_CATALOG_NOT_CURRENT');
    }
    const offer = f.catalog.publish(f.context, f.groups);
    expect(() => f.catalog.select(offer.catalog_id, f.context.epoch, ['guessed@chatroom'])).toThrow('WECHAT_GROUP_SELECTION_INVALID');
    expect(() => f.catalog.select(offer.catalog_id, f.context.epoch, [f.groups[0]!.group_id, f.groups[0]!.group_id])).toThrow('WECHAT_GROUP_SELECTION_INVALID');
  });
  it('new catalog generation invalidates an earlier selection form, and delayed old jobs cannot publish', () => {
    const f = fixture(); const old = f.catalog.publish(f.context, f.groups);
    const newer = f.catalog.publish(f.context, f.groups);
    expect(newer.catalog_id).not.toBe(old.catalog_id);
    expect(() => f.catalog.select(old.catalog_id, f.context.epoch, [])).toThrow('WECHAT_CATALOG_NOT_CURRENT');
    expect(f.catalog.select(newer.catalog_id, f.context.epoch, []).groups).toEqual([]);
    f.current({ ...f.context, connectionId: randomUUID() });
    expect(() => f.catalog.publish(f.context, f.groups)).toThrow('WECHAT_CATALOG_NOT_CURRENT');
  });
});
