import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WechatCatalog } from './wechat-catalog.js';
import type { WechatReadContext } from './wechat-group-selection.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const context = { account: 'wxid_synthetic_catalog', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
  let current: WechatReadContext | null = context;
  const groups = [{ group_id: 'a@chatroom', name: '人工群 😀' }];
  const read = vi.fn(async (_context: WechatReadContext, _signal: AbortSignal) => groups);
  const revalidate = vi.fn(async () => true);
  const catalog = new WechatCatalog({ current: () => current, read, revalidate });
  return { catalog, context, groups, read, revalidate, current: (value: WechatReadContext | null) => { current = value; } };
}

describe('opt-in catalog coordination (synthetic reads only)', () => {
  it('retains the last good offer and scope when a same-root refresh fails', async () => {
    const f = fixture(); const root = 'C:\\synthetic\\xwechat_files';
    const offer = await f.catalog.refresh(f.context.epoch, true, true, root);
    const scope = await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    f.read.mockRejectedValueOnce(new Error('synthetic read failure'));
    await expect(f.catalog.refresh(f.context.epoch, true, true, root)).rejects.toThrow('WORKER_FAILED');
    expect(f.catalog.status().state).toBe('error');
    expect(f.catalog.catalog()?.catalog_id).toBe(offer.catalog_id);
    expect(f.catalog.selectedScope()).toBe(scope);
    expect(await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom'])).toBe(scope);
  });
  it('preserves an unchanged scope on success but rejects old selection pages after publishing', async () => {
    const f = fixture(); const root = 'C:\\synthetic\\xwechat_files';
    const offer = await f.catalog.refresh(f.context.epoch, true, true, root);
    const scope = await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    const reading = deferred<typeof f.groups>(); f.read.mockReturnValueOnce(reading.promise);
    const work = f.catalog.refresh(f.context.epoch, true, true, root);
    expect(f.catalog.selectedScope()).toBe(scope);
    await expect(f.catalog.select(offer.catalog_id, f.context.epoch, [])).rejects.toThrow('BUSY');
    reading.resolve(f.groups); const replacement = await work;
    expect(f.catalog.selectedScope()).toBe(scope);
    expect(replacement.catalog_id).not.toBe(offer.catalog_id);
    await expect(f.catalog.select(offer.catalog_id, f.context.epoch, [])).rejects.toThrow('NOT_CURRENT');
  });
  it('immediately revokes an old root and does not restore it after replacement read failure', async () => {
    const f = fixture(); const offer = await f.catalog.refresh(f.context.epoch, true, true, 'C:\\old\\xwechat_files');
    await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    f.read.mockRejectedValueOnce(new Error('synthetic failure'));
    const work = f.catalog.refresh(f.context.epoch, true, true, 'C:\\new\\xwechat_files');
    expect(f.catalog.selectedScope()).toBeNull(); expect(f.catalog.catalog()).toBeNull();
    await expect(work).rejects.toThrow('WORKER_FAILED');
    expect(f.catalog.selectedScope()).toBeNull();
  });
  it('does not retain a previous scope when the refresh cannot obtain current identity proof', async () => {
    const f = fixture(); const root = 'C:\\synthetic\\xwechat_files';
    const offer = await f.catalog.refresh(f.context.epoch, true, true, root);
    await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    f.revalidate.mockResolvedValueOnce(false);
    await expect(f.catalog.refresh(f.context.epoch, true, true, root)).rejects.toThrow('NOT_CURRENT');
    expect(f.catalog.selectedScope()).toBeNull(); expect(f.catalog.catalog()).toBeNull();
  });
  it('keeps the prior offer usable after rejecting an oversized replacement catalog', async () => {
    const f = fixture(); const root = 'C:\\synthetic\\xwechat_files';
    const offer = await f.catalog.refresh(f.context.epoch, true, true, root);
    const scope = await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    f.read.mockResolvedValueOnce(Array.from({ length: 1000 }, (_, i) => ({ group_id: `group${i}@chatroom`, name: 'x'.repeat(2048) })));
    await expect(f.catalog.refresh(f.context.epoch, true, true, root)).rejects.toThrow();
    expect(f.catalog.selectedScope()).toBe(scope);
    expect(await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom'])).toBe(scope);
  });
  it.each(['account', 'epoch', 'connectionId'])('revokes retained scopes on %s changes during refresh', async field => {
    const f = fixture(); const root = 'C:\\synthetic\\xwechat_files';
    const offer = await f.catalog.refresh(f.context.epoch, true, true, root);
    await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    const reading = deferred<typeof f.groups>(); f.read.mockReturnValueOnce(reading.promise);
    const work = f.catalog.refresh(f.context.epoch, true, true, root);
    const rejected = expect(work).rejects.toThrow('NOT_CURRENT'); await Promise.resolve();
    f.current({ ...f.context, [field]: field === 'account' ? 'wxid_other' : field === 'connectionId' ? randomUUID() : 'other-epoch' });
    expect(f.catalog.selectedScope()).toBeNull(); expect(f.catalog.catalog()).toBeNull();
    reading.resolve(f.groups); await rejected;
    expect(f.catalog.selectedScope()).toBeNull();
  });
  it('drops removed groups only after the refreshed catalog has been verified', async () => {
    const f = fixture(); const root = 'C:\\synthetic\\xwechat_files';
    const offer = await f.catalog.refresh(f.context.epoch, true, true, root);
    await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    const reading = deferred<typeof f.groups>(); f.read.mockReturnValueOnce(reading.promise);
    const work = f.catalog.refresh(f.context.epoch, true, true, root);
    expect(f.catalog.selectedGroupIds()).toEqual(['a@chatroom']);
    reading.resolve([]); await work;
    expect(f.catalog.selectedGroupIds()).toEqual([]);
  });
  it('unchanged confirmation preserves the live scope and does not save or stop intake', async () => {
    const f = fixture(), save = vi.fn();
    const catalog = new WechatCatalog({ current: () => f.context, read: f.read, revalidate: f.revalidate, saveSelection: save });
    const offer = await catalog.refresh(f.context.epoch, true, true);
    const scope = await catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    expect(save).toHaveBeenCalledOnce();
    const proofCalls = f.revalidate.mock.calls.length;
    expect(await catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom'])).toBe(scope);
    expect(catalog.selectedScope()).toBe(scope);
    expect(save).toHaveBeenCalledOnce();
    expect(f.revalidate).toHaveBeenCalledTimes(proofCalls + 1);
    f.revalidate.mockResolvedValueOnce(false);
    await expect(catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom'])).rejects.toThrow('NOT_CURRENT');
  });
  it('rebases the same source onto a new same-space epoch without rereading contacts or resetting selection', async () => {
    const f = fixture(); const offer = await f.catalog.refresh(f.context.epoch, true, true, 'C:\\synthetic\\xwechat_files');
    await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    const next = { ...f.context, epoch: 'synthetic-next-epoch' }; f.current(next);
    const proof = deferred<boolean>(); f.revalidate.mockReturnValueOnce(proof.promise);
    const rebased = f.catalog.rebase(next);
    // Polling during revalidation cannot prune the already-owned same-space scope.
    expect(f.catalog.selectedGroupIds()).toEqual(['a@chatroom']);
    expect(f.catalog.catalog()?.catalog_id).not.toBe(offer.catalog_id);
    proof.resolve(true); expect(await rebased).toBe(true);
    expect(f.catalog.selectedScope()).toMatchObject({ epoch: next.epoch, dataRoot: 'C:\\synthetic\\xwechat_files' });
    expect(f.read).toHaveBeenCalledTimes(1);
    await expect(f.catalog.select(offer.catalog_id, f.context.epoch, [])).rejects.toThrow('NOT_CURRENT');
  });
  it('does not rebase a replacement identity source or retain a scope after failed fresh proof', async () => {
    const f = fixture(); const offer = await f.catalog.refresh(f.context.epoch, true, true);
    await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    const other = { ...f.context, connectionId: randomUUID(), epoch: 'other' }; f.current(other);
    expect(await f.catalog.rebase(other)).toBe(false);
    const next = { ...f.context, epoch: 'next' }; f.current(next); f.revalidate.mockResolvedValueOnce(false);
    expect(await f.catalog.rebase(next)).toBe(false); expect(f.catalog.selectedScope()).toBeNull();
  });
  it('refresh restores only remembered IDs present in the fresh catalog without saving or activating', async () => {
    const f = fixture(); const save = vi.fn(); const remember = vi.fn(() => ['a@chatroom', 'missing@chatroom']);
    const catalog = new WechatCatalog({ current: () => f.context, read: f.read, revalidate: f.revalidate,
      remembered: remember, saveSelection: save });
    await catalog.refresh(f.context.epoch, true, true);
    expect(catalog.selectedGroupIds()).toEqual(['a@chatroom']);
    expect(save).not.toHaveBeenCalled(); expect(remember).toHaveBeenCalledOnce();
    expect(catalog.status().collecting).toBe(false);
  });
  it('failed durable save does not publish a successful new selection', async () => {
    const f = fixture();
    const catalog = new WechatCatalog({ current: () => f.context, read: f.read, revalidate: f.revalidate,
      saveSelection: () => { throw new Error('WECHAT_SELECTION_SAVE_FAILED'); } });
    const offer = await catalog.refresh(f.context.epoch, true, true);
    await expect(catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom'])).rejects.toThrow('SAVE_FAILED');
    expect(catalog.selectedGroupIds()).toEqual([]);
  });
  it('status and construction do not read; consent and stale epoch fail before identity or contact access', async () => {
    const f = fixture();
    expect(f.catalog.status()).toEqual({ state: 'idle', error: null, collecting: false });
    expect(f.catalog.catalog()).toBeNull();
    for (const [epoch, key, contact] of [['old', true, true], [f.context.epoch, false, true], [f.context.epoch, true, false]] as const) {
      await expect(f.catalog.refresh(epoch, key, contact)).rejects.toThrow();
    }
    expect(f.revalidate).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it('provides an isolated catalog then freshly rechecks selection without starting message intake', async () => {
    const f = fixture(); const offer = await f.catalog.refresh(f.context.epoch, true, true);
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.revalidate).toHaveBeenCalledTimes(2);
    expect(f.catalog.status()).toMatchObject({ state: 'ready', collecting: false });
    offer.groups[0]!.name = 'modified response';
    const result = await f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    expect(result.groups).toEqual(f.groups); expect(f.revalidate).toHaveBeenCalledTimes(3);
    expect(f.catalog.selectedGroupIds()).toEqual(['a@chatroom']);
    const copy = f.catalog.catalog()!; copy.groups[0]!.group_id = 'guessed@chatroom';
    await expect(f.catalog.select(copy.catalog_id, f.context.epoch, ['guessed@chatroom'])).rejects.toThrow('WECHAT_GROUP_SELECTION_INVALID');
    expect((await f.catalog.select(copy.catalog_id, f.context.epoch, [])).groups).toEqual([]);
    expect(f.catalog.selectedGroupIds()).toEqual([]);
  });
  it('a second click cannot start another scan while the owned reader is running', async () => {
    const f = fixture(); const reading = deferred<typeof f.groups>(); f.read.mockReturnValueOnce(reading.promise);
    const work = f.catalog.refresh(f.context.epoch, true, true); await Promise.resolve();
    expect(f.catalog.status().state).toBe('reading');
    await expect(f.catalog.refresh(f.context.epoch, true, true)).rejects.toThrow('WECHAT_CATALOG_BUSY');
    expect(f.read).toHaveBeenCalledTimes(1);
    reading.resolve(f.groups); await work;
  });
  it('logout cancels a job, waits for reader cleanup before another scan and discards delayed groups', async () => {
    const f = fixture(); const reading = deferred<typeof f.groups>(); f.read.mockReturnValueOnce(reading.promise);
    const old = f.catalog.refresh(f.context.epoch, true, true);
    const rejected = expect(old).rejects.toThrow('WECHAT_CATALOG_NOT_CURRENT'); await Promise.resolve();
    const signal = f.read.mock.calls[0]![1];
    f.current(null); f.catalog.invalidate(); expect(signal.aborted).toBe(true);
    f.current({ ...f.context, connectionId: randomUUID() });
    expect(f.catalog.status().state).toBe('stopping');
    await expect(f.catalog.refresh(f.context.epoch, true, true)).rejects.toThrow('WECHAT_CATALOG_BUSY');
    expect(f.read).toHaveBeenCalledTimes(1);
    reading.resolve(f.groups); await rejected;
    expect(f.catalog.catalog()).toBeNull();
    const latest = await f.catalog.refresh(f.context.epoch, true, true);
    expect(f.catalog.catalog()?.catalog_id).toBe(latest.catalog_id);
  });
  it.each(['account', 'epoch', 'connectionId'])('never selects across a %s change while revalidation waits', async (field) => {
    const f = fixture(); const offer = await f.catalog.refresh(f.context.epoch, true, true);
    const check = deferred<boolean>(); f.revalidate.mockReturnValueOnce(check.promise);
    const pending = f.catalog.select(offer.catalog_id, f.context.epoch, ['a@chatroom']);
    const rejected = expect(pending).rejects.toThrow('WECHAT_CATALOG_NOT_CURRENT');
    f.current({ ...f.context, [field]: field === 'account' ? 'wxid_other' : field === 'connectionId' ? randomUUID() : 'new-epoch' });
    check.resolve(true); await rejected; expect(f.catalog.catalog()).toBeNull();
  });
  it('handles an unavailable proof or a reader failure as an error rather than an empty successful catalog', async () => {
    const f = fixture(); f.revalidate.mockResolvedValueOnce(false);
    await expect(f.catalog.refresh(f.context.epoch, true, true)).rejects.toThrow('WECHAT_CATALOG_NOT_CURRENT');
    expect(f.read).not.toHaveBeenCalled();
    f.read.mockRejectedValueOnce(new Error('private path / account'));
    await expect(f.catalog.refresh(f.context.epoch, true, true)).rejects.toThrow('WECHAT_CATALOG_WORKER_FAILED');
    expect(f.catalog.status()).toMatchObject({ state: 'error', error: 'WECHAT_CATALOG_WORKER_FAILED' });
    const offer = await f.catalog.refresh(f.context.epoch, true, true);
    expect(offer.groups).toEqual(f.groups);
  });
});
