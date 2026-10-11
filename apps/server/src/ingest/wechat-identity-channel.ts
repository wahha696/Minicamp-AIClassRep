// Private owned-child evidence only. No HTTP, database, collector or auto-start.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { wechatPythonEnv } from './wechat-python.js';

export type WechatIdentityEvidence = Readonly<{ account: string; generation: number }>;
export type WechatIdentityFailure = 'worker_closed' | 'worker_failed' | 'worker_timeout' | 'invalid_response' | 'identity_unavailable'
  | 'wechat_not_running' | 'unsupported_version' | 'multiple_clients'
  | 'module_unsupported' | 'process_unavailable' | 'runtime_failed';
type Failure = WechatIdentityFailure;
export function wechatIdentityFailureCode(reason: Failure): string {
  return reason === 'unsupported_version' ? 'WECHAT_VERSION_UNSUPPORTED'
    : reason === 'wechat_not_running' ? 'WECHAT_NOT_RUNNING'
    : reason === 'module_unsupported' ? 'WECHAT_MODULE_UNSUPPORTED'
    : reason === 'process_unavailable' ? 'WECHAT_PROCESS_UNAVAILABLE'
    : reason === 'runtime_failed' ? 'WECHAT_RUNTIME_FAILED'
    : reason === 'multiple_clients' ? 'WECHAT_MULTIPLE_CLIENTS' : 'WECHAT_IDENTITY_CHANNEL_CLOSED';
}
interface Options {
  executable: string;
  args: readonly string[];
  onInvalidated: (reason: Failure) => void;
  launch?: (executable: string, args: readonly string[]) => ChildProcessWithoutNullStreams;
  clock?: () => number;
}
interface Pending { seq: number; resolve: (evidence: WechatIdentityEvidence | null) => void; reject: (error: Error) => void }

/** Only evidence from this instance's private pipe is accepted; it is not yet a product login adapter. */
export class WechatIdentityChannel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly token = randomBytes(32).toString('hex');
  private readonly clock: () => number;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private generation = 0;
  private expires = 0;
  private account: string | null = null;
  private ready = false;
  private closed = false;
  private cached = false;
  private pending: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly initialized: Promise<void>;
  private readonly reaped: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;

  constructor(private readonly options: Options) {
    this.clock = options.clock ?? (() => performance.now());
    this.initialized = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    // A failure before the caller asks for sample must not become an unhandled rejection.
    void this.initialized.catch(() => {});
    this.child = (options.launch ?? ((exe, args) => spawn(exe, [...args], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: wechatPythonEnv(),
    })))(options.executable, options.args);
    this.reaped = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stdout.on('end', () => this.fail('worker_closed'));
    this.child.stdout.on('error', () => this.fail('worker_failed'));
    this.child.stderr.on('error', () => this.fail('worker_failed'));
    this.child.stderr.resume(); // Never log native stderr, which might contain private paths/values.
    this.child.stdin.on('error', () => this.fail('worker_failed'));
    this.child.on('error', () => this.fail('worker_failed'));
    this.child.on('exit', () => this.fail('worker_closed'));
    this.arm(45_000); // Discovery metadata <=10s, fixed program analysis <=30s, cleanup margin.
    this.send('initialize', 0);
  }

  private send(command: string, seq: number): void {
    if (this.closed) return;
    try { this.child.stdin.write(`${JSON.stringify({ v: 1, token: this.token, seq, command })}\n`); }
    catch { this.fail('worker_failed'); }
  }
  private arm(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('worker_timeout'), ms);
    this.timer.unref();
  }
  /** Proof no longer fresh: block reads and old tickets, but keep the known account (not a logout). */
  private stale(): void {
    this.expires = 0; this.generation++;
    clearTimeout(this.expiryTimer);
  }
  private invalidate(reason: Failure): void {
    this.account = null; this.expires = 0; this.generation++;
    clearTimeout(this.expiryTimer);
    try { this.options.onInvalidated(reason); } catch { /* Callers cannot revive evidence by throwing. */ }
  }
  private fail(reason: Failure): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.invalidate(reason);
    this.buffer = Buffer.alloc(0);
    const code = wechatIdentityFailureCode(reason);
    this.readyReject(new Error(code));
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error(code));
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.kill(); // Only our owned child; never the WeChat client.
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return;
    if (!Buffer.isBuffer(chunk)) { this.fail('invalid_response'); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 4096) { this.fail('invalid_response'); return; }
    let boundary: number;
    while (!this.closed && (boundary = this.buffer.indexOf(10)) >= 0) {
      const raw = this.buffer.subarray(0, boundary);
      this.buffer = this.buffer.subarray(boundary + 1);
      if (raw.length > 2048) { this.fail('invalid_response'); return; }
      let item: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        item = parsed as Record<string, unknown>;
      } catch { this.fail('invalid_response'); return; }
      const keys = Object.keys(item).sort().join(',');
      if (item.v !== 1 || item.token !== this.token || !Number.isSafeInteger(item.seq)) {
        this.fail('invalid_response'); return;
      }
      if (!this.ready && item.kind === 'ready' && item.seq === 0 && keys === 'kind,seq,token,v') {
        this.ready = true; clearTimeout(this.timer); this.readyResolve(); continue;
      }
      if (item.kind === 'unavailable' && ((!this.ready && item.seq === 0)
        || (this.ready && this.pending && item.seq === this.pending.seq)) && keys === 'kind,reason,seq,token,v') {
        const failures: Record<string, Failure> = { not_running: 'wechat_not_running', unsupported: 'unsupported_version',
          ambiguous: 'multiple_clients', main_process_unavailable: 'process_unavailable',
          module_unsupported: 'module_unsupported', process_unavailable: 'process_unavailable', runtime_failed: 'runtime_failed' };
        const reason = typeof item.reason === 'string' ? failures[item.reason] : undefined;
        this.fail(reason ?? 'invalid_response'); return;
      }
      const pending = this.pending;
      if (!this.ready || !pending || item.kind !== 'observed' || item.seq !== pending.seq
          || keys !== 'account,kind,seq,state,token,v'
          || !['main_and_account_observed', 'login_page_observed', 'unknown'].includes(String(item.state))
          || (item.state === 'main_and_account_observed'
            ? typeof item.account !== 'string' || !/^wxid_[A-Za-z0-9_-]{1,120}$/.test(item.account)
            : item.account !== null)) {
        this.fail('invalid_response'); return;
      }
      clearTimeout(this.timer);
      this.pending = null;
      if (item.account === null) {
        // Login page = confirmed logout. "unknown" (e.g. UI busy under load) only marks the proof stale;
        // the session decides how long to tolerate it.
        if (item.state === 'login_page_observed') this.invalidate('identity_unavailable');
        else this.stale();
        pending.resolve(null); continue;
      }
      if (this.account !== null && this.account !== item.account) this.invalidate('identity_unavailable');
      if (this.closed) { pending.reject(new Error('WECHAT_IDENTITY_CHANNEL_CLOSED')); return; }
      this.account = item.account as string;
      this.cached = true;
      this.expires = this.clock() + 2000;
      clearTimeout(this.expiryTimer);
      this.expiryTimer = setTimeout(() => this.stale(), 2000);
      this.expiryTimer.unref();
      pending.resolve(Object.freeze({ account: this.account, generation: this.generation }));
    }
  }
  async sample(): Promise<WechatIdentityEvidence | null> {
    await this.initialized;
    if (this.closed) throw new Error('WECHAT_IDENTITY_CHANNEL_CLOSED');
    if (this.pending) throw new Error('WECHAT_IDENTITY_SAMPLE_PENDING');
    // Disable old operation tickets while checking, without reporting routine sampling as logout.
    // Expired proof is only stale (reads blocked), never a logout: a slow sample under load must
    // not disconnect WeChat. A routine successful response restores it.
    this.expires = 0; this.generation++;
    return new Promise((resolve, reject) => {
      const seq = ++this.sequence;
      this.pending = { seq, resolve, reject };
      this.arm(this.cached ? 7000 : 17_000);
      this.send('sample', seq);
    });
  }
  current(): WechatIdentityEvidence | null {
    if (this.closed || this.pending || this.account === null) return null;
    if (this.clock() >= this.expires) return null;
    return Object.freeze({ account: this.account, generation: this.generation });
  }
  isCurrent(evidence: WechatIdentityEvidence): boolean {
    const current = this.current();
    return current !== null && current.account === evidence.account && current.generation === evidence.generation;
  }
  async close(): Promise<void> { this.fail('worker_closed'); await this.reaped; }
}
