import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { WechatIntake } from './wechat-intake.js';
import { WechatSelectionStore } from './wechat-selection-store.js';
import type { WechatMessageChannel } from './wechat-message-channel.js';

const directories: string[] = [];
beforeEach(() => { openDb(':memory:'); });
afterEach(() => {
  vi.useRealTimers(); if (db.isOpen) db.close();
  for (const directory of directories.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(directory));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('TEST_CLEANUP_PATH');
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture(groupIds = ['synthetic@chatroom']) {
  const folder = mkdtempSync(join(tmpdir(), 'synthetic-intake-controller-')); directories.push(folder);
  const context = { account: 'wxid_synthetic_controller', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
  const selected = Object.freeze({ ...context, dataRoot: 'C:\\synthetic\\xwechat_files', groups: groupIds.map(group_id => ({ group_id, name: '人工群' })) });
  let current: typeof context | null = context;
  let scope: typeof selected | null = selected;
  const store = new WechatSelectionStore('synthetic-space', context.account, () => current);
  store.apply(selected, groupIds);
  const counts = Object.fromEntries(groupIds.map(group => [group, { pending: 0, deferred: 0 }]));
  const channel = { start: vi.fn(async () => counts), close: vi.fn(async () => {}),
    tick: vi.fn(async () => ({ saved: {}, delivered: {}, status: counts })), status: vi.fn(async () => counts),
    history: vi.fn(async () => ({ inserted: 100, has_more: true })),
    historyNext: vi.fn(async () => ({ inserted: 5, has_more: false })),
    issues: vi.fn(async () => []), retryIssues: vi.fn(async () => counts) };
  let settings: ConstructorParameters<typeof WechatMessageChannel>[0] | null = null;
  const create = vi.fn((opts: ConstructorParameters<typeof WechatMessageChannel>[0]) => { settings = opts; return channel; });
  const revalidate = vi.fn(async () => true);
  const controller = new WechatIntake({ root: 'C:\\synthetic', current: () => current, selected: () => scope,
    destination: () => 'synthetic-space', revalidate, createChannel: create, receiptRoot: () => folder,
    runtime: () => ({ executable: 'unused.exe', entry: 'C:\\synthetic\\identity_worker.py' }) });
  return { controller, channel, create, revalidate, context, store, settings: () => settings!,
    revoke: () => { current = null; }, clearSelection: () => { scope = null; } };
}

describe('selected-message collector lifecycle (synthetic only)', () => {
  it('does not create a worker until explicit storage/key/message approval', async () => {
    const f = fixture(); expect(f.controller.status().collecting).toBe(false); expect(f.create).not.toHaveBeenCalled();
    await expect(f.controller.start(f.context.epoch, true, true, false)).rejects.toThrow('CONSENT_REQUIRED');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('rejects stale activation and delivery after cancellation, preserving desired tokens', async () => {
    const f = fixture(); await f.controller.start(f.context.epoch, true, true, true);
    expect(f.controller.status().collecting).toBe(true);
    const row = f.store.list()[0]!;
    f.settings().activated(row.group_id, row.activation_id); expect(f.store.list()[0]?.pending).toBe(null);
    f.controller.invalidate();
    expect(() => f.settings().activated(row.group_id, row.activation_id)).toThrow('NOT_CURRENT');
    expect(() => f.settings().receive({})).toThrow('NOT_CURRENT');
    expect(f.settings().signal.aborted).toBe(true); await f.controller.stop();
    expect(f.channel.close).toHaveBeenCalledTimes(1);
  });
  it('cancels an opening request before source creation when paused during identity proof', async () => {
    const f = fixture(); let resolve!: (value: boolean) => void;
    f.revalidate.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const opening = f.controller.start(f.context.epoch, true, true, true);
    const rejected = expect(opening).rejects.toThrow('NOT_CURRENT');
    await vi.waitFor(() => expect(f.revalidate).toHaveBeenCalled());
    f.controller.invalidate(); resolve(true); await rejected;
    expect(f.create).not.toHaveBeenCalled();
  });
  it('waits for the owned previous worker before reopening its progress files', async () => {
    const f = fixture(); await f.controller.start(f.context.epoch, true, true, true);
    let release!: () => void;
    f.channel.close.mockReturnValueOnce(new Promise<void>((done) => { release = done; }));
    f.controller.invalidate();
    const opening = f.controller.start(f.context.epoch, true, true, true);
    await Promise.resolve(); expect(f.create).toHaveBeenCalledTimes(1);
    release(); await opening; expect(f.create).toHaveBeenCalledTimes(2); await f.controller.stop();
  });
  it('pages manual history without resetting the cursor or silently rereading page one', async () => {
    const f = fixture(); await f.controller.start(f.context.epoch, true, true, true);
    const id = f.controller.status().intake_id!;
    expect(await f.controller.history(f.context.epoch, id, 'synthetic@chatroom', 7, true)).toEqual({ inserted: 100, has_more: true });
    expect(await f.controller.history(f.context.epoch, id, 'synthetic@chatroom', 7, true, true)).toEqual({ inserted: 5, has_more: false });
    expect(f.channel.history).toHaveBeenCalledTimes(1); expect(f.channel.historyNext).toHaveBeenCalledTimes(1);
    await expect(f.controller.history(f.context.epoch, id, 'synthetic@chatroom', 7, true, true)).rejects.toThrow('REQUEST_INVALID');
    await f.controller.stop();
  });
  it('skips a group whose history read fails by reopening collection from saved progress', async () => {
    const f = fixture(); await f.controller.start(f.context.epoch, true, true, true);
    const id = f.controller.status().intake_id!;
    f.channel.history.mockRejectedValueOnce(new Error('WECHAT_MESSAGE_SELECTED_GROUP_NOT_FOUND'));
    const page = await f.controller.history(f.context.epoch, id, 'synthetic@chatroom', 7, true);
    const next = f.controller.status();
    expect(page).toEqual({ inserted: 0, has_more: false, skipped: 'WECHAT_MESSAGE_SELECTED_GROUP_NOT_FOUND', intake_id: next.intake_id });
    expect(next.collecting).toBe(true); expect(next.intake_id).not.toBe(id); expect(next.error).toBe(null);
    expect(f.create).toHaveBeenCalledTimes(2); expect(f.channel.close).toHaveBeenCalledTimes(1);
    await f.controller.stop();
  });
  it('reports history failure when collection cannot be reopened or the account changed', async () => {
    const f = fixture(); await f.controller.start(f.context.epoch, true, true, true);
    f.channel.history.mockRejectedValueOnce(new Error('WECHAT_MESSAGE_SELECTED_GROUP_NOT_FOUND'));
    f.channel.start.mockRejectedValueOnce(new Error('WECHAT_MESSAGE_LOCAL_RECEIPT_ACTIVATION_MISMATCH'));
    await expect(f.controller.history(f.context.epoch, f.controller.status().intake_id!, 'synthetic@chatroom', 7, true)).rejects.toThrow('WECHAT_HISTORY_FAILED');
    expect(f.controller.status().collecting).toBe(false);
    await f.controller.start(f.context.epoch, true, true, true);
    f.channel.history.mockRejectedValueOnce(new Error('WECHAT_MESSAGE_NOT_CURRENT'));
    await expect(f.controller.history(f.context.epoch, f.controller.status().intake_id!, 'synthetic@chatroom', 7, true)).rejects.toThrow('WECHAT_HISTORY_FAILED');
    expect(f.create).toHaveBeenCalledTimes(3);
    await f.controller.stop();
  });
  it('continues a healthy group with the new intake after a preceding group times out', async () => {
    const f = fixture(['synthetic@chatroom', 'healthy@chatroom']);
    await f.controller.start(f.context.epoch, true, true, true);
    const oldId = f.controller.status().intake_id!;
    f.channel.history.mockRejectedValueOnce(new Error('WECHAT_MESSAGE_TIMEOUT'));
    const skipped = await f.controller.history(f.context.epoch, oldId, 'synthetic@chatroom', 7, true);
    expect(skipped.skipped).toBe('WECHAT_MESSAGE_TIMEOUT');
    expect(skipped.intake_id).not.toBe(oldId);
    f.channel.history.mockResolvedValueOnce({ inserted: 2, has_more: false });
    expect(await f.controller.history(f.context.epoch, skipped.intake_id!, 'healthy@chatroom', 7, true))
      .toEqual({ inserted: 2, has_more: false });
    await expect(f.controller.history(f.context.epoch, oldId, 'healthy@chatroom', 7, true)).rejects.toThrow('NOT_CURRENT');
    await f.controller.stop();
  });
  it('does not restart collection after the user stops an in-flight history page', async () => {
    const f = fixture(); await f.controller.start(f.context.epoch, true, true, true);
    let rejectPage!: (error: Error) => void;
    f.channel.history.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectPage = reject; }));
    const page = f.controller.history(f.context.epoch, f.controller.status().intake_id!, 'synthetic@chatroom', 7, true);
    const rejected = expect(page).rejects.toThrow('WECHAT_HISTORY_FAILED');
    await f.controller.stop();
    rejectPage(new Error('WECHAT_MESSAGE_CLOSED'));
    await rejected;
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.controller.status()).toMatchObject({ state: 'idle', collecting: false });
  });
  it('does not let an old history failure stop a replacement collector', async () => {
    const f = fixture(); await f.controller.start(f.context.epoch, true, true, true);
    let rejectPage!: (error: Error) => void;
    f.channel.history.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectPage = reject; }));
    const page = f.controller.history(f.context.epoch, f.controller.status().intake_id!, 'synthetic@chatroom', 7, true);
    const rejected = expect(page).rejects.toThrow('WECHAT_HISTORY_FAILED');
    await f.controller.stop();
    await f.controller.start(f.context.epoch, true, true, true);
    const replacement = f.controller.status().intake_id;
    rejectPage(new Error('WECHAT_MESSAGE_TIMEOUT'));
    await rejected;
    expect(f.controller.status()).toMatchObject({ collecting: true, intake_id: replacement, error: null });
    expect(f.create).toHaveBeenCalledTimes(2);
    await f.controller.stop();
  });
});
