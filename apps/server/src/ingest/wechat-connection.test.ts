import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WechatConnection } from './wechat-connection.js';
import type { WechatIdentitySession } from './wechat-identity-session.js';
import type { WorkspaceController } from '../workspaces/controller.js';

type Settings = ConstructorParameters<typeof WechatIdentitySession>[0];
const connections: WechatConnection[] = [];
afterEach(async () => { for (const connection of connections.splice(0)) await connection.stop(); });
function fixture() {
  let epoch = 'synthetic-epoch-1';
  const account = 'wxid_synthetic_connection';
  const runtime = { observe: vi.fn(async () => 'pending'), revoke: vi.fn(async () => true) };
  const stop = vi.fn();
  const sessions: { settings: Settings; sourceKey: string; live: boolean; start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  const create = vi.fn((settings: Settings) => {
    const item = { settings, sourceKey: randomUUID(), live: false,
      start: vi.fn(), close: vi.fn() };
    item.start.mockImplementation(async () => { item.live = true; await settings.onVerified(account, item.sourceKey); });
    item.close.mockImplementation(async () => {
      if (!item.live) return;
      item.live = false;
      await settings.onRevoked(account, item.sourceKey, 'manual_close');
    });
    sessions.push(item);
    return { ...item, verifies: (value: string) => item.live && value === account,
      revalidate: async (value: string) => item.live && value === account };
  });
  const connection = new WechatConnection({ root: 'unused synthetic', epoch: () => epoch,
    workspace: () => runtime as unknown as WorkspaceController, stopWechatIntake: stop, createSession: create });
  connections.push(connection);
  return { connection, runtime, sessions, account, create, stop, epoch: (next: string) => { epoch = next; } };
}

describe('explicit WeChat connection coordinator (synthetic sessions)', () => {
  it('construction/status do no reads, and consent or stale epoch fail before creating a worker', async () => {
    const f = fixture(); expect(f.connection.status()).toMatchObject({ state: 'idle', collecting: false });
    expect(f.create).not.toHaveBeenCalled();
    await expect(f.connection.connect('synthetic-epoch-1', false)).rejects.toThrow('WECHAT_IDENTITY_CONSENT_REQUIRED');
    await expect(f.connection.connect('old', true)).rejects.toThrow('WECHAT_CONNECTION_STALE');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.connection.stop()).toBeInstanceOf(Promise);
  });
  it('only the owned verified session supplies an account to the workspace', async () => {
    const f = fixture(); await f.connection.connect('synthetic-epoch-1', true);
    const current = f.sessions[0]!;
    expect(f.runtime.observe).toHaveBeenCalledWith({ platform: 'wechat', account_id: f.account }, current.sourceKey);
    expect(f.connection.status()).toEqual({ state: 'identified', collecting: false, connection_id: current.sourceKey, error: null });
    expect(f.connection.verifies(f.account)).toBe(true); expect(f.connection.verifies('wxid_other')).toBe(false);
    expect(await f.connection.revalidate(f.account)).toBe(true);
    await expect(f.connection.connect('synthetic-epoch-1', true)).rejects.toThrow('WECHAT_CONNECTION_ALREADY_OPEN');
  });
  it('distinguishes stable source ownership from a ticket suspended during a fresh sample, and clears both on revocation', async () => {
    const f = fixture(); await f.connection.connect('synthetic-epoch-1', true);
    const session = f.sessions[0]!;
    session.live = false; // Synthetic temporary unavailable operation ticket.
    expect(f.connection.identity()).toBeNull(); expect(await f.connection.revalidate(f.account)).toBe(false);
    expect(f.connection.source()).toEqual({ account: f.account, connectionId: session.sourceKey });
    session.live = true;
    await session.settings.onRevoked(f.account, session.sourceKey, 'identity_unavailable');
    expect(f.connection.source()).toBeNull(); expect(f.connection.identity()).toBeNull();
  });
  it('old epoch or connection ID cannot disconnect a newer connection', async () => {
    const f = fixture(); await f.connection.connect('synthetic-epoch-1', true);
    await expect(f.connection.disconnect('old', f.sessions[0]!.sourceKey)).rejects.toThrow('WECHAT_CONNECTION_STALE');
    await expect(f.connection.disconnect('synthetic-epoch-1', randomUUID())).rejects.toThrow('WECHAT_CONNECTION_STALE');
    expect(f.connection.verifies(f.account)).toBe(true);
    await f.connection.disconnect('synthetic-epoch-1', f.sessions[0]!.sourceKey);
    expect(f.connection.verifies(f.account)).toBe(false); expect(f.connection.status().state).toBe('idle');
    expect(f.runtime.revoke).toHaveBeenCalledWith({ platform: 'wechat', account_id: f.account }, f.sessions[0]!.sourceKey);
  });
  it('revokes source even when stopping message intake throws', async () => {
    const f = fixture(); await f.connection.connect('synthetic-epoch-1', true);
    f.stop.mockImplementation(() => { throw new Error('synthetic stop failure'); });
    const old = f.sessions[0]!;
    await old.settings.onRevoked(f.account, old.sourceKey, 'identity_unavailable');
    expect(f.connection.verifies(f.account)).toBe(false);
    expect(f.connection.status()).toMatchObject({ state: 'error', error: 'WECHAT_IDENTITY_LOST' });
    expect(f.runtime.revoke).toHaveBeenCalledWith({ platform: 'wechat', account_id: f.account }, old.sourceKey);
    await f.connection.connect('synthetic-epoch-1', true);
    const current = f.sessions[1]!; const stopCalls = f.stop.mock.calls.length;
    await old.settings.onRevoked(f.account, old.sourceKey, 'worker_closed');
    expect(f.connection.status().connection_id).toBe(current.sourceKey);
    expect(f.connection.verifies(f.account)).toBe(true); expect(f.stop).toHaveBeenCalledTimes(stopCalls);
  });
  it('keeps only a safe failure code after startup/registration errors, and allows a new connection', async () => {
    const f = fixture(); f.runtime.observe.mockRejectedValueOnce(new Error('private native path / account'));
    await expect(f.connection.connect('synthetic-epoch-1', true)).rejects.toThrow('WECHAT_CONNECTION_FAILED');
    expect(f.connection.status()).toMatchObject({ state: 'error', error: 'WECHAT_CONNECTION_FAILED', connection_id: null });
    await f.connection.connect('synthetic-epoch-1', true);
    expect(f.connection.status().state).toBe('identified');
  });
  it('disconnect during startup cannot be overwritten by a late successful callback', async () => {
    const f = fixture(); let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    f.runtime.observe.mockImplementationOnce(async () => { await wait; return 'pending'; });
    const opening = f.connection.connect('synthetic-epoch-1', true);
    const rejection = expect(opening).rejects.toThrow('WECHAT_CONNECTION_FAILED');
    await Promise.resolve();
    await f.connection.disconnect('synthetic-epoch-1', f.sessions[0]!.sourceKey);
    release(); await rejection;
    expect(f.connection.status()).toMatchObject({ state: 'idle', connection_id: null });
    expect(f.connection.verifies(f.account)).toBe(false);
  });
});
