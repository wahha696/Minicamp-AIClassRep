import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WechatIdentityChannel } from './wechat-identity-channel.js';
import { wechatPythonArgs } from './wechat-python.js';

const channels: WechatIdentityChannel[] = [];
function fixture() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
  };
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const requests: Record<string, unknown>[] = [];
  child.stdin.on('data', (data: Buffer) => requests.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>));
  child.kill = vi.fn(() => { child.emit('close', 0); return true; });
  let now = 100;
  const invalidated = vi.fn();
  const channel = new WechatIdentityChannel({ executable: 'synthetic-only', args: [], launch: () => child,
    clock: () => now, onInvalidated: invalidated });
  channels.push(channel);
  const respond = (extra: Record<string, unknown>, token = requests[0]?.token) => {
    child.stdout.write(Buffer.from(JSON.stringify({ v: 1, token, ...extra }) + '\n'));
  };
  const ready = () => respond({ kind: 'ready', seq: 0 });
  const observed = (seq: number, account: string | null = 'wxid_synthetic_first') => respond({ kind: 'observed', seq,
    state: account ? 'main_and_account_observed' : 'login_page_observed', account });
  return { child, requests, channel, invalidated, ready, observed, respond, setNow: (value: number) => { now = value; } };
}
afterEach(async () => {
  await Promise.all(channels.splice(0).map((channel) => channel.close()));
  vi.useRealTimers();
});

describe('private WeChat identity channel (synthetic child only)', () => {
  it.each([
    ['module_unsupported', 'WECHAT_MODULE_UNSUPPORTED'], ['runtime_failed', 'WECHAT_RUNTIME_FAILED'],
    ['process_unavailable', 'WECHAT_PROCESS_UNAVAILABLE'], ['main_process_unavailable', 'WECHAT_PROCESS_UNAVAILABLE'],
    ['unsupported', 'WECHAT_VERSION_UNSUPPORTED'],
  ])('preserves safe startup classification %s', async (reason, code) => {
    const f = fixture(); f.respond({ kind: 'unavailable', seq: 0, reason });
    await expect(f.channel.sample()).rejects.toThrow(code);
    expect(f.channel.current()).toBeNull();
  });
  it('reports a current memory-read access failure without classifying it as a version error', async () => {
    const f = fixture(); f.ready(); const pending = f.channel.sample(); await Promise.resolve();
    f.respond({ kind: 'unavailable', seq: 1, reason: 'process_unavailable' });
    await expect(pending).rejects.toThrow('WECHAT_PROCESS_UNAVAILABLE');
    expect(f.channel.current()).toBeNull();
  });
  it('requires private initialization then accepts only the requested sample', async () => {
    const f = fixture();
    expect(f.requests[0]).toMatchObject({ v: 1, seq: 0, command: 'initialize' });
    expect(f.requests[0]?.token).toMatch(/^[a-f0-9]{64}$/);
    expect(f.channel.current()).toBeNull();
    f.ready();
    const sample = f.channel.sample();
    await Promise.resolve();
    expect(f.requests[1]).toMatchObject({ seq: 1, command: 'sample' });
    f.observed(1);
    const result = await sample;
    expect(result?.account).toBe('wxid_synthetic_first');
    expect(f.channel.isCurrent(result!)).toBe(true);
    expect(f.invalidated).not.toHaveBeenCalled();
  });

  it('expires old evidence and cannot revive it after a later successful sample', async () => {
    const f = fixture(); f.ready();
    const first = f.channel.sample(); await Promise.resolve(); f.observed(1);
    const ticket = (await first)!;
    f.setNow(2100);
    expect(f.channel.current()).toBeNull();
    expect(f.channel.isCurrent(ticket)).toBe(false);
    const second = f.channel.sample(); await Promise.resolve(); f.observed(2);
    expect((await second)?.account).toBe(ticket.account);
    expect(f.channel.isCurrent(ticket)).toBe(false);
  });

  it('normal refresh disables old tickets while pending without reporting logout', async () => {
    const f = fixture(); f.ready();
    const first = f.channel.sample(); await Promise.resolve(); f.observed(1);
    const ticket = (await first)!;
    const second = f.channel.sample(); await Promise.resolve();
    expect(f.channel.current()).toBeNull(); expect(f.channel.isCurrent(ticket)).toBe(false);
    expect(f.invalidated).not.toHaveBeenCalled();
    f.observed(2); const renewed = (await second)!;
    expect(f.channel.isCurrent(renewed)).toBe(true); expect(f.channel.isCurrent(ticket)).toBe(false);
    expect(f.invalidated).not.toHaveBeenCalled();
  });

  it('revokes old account before returning a new account and on logout', async () => {
    const f = fixture(); f.ready();
    const first = f.channel.sample(); await Promise.resolve(); f.observed(1); const old = (await first)!;
    const second = f.channel.sample(); await Promise.resolve(); f.observed(2, 'wxid_synthetic_other');
    expect((await second)?.account).toBe('wxid_synthetic_other');
    expect(f.channel.isCurrent(old)).toBe(false); expect(f.invalidated).toHaveBeenCalledTimes(1);
    const third = f.channel.sample(); await Promise.resolve(); f.observed(3, null);
    expect(await third).toBeNull(); expect(f.channel.current()).toBeNull();
  });

  it('rejects wrong owner token, unsolicited/repeated replies and private extra fields', async () => {
    for (const mode of ['token', 'unsolicited', 'extra', 'malformed']) {
      const f = fixture(); f.ready();
      if (mode === 'token') f.respond({ kind: 'ready', seq: 0 }, 'b'.repeat(64));
      if (mode === 'unsolicited') f.observed(1);
      if (mode === 'extra') f.respond({ kind: 'observed', seq: 1, account: 'wxid_secret', private: 'body' });
      if (mode === 'malformed') f.child.stdout.write(Buffer.from([0xff, 10]));
      await expect(f.channel.sample()).rejects.toThrow('WECHAT_IDENTITY_CHANNEL_CLOSED');
      expect(f.channel.current()).toBeNull(); expect(f.child.kill).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds unframed output and rejects inconsistent state/account', async () => {
    const f = fixture(); f.ready();
    f.child.stdout.write(Buffer.alloc(4097, 65));
    await expect(f.channel.sample()).rejects.toThrow('WECHAT_IDENTITY_CHANNEL_CLOSED');
    const g = fixture(); g.ready();
    const pending = g.channel.sample(); await Promise.resolve();
    g.respond({ kind: 'observed', seq: 1, state: 'unknown', account: 'wxid_synthetic_first' });
    await expect(pending).rejects.toThrow('WECHAT_IDENTITY_CHANNEL_CLOSED');
  });

  it('worker loss clears evidence, rejects work and reaps the owned child', async () => {
    const f = fixture(); f.ready();
    const pending = f.channel.sample(); await Promise.resolve();
    f.child.emit('exit', 2);
    await expect(pending).rejects.toThrow('WECHAT_IDENTITY_CHANNEL_CLOSED');
    await f.channel.close(); expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(f.channel.current()).toBeNull();
  });

  it('enforces startup and sample watchdogs without restoring old identity', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = f.channel.sample(); const rejection = expect(first).rejects.toThrow('WECHAT_IDENTITY_CHANNEL_CLOSED');
    await vi.advanceTimersByTimeAsync(45000); await rejection;
    const g = fixture(); g.ready();
    const sample = g.channel.sample(); const failed = expect(sample).rejects.toThrow('WECHAT_IDENTITY_CHANNEL_CLOSED');
    await vi.advanceTimersByTimeAsync(17000); await failed;
    expect(g.channel.current()).toBeNull();
  });

  it('rejects parallel samples and stale sequence after a new request', async () => {
    const f = fixture(); f.ready();
    const first = f.channel.sample(); await Promise.resolve();
    await expect(f.channel.sample()).rejects.toThrow('WECHAT_IDENTITY_SAMPLE_PENDING');
    f.observed(1); await first;
    const second = f.channel.sample(); await Promise.resolve(); f.observed(1);
    await expect(second).rejects.toThrow('WECHAT_IDENTITY_CHANNEL_CLOSED');
  });

  it('a stalled refresh only makes proof stale (reads blocked), never reports a logout', async () => {
    vi.useFakeTimers(); const f = fixture(); f.ready();
    const first = f.channel.sample(); await Promise.resolve(); f.observed(1); const ticket = (await first)!;
    const pending = f.channel.sample(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000); f.setNow(2100);
    expect(f.invalidated).not.toHaveBeenCalled(); expect(f.channel.current()).toBeNull();
    expect(f.channel.isCurrent(ticket)).toBe(false);
    f.observed(2); const renewed = (await pending)!;
    expect(renewed.account).toBe(ticket.account); expect(f.channel.isCurrent(renewed)).toBe(true);
    expect(f.invalidated).not.toHaveBeenCalled();
  });

  it('"unknown" state returns no proof without reporting a logout; login page does', async () => {
    const f = fixture(); f.ready();
    const first = f.channel.sample(); await Promise.resolve(); f.observed(1); await first;
    const unknown = f.channel.sample(); await Promise.resolve();
    f.respond({ kind: 'observed', seq: 2, state: 'unknown', account: null });
    expect(await unknown).toBeNull(); expect(f.channel.current()).toBeNull(); expect(f.invalidated).not.toHaveBeenCalled();
    const logout = f.channel.sample(); await Promise.resolve(); f.observed(3, null);
    expect(await logout).toBeNull(); expect(f.invalidated).toHaveBeenCalledWith('identity_unavailable');
  });

  it('cannot publish a new identity when revocation closes the channel', async () => {
    const f = fixture(); f.ready();
    const first = f.channel.sample(); await Promise.resolve(); f.observed(1); await first;
    f.invalidated.mockImplementation(() => { void f.channel.close(); });
    const second = f.channel.sample(); await Promise.resolve(); f.observed(2, 'wxid_synthetic_other');
    await expect(second).rejects.toThrow('WECHAT_IDENTITY_CHANNEL_CLOSED');
    expect(f.channel.current()).toBeNull();
  });

  it('returns safe distinct failures for unsupported, absent or multiple clients', async () => {
    for (const [reason, code] of [['unsupported', 'WECHAT_VERSION_UNSUPPORTED'], ['not_running', 'WECHAT_NOT_RUNNING'],
      ['ambiguous', 'WECHAT_MULTIPLE_CLIENTS']]) {
      const f = fixture();
      f.respond({ kind: 'unavailable', seq: 0, reason });
      await expect(f.channel.sample()).rejects.toThrow(code);
      expect(f.channel.current()).toBeNull();
      expect(f.child.kill).toHaveBeenCalledTimes(1);
    }
  });

  it.skipIf(!process.env.WECHAT4_TEST_PYTHON)('real Python pipe preserves identity changes and reaps child (synthetic memory)', async () => {
    const channel = new WechatIdentityChannel({ executable: process.env.WECHAT4_TEST_PYTHON!,
      args: wechatPythonArgs(fileURLToPath(new URL('../../../../tools/wechat4-read-probe/identity_worker_fixture.py', import.meta.url))),
      onInvalidated: () => {} });
    channels.push(channel);
    const first = (await channel.sample())!;
    expect(first.account).toBe('wxid_synthetic_account');
    const second = (await channel.sample())!;
    expect(second.account).toBe('wxid_synthetic_changed');
    expect(channel.isCurrent(first)).toBe(false);
    expect(await channel.sample()).toBeNull();
    expect(channel.current()).toBeNull();
    await channel.close();
  });
});
