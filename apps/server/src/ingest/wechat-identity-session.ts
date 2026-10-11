import { randomUUID } from 'node:crypto';
import { WechatIdentityChannel, type WechatIdentityEvidence, type WechatIdentityFailure } from './wechat-identity-channel.js';
import { wechatIdentityRuntime, wechatPythonArgs } from './wechat-python.js';

type Channel = Pick<WechatIdentityChannel, 'sample' | 'current' | 'isCurrent' | 'close'>;

/** Worker-level failures (crash, watchdog, garbled pipe) are retried with a fresh worker:
 * heavy local work such as history refresh can starve a sample without any logout. */
const RECOVERABLE = new Set<WechatIdentityFailure>(['worker_closed', 'worker_failed', 'worker_timeout', 'invalid_response']);
const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 120_000;
/** Consecutive "state unknown" samples tolerated before treating the login as lost. */
export const UNKNOWN_GRACE_MS = 30_000;
interface Options {
  root: string;
  onVerified(account: string, sourceKey: string): Promise<unknown> | void;
  onRevoked(account: string, sourceKey: string, reason: WechatIdentityFailure | 'manual_close'): Promise<unknown> | void;
  createChannel?: (invalidated: (reason?: WechatIdentityFailure) => void) => Channel;
}

/** Internal lifecycle owned by the explicit local connection endpoint.
 * Identity monitoring is separate from message collectors: stopping intake must
 * never freeze an old account proof while a space switch waits for requests.
 */
export class WechatIdentitySession {
  readonly sourceKey = randomUUID();
  private channel: Channel | null = null;
  private account: string | null = null;
  private closed = false;
  private started = false;
  private sampling: Promise<WechatIdentityEvidence | null> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping: Promise<void> | null = null;
  private recovering: Promise<void> | null = null;
  private recoveries: number[] = [];
  private unknownSince: number | null = null;

  constructor(private readonly options: Options, private readonly clock: () => number = Date.now) {}

  private openChannel(): Channel {
    let channel: Channel | undefined;
    const invalidate = (reason?: WechatIdentityFailure) => {
      const failure = reason ?? 'identity_unavailable';
      if (this.closed) return;
      // Events from a channel already replaced by recovery are ignored.
      if (channel !== undefined && this.channel !== null && channel !== this.channel) return;
      if (this.account !== null && RECOVERABLE.has(failure)) { void this.recover(failure); return; }
      void this.close(failure);
    };
    channel = this.options.createChannel?.(invalidate) ?? (() => {
      const runtime = wechatIdentityRuntime(this.options.root);
      return new WechatIdentityChannel({ executable: runtime.executable,
        args: wechatPythonArgs(runtime.entry, ['--discover', '--approve-identity-read']), onInvalidated: invalidate });
    })();
    return channel;
  }

  /** Replace a failed worker and re-confirm the same account; a different/absent account still revokes. */
  private recover(reason: WechatIdentityFailure): Promise<void> {
    if (this.recovering) return this.recovering;
    const now = this.clock();
    this.recoveries = this.recoveries.filter((at) => now - at < RECOVERY_WINDOW_MS);
    if (this.recoveries.length >= MAX_RECOVERIES) return this.close(reason);
    this.recoveries.push(now);
    clearTimeout(this.timer);
    const old = this.channel;
    const work = (async () => {
      this.sampling = null;
      this.channel = this.openChannel();
      void old?.close().catch(() => {});
      const evidence = await this.refresh();
      if (this.closed) return;
      if (!evidence && this.unknownSince === null) throw new Error('WECHAT_IDENTITY_NOT_AVAILABLE');
    })();
    this.recovering = work;
    void work.then(() => { this.recovering = null; this.schedule(); },
      () => { this.recovering = null; void this.close(reason); });
    return work;
  }

  async start(approvedIdentityRead: boolean): Promise<void> {
    if (approvedIdentityRead !== true) throw new Error('WECHAT_IDENTITY_CONSENT_REQUIRED');
    if (this.started || this.closed) throw new Error('WECHAT_IDENTITY_SESSION_CLOSED');
    this.started = true;
    try {
      this.channel = this.openChannel();
      if (this.closed) {
        await this.channel.close();
        throw new Error('WECHAT_IDENTITY_SESSION_CLOSED');
      }
      const evidence = await this.refresh();
      if (!evidence || this.closed) throw new Error('WECHAT_IDENTITY_NOT_AVAILABLE');
      this.account = evidence.account;
      this.schedule(); // Keep checking even while the workspace transition waits.
      await this.options.onVerified(evidence.account, this.sourceKey);
      if (this.closed) throw new Error('WECHAT_IDENTITY_SESSION_CLOSED');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private schedule(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh().then(() => {
        if (!this.closed && !this.recovering) this.schedule();
      }).catch(() => { if (!this.recovering) void this.close('worker_failed'); });
    }, 500);
    this.timer.unref();
  }

  /** A queued bind must recheck, rather than retain its pre-queue account proof. */
  async revalidate(account: string): Promise<boolean> {
    if (this.closed || this.account !== account) return false;
    try {
      if (this.recovering) await this.recovering.catch(() => {});
      const evidence = await this.refresh();
      return !this.closed && evidence?.account === account && this.channel?.isCurrent(evidence) === true;
    } catch { if (!this.recovering) void this.close('worker_failed'); return false; }
  }

  private refresh(): Promise<WechatIdentityEvidence | null> {
    if (this.closed || !this.channel) return Promise.resolve(null);
    if (this.sampling) return this.sampling;
    const channel = this.channel;
    const work = (async () => {
      let evidence: WechatIdentityEvidence | null;
      try { evidence = await channel.sample(); }
      catch (error) { if (this.closed || channel !== this.channel || this.recovering) return null; throw error; }
      if (this.closed || channel !== this.channel) return null;
      if (!evidence && this.account !== null) {
        // State unknown (not the login page): proof stays stale; give up only after a sustained period.
        this.unknownSince ??= this.clock();
        if (this.clock() - this.unknownSince >= UNKNOWN_GRACE_MS) void this.close('identity_unavailable');
        return null;
      }
      if (!evidence || !channel.isCurrent(evidence) || (this.account !== null && this.account !== evidence.account)) {
        // Revocation immediately clears access, but its queued DB cleanup may
        // wait for the very workspace transition awaiting this recheck.
        // Release the recheck before awaiting that cleanup, avoiding a cycle.
        void this.close('identity_unavailable'); // Explicit reconnect required; never auto-bind a replacement account.
        return null;
      }
      this.unknownSince = null;
      return evidence;
    })();
    this.sampling = work;
    void work.finally(() => { if (this.sampling === work) this.sampling = null; }).catch(() => {});
    return work;
  }

  verifies(account: string): boolean {
    if (this.closed || this.account !== account) return false;
    return this.channel?.current()?.account === account;
  }

  close(reason: WechatIdentityFailure | 'manual_close' = 'manual_close'): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    clearTimeout(this.timer);
    const account = this.account;
    this.account = null;
    // Install the promise before callbacks: channel.close can synchronously invalidate.
    let finish!: () => void;
    this.stopping = new Promise<void>((resolve) => { finish = resolve; });
    const jobs: Promise<unknown>[] = [];
    if (account !== null) {
      try { jobs.push(Promise.resolve(this.options.onRevoked(account, this.sourceKey, reason))); }
      catch { /* Access proof is already gone; do not revive or expose native values. */ }
    }
    if (this.channel) {
      try { jobs.push(this.channel.close()); } catch { /* The owned channel reports failures separately. */ }
    }
    void Promise.allSettled(jobs).then(() => finish());
    return this.stopping;
  }
}
