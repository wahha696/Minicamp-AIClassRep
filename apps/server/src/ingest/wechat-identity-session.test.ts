import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNKNOWN_GRACE_MS, WechatIdentitySession } from './wechat-identity-session.js';
import type { WechatIdentityEvidence } from './wechat-identity-channel.js';

const sessions: WechatIdentitySession[] = [];
afterEach(async () => { for (const s of sessions.splice(0)) await s.close(); vi.useRealTimers(); });
function fixture() {
  let invalidate!: () => void;
  let current: WechatIdentityEvidence | null = null;
  // null = login page (confirmed logout, the real channel invalidates); 'unknown' = state not observable.
  let next: string | null = 'wxid_synthetic_account';
  let generation = 0;
  const verified = vi.fn(); const revoked = vi.fn();
  const channel = {
    sample: vi.fn(async () => {
      current = next === null || next === 'unknown' ? null : { account: next, generation: ++generation };
      if (next === null) invalidate();
      return current;
    }),
    current: () => current,
    isCurrent: (item: WechatIdentityEvidence) => current === item,
    close: vi.fn(async () => { current = null; invalidate(); }),
  };
  const create = vi.fn((callback: () => void) => { invalidate = callback; return channel; });
  const session = new WechatIdentitySession({ root: 'not inspected in synthetic test',
    onVerified: verified, onRevoked: revoked, createChannel: create });
  sessions.push(session);
  return { session, verified, revoked, channel, create, invalidate: () => invalidate(),
    next: (value: string | null) => { next = value; } };
}

describe('explicit WeChat identity session lifecycle (synthetic only)', () => {
  it.each(['unsupported_version', 'module_unsupported', 'runtime_failed', 'process_unavailable'] as const)(
    'does not lose startup diagnostic %s when channel invalidation closes the session', async reason => {
      const codes = { unsupported_version: 'WECHAT_VERSION_UNSUPPORTED', module_unsupported: 'WECHAT_MODULE_UNSUPPORTED',
        runtime_failed: 'WECHAT_RUNTIME_FAILED', process_unavailable: 'WECHAT_PROCESS_UNAVAILABLE' };
      const verified = vi.fn();
      const session = new WechatIdentitySession({ root: 'synthetic', onVerified: verified, onRevoked: vi.fn(),
        createChannel: invalidate => ({ current: () => null, isCurrent: () => false, close: async () => {},
          sample: async () => { invalidate(reason); throw new Error('generic closed channel'); } }),
      });
      sessions.push(session);
      await expect(session.start(true)).rejects.toThrow(codes[reason]);
      expect(verified).not.toHaveBeenCalled();
    });
  it('requires consent before creating any worker and never starts from construction', async () => {
    const f = fixture(); expect(f.create).not.toHaveBeenCalled();
    await expect(f.session.start(false)).rejects.toThrow('WECHAT_IDENTITY_CONSENT_REQUIRED');
    expect(f.create).not.toHaveBeenCalled();
    await f.session.start(true);
    expect(f.verified).toHaveBeenCalledWith('wxid_synthetic_account', f.session.sourceKey);
    expect(f.session.verifies('wxid_synthetic_account')).toBe(true);
  });
  it('reaps a channel returned after synchronous startup invalidation', async () => {
    const close = vi.fn(async () => {});
    const session = new WechatIdentitySession({ root: 'unused synthetic', onVerified: vi.fn(), onRevoked: vi.fn(),
      createChannel: (invalidate) => {
        invalidate();
        return { close, sample: vi.fn(), current: () => null, isCurrent: () => false };
      } });
    sessions.push(session);
    await expect(session.start(true)).rejects.toThrow('WECHAT_IDENTITY_SESSION_CLOSED');
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('refreshes while an initial workspace transition waits, and deduplicates concurrent rechecks', async () => {
    vi.useFakeTimers(); const f = fixture();
    let release!: () => void;
    f.verified.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const opening = f.session.start(true); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500); expect(f.channel.sample).toHaveBeenCalledTimes(2);
    let resolveSample!: (item: WechatIdentityEvidence) => void;
    const ticket = f.channel.current()!;
    f.channel.sample.mockImplementationOnce(() => new Promise((resolve) => { resolveSample = resolve; }));
    const a = f.session.revalidate(ticket.account); const b = f.session.revalidate(ticket.account);
    expect(f.channel.sample).toHaveBeenCalledTimes(3);
    resolveSample(ticket); expect(await a).toBe(true); expect(await b).toBe(true);
    release(); await opening;
  });
  it.each([null, 'wxid_synthetic_replacement'])('revokes on logout or replacement without observing a new account (%s)', async (replacement) => {
    vi.useFakeTimers(); const f = fixture(); await f.session.start(true);
    f.next(replacement); await vi.advanceTimersByTimeAsync(500);
    expect(f.revoked).toHaveBeenCalledTimes(1);
    expect(f.revoked).toHaveBeenCalledWith('wxid_synthetic_account', f.session.sourceKey, 'identity_unavailable');
    expect(f.verified).toHaveBeenCalledTimes(1); expect(f.channel.close).toHaveBeenCalledTimes(1);
    expect(f.session.verifies('wxid_synthetic_account')).toBe(false);
    expect(await f.session.revalidate('wxid_synthetic_account')).toBe(false);
    await expect(f.session.start(true)).rejects.toThrow('WECHAT_IDENTITY_SESSION_CLOSED');
  });
  it('channel loss synchronously removes proof, waits for revocation/child cleanup and cannot affect a new source', async () => {
    const f = fixture(); await f.session.start(true);
    let release!: () => void;
    f.revoked.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    f.invalidate(); expect(f.session.verifies('wxid_synthetic_account')).toBe(false);
    let closed = false; const closing = f.session.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    const g = fixture(); await g.session.start(true);
    expect(g.session.sourceKey).not.toBe(f.session.sourceKey);
    release(); await closing;
    expect(g.session.verifies('wxid_synthetic_account')).toBe(true);
  });
  it('does not register unknown initial state and reaps a failed startup', async () => {
    const f = fixture(); f.next(null);
    await expect(f.session.start(true)).rejects.toThrow('WECHAT_IDENTITY_NOT_AVAILABLE');
    expect(f.verified).not.toHaveBeenCalled(); expect(f.revoked).not.toHaveBeenCalled();
    expect(f.channel.close).toHaveBeenCalledTimes(1);
  });
  it('recheck failure closes the worker and revokes the qualifying source', async () => {
    const f = fixture(); await f.session.start(true);
    f.channel.sample.mockRejectedValueOnce(new Error('synthetic failure'));
    expect(await f.session.revalidate('wxid_synthetic_account')).toBe(false);
    expect(f.revoked).toHaveBeenCalledTimes(1); expect(f.channel.close).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'error'])('recheck releases a transition before revocation cleanup waiting on it (%s)', async (mode) => {
    const f = fixture(); await f.session.start(true);
    let releaseTransition!: () => void;
    const transitionDone = new Promise<void>((resolve) => { releaseTransition = resolve; });
    f.revoked.mockImplementation(() => transitionDone);
    if (mode === 'unknown') f.next(null);
    else f.channel.sample.mockRejectedValueOnce(new Error('synthetic unavailable'));
    // The caller releases its transition only after revalidate resolves.
    expect(await f.session.revalidate('wxid_synthetic_account')).toBe(false);
    releaseTransition(); await f.session.close();
    expect(f.revoked).toHaveBeenCalledTimes(1);
  });

  it('tolerates a short "unknown" state (e.g. WeChat busy) but revokes after the grace period', async () => {
    let now = 0;
    const f = fixture();
    const session = new WechatIdentitySession({ root: 'unused synthetic', onVerified: f.verified, onRevoked: f.revoked,
      createChannel: f.create }, () => now);
    sessions.push(session);
    await session.start(true);
    f.next('unknown');
    expect(await session.revalidate('wxid_synthetic_account')).toBe(false);
    now = UNKNOWN_GRACE_MS - 1;
    expect(await session.revalidate('wxid_synthetic_account')).toBe(false);
    expect(f.revoked).not.toHaveBeenCalled();
    f.next('wxid_synthetic_account');
    expect(await session.revalidate('wxid_synthetic_account')).toBe(true);
    f.next('unknown'); now = 100_000;
    await session.revalidate('wxid_synthetic_account');
    now = 100_000 + UNKNOWN_GRACE_MS;
    await session.revalidate('wxid_synthetic_account');
    expect(f.revoked).toHaveBeenCalledWith('wxid_synthetic_account', session.sourceKey, 'identity_unavailable');
  });

  it('replaces a crashed/timed-out identity worker without logging out the same account', async () => {
    const channels: { sample: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; fail: (r: string) => void;
      account: string | null }[] = [];
    let nextAccount = 'wxid_synthetic_account';
    const revoked = vi.fn();
    const session = new WechatIdentitySession({ root: 'unused synthetic', onVerified: vi.fn(), onRevoked: revoked,
      createChannel: (invalidate) => {
        let evidence: WechatIdentityEvidence | null = null; let generation = 0;
        const item = {
          account: null as string | null,
          sample: vi.fn(async () => { evidence = { account: nextAccount, generation: ++generation }; return evidence; }),
          current: () => evidence, isCurrent: (e: WechatIdentityEvidence) => e === evidence,
          close: vi.fn(async () => { evidence = null; invalidate('worker_closed'); }),
          fail: (reason: string) => { evidence = null; invalidate(reason as never); },
        };
        channels.push(item); return item;
      } });
    sessions.push(session);
    await session.start(true);
    channels[0]!.fail('worker_timeout');
    expect(await session.revalidate('wxid_synthetic_account')).toBe(true);
    expect(channels).toHaveLength(2); expect(channels[0]!.close).toHaveBeenCalledOnce();
    expect(revoked).not.toHaveBeenCalled();
    expect(session.verifies('wxid_synthetic_account')).toBe(true);
    // A replacement worker that sees a different account still revokes.
    nextAccount = 'wxid_synthetic_other';
    channels[1]!.fail('worker_closed');
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(1));
    expect(session.verifies('wxid_synthetic_account')).toBe(false);
  });

  it('gives up after repeated worker failures in a short window', async () => {
    const revoked = vi.fn(); const fails: ((r: string) => void)[] = [];
    const session = new WechatIdentitySession({ root: 'unused synthetic', onVerified: vi.fn(), onRevoked: revoked,
      createChannel: (invalidate) => {
        let evidence: WechatIdentityEvidence | null = null;
        fails.push((reason) => { evidence = null; invalidate(reason as never); });
        return { sample: vi.fn(async () => (evidence = { account: 'wxid_synthetic_account', generation: 1 })),
          current: () => evidence, isCurrent: (e: WechatIdentityEvidence) => e === evidence, close: vi.fn(async () => {}) };
      } }, () => 0);
    sessions.push(session);
    await session.start(true);
    for (let i = 0; i < 3; i++) { fails.at(-1)!('worker_failed'); await session.revalidate('wxid_synthetic_account'); }
    expect(revoked).not.toHaveBeenCalled();
    fails.at(-1)!('worker_failed');
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledWith('wxid_synthetic_account', session.sourceKey, 'worker_failed'));
  });
});
