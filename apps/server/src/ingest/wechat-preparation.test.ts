import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceController } from '../workspaces/controller.js';
import { WechatPreparation } from './wechat-preparation.js';
import { wechatGroupId } from './wechat.js';
import type { WechatStoredGroup } from './wechat-selection-store.js';

function fixture(groupIds = ['synthetic@chatroom']) {
  const account = 'wxid_synthetic_preparation';
  let epoch = 'synthetic-epoch'; let admitted: string | null = null; let ticket = true;
  let revoked: (() => Promise<unknown> | void) | undefined;
  let recheck: () => Promise<boolean> = async () => ticket;
  const workspace = { currentSpaceId: () => admitted ? 'synthetic-space' : null, currentWechat: () => admitted,
    observe: vi.fn(async () => 'pending'), revoke: vi.fn(async () => { admitted = null; }) };
  const sourceKey = randomUUID();
  const rows: WechatStoredGroup[] = groupIds.map((group_id) => ({ group_id, name: '人工群', enabled: false,
    activation_id: randomUUID(), pending: 'first', activated: false }));
  const read = vi.fn(async () => rows.map(({ group_id, name }) => ({ group_id, name })));
  const intake = vi.fn(); const launch = vi.fn((settings) => {
    revoked = () => settings.onRevoked(account, sourceKey, 'identity_unavailable');
    return { sourceKey, verifies: () => ticket, revalidate: () => recheck(),
      start: async () => settings.onVerified(account, sourceKey),
      close: async () => settings.onRevoked(account, sourceKey, 'manual_close') };
  });
  const preparation = new WechatPreparation({ root: 'unused', epoch: () => epoch,
    workspace: () => workspace as unknown as WorkspaceController, createSession: launch,
    stopWechatIntake: intake, readCatalog: read, selectionStore: () => ({ list: () => rows, apply: (scope) => {
      for (const row of rows) row.enabled = scope.groups.some((group) => group.group_id === row.group_id);
    } }) });
  return { preparation, read, intake, launch, account, admit: (value: string | null = account) => { admitted = value; },
    epoch: (value: string) => { epoch = value; }, ticket: (value: boolean) => { ticket = value; },
    recheck: (value: () => Promise<boolean>) => { recheck = value; }, revoke: () => revoked?.() };
}
const root = 'E:\\synthetic\\xwechat_files';
describe('inert connection/catalog composition, synthetic only', () => {
  it('concurrent incremental group changes retain every save, including all-off and all-on', async () => {
    const ids = ['a@chatroom', 'b@chatroom'], f = fixture(ids);
    await f.preparation.connection.connect('synthetic-epoch', true); f.admit();
    const offer = await f.preparation.catalog.refresh('synthetic-epoch', true, true, root);
    await f.preparation.catalog.select(offer.catalog_id, 'synthetic-epoch', ids);
    let release!: (value: boolean) => void;
    let checks = 0;
    f.recheck(() => { checks++; return checks === 1 ? new Promise((done) => { release = done; }) : Promise.resolve(true); });
    const off = ids.map((id) => f.preparation.setGroupEnabled(wechatGroupId(f.account, id), false));
    await vi.waitFor(() => expect(checks).toBe(1));
    release(true); await Promise.all(off);
    expect(f.preparation.catalog.selectedGroupIds()).toEqual([]);
    await Promise.all(ids.map((id) => f.preparation.setGroupEnabled(wechatGroupId(f.account, id), true)));
    expect(f.preparation.catalog.selectedGroupIds().sort()).toEqual(ids);
    expect(f.preparation.collectingGroupIds()).toEqual([]);
    await f.preparation.stop();
  });
  it('queued group changes cannot apply to a replacement catalog after a space transition', async () => {
    const ids = ['a@chatroom', 'b@chatroom'], f = fixture(ids);
    await f.preparation.connection.connect('synthetic-epoch', true); f.admit();
    const offer = await f.preparation.catalog.refresh('synthetic-epoch', true, true, root);
    await f.preparation.catalog.select(offer.catalog_id, 'synthetic-epoch', ids);
    let release!: (value: boolean) => void;
    f.recheck(() => new Promise((done) => { release = done; }));
    const jobs = ids.map((id) => f.preparation.setGroupEnabled(wechatGroupId(f.account, id), false));
    const results = Promise.allSettled(jobs);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.epoch('other-space'); f.preparation.invalidate(); release(true);
    expect((await results).every((result) => result.status === 'rejected')).toBe(true);
    expect(f.preparation.catalog.selectedGroupIds()).toEqual([]);
    await f.preparation.stop();
  });
  it('never starts on construction or status, and pending or wrong-space accounts cannot read contacts', async () => {
    const f = fixture(); expect(f.preparation.connection.status().state).toBe('idle');
    expect(f.preparation.catalog.catalog()).toBeNull(); expect(f.launch).not.toHaveBeenCalled();
    await f.preparation.connection.connect('synthetic-epoch', true);
    await expect(f.preparation.catalog.refresh('synthetic-epoch', true, true, root)).rejects.toThrow('WECHAT_CATALOG_NOT_CURRENT');
    f.admit('wxid_other');
    await expect(f.preparation.catalog.refresh('synthetic-epoch', true, true, root)).rejects.toThrow('WECHAT_CATALOG_NOT_CURRENT');
    expect(f.read).not.toHaveBeenCalled(); await f.preparation.stop();
  });
  it('only explicitly refreshes the chosen root after admission and rejects invalid roots before reading', async () => {
    const f = fixture(); await f.preparation.connection.connect('synthetic-epoch', true); f.admit();
    for (const value of ['relative/xwechat_files', '\\\\server\\xwechat_files', 'E:\\other', 'E:\\xwechat_files\0']) {
      await expect(f.preparation.catalog.refresh('synthetic-epoch', true, true, value)).rejects.toThrow('WECHAT_CATALOG_METADATA_INVALID');
    }
    expect(f.read).not.toHaveBeenCalled();
    const offer = await f.preparation.catalog.refresh('synthetic-epoch', true, true, root);
    expect(f.read).toHaveBeenCalledWith({ account: f.account, connectionId: expect.any(String), epoch: 'synthetic-epoch' }, expect.any(AbortSignal), root);
    f.ticket(false); // Routine sampling invalidates only the operation ticket.
    expect(f.preparation.catalog.catalog()?.catalog_id).toBe(offer.catalog_id);
    f.ticket(true);
    await f.preparation.catalog.select(offer.catalog_id, 'synthetic-epoch', ['synthetic@chatroom']);
    expect(f.preparation.catalog.selectedScope()).toMatchObject({ dataRoot: root, account: f.account });
    expect(Object.isFrozen(f.preparation.catalog.selectedScope())).toBe(true);
    await f.preparation.stop(); expect(f.preparation.catalog.selectedScope()).toBeNull();
  });
  it('fresh proof cannot authorize a different space selected while rechecking', async () => {
    const f = fixture(); await f.preparation.connection.connect('synthetic-epoch', true); f.admit();
    f.recheck(async () => { f.epoch('new-space-epoch'); return true; });
    await expect(f.preparation.catalog.refresh('synthetic-epoch', true, true, root)).rejects.toThrow('WECHAT_CATALOG_NOT_CURRENT');
    expect(f.read).not.toHaveBeenCalled(); await f.preparation.stop();
  });
  it('space invalidation drops selection and stops intake while retaining identity monitoring', async () => {
    const f = fixture(); await f.preparation.connection.connect('synthetic-epoch', true); f.admit();
    const offer = await f.preparation.catalog.refresh('synthetic-epoch', true, true, root);
    await f.preparation.catalog.select(offer.catalog_id, 'synthetic-epoch', ['synthetic@chatroom']);
    f.intake.mockClear();
    f.preparation.invalidate();
    expect(f.intake).toHaveBeenCalledOnce();
    expect(f.preparation.catalog.selectedScope()).toBeNull();
    expect(f.preparation.catalog.catalog()).toBeNull();
    expect(f.preparation.connection.source()?.account).toBe(f.account);
    expect(f.preparation.connection.status().state).toBe('identified');
    await f.preparation.stop();
  });
  it('revocation cancels the catalog immediately and shutdown waits for its worker cleanup', async () => {
    const f = fixture(); await f.preparation.connection.connect('synthetic-epoch', true); f.admit();
    let release!: () => void;
    f.read.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    const pending = f.preparation.catalog.refresh('synthetic-epoch', true, true, root);
    const rejected = expect(pending).rejects.toThrow('WECHAT_CATALOG_NOT_CURRENT');
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    const signal = (f.read.mock.calls[0] as unknown as [unknown, AbortSignal])[1];
    await f.revoke(); expect(signal.aborted).toBe(true); expect(f.intake).toHaveBeenCalled();
    let closed = false; const stopping = f.preparation.stop().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await rejected; await stopping; expect(closed).toBe(true);
    expect(f.preparation.catalog.catalog()).toBeNull();
  });
});
