import type { WorkspaceController } from '../workspaces/controller.js';
import { WechatIdentitySession } from './wechat-identity-session.js';
import type { WechatIdentityFailure } from './wechat-identity-channel.js';

type Session = Pick<WechatIdentitySession, 'start' | 'close' | 'verifies' | 'revalidate' | 'sourceKey'>;
type SessionOptions = ConstructorParameters<typeof WechatIdentitySession>[0];
export interface WechatConnectionStatus {
  state: 'idle' | 'connecting' | 'identified' | 'error';
  connection_id: string | null;
  error: string | null;
  // Identity-only until the separate selected-group collector has been connected.
  collecting: false;
  nickname?: string;
}
interface Options {
  root: string;
  epoch(): string;
  workspace(): WorkspaceController | undefined;
  stopWechatIntake(): void;
  createSession?: (options: SessionOptions) => Session;
}

/** Explicit connection coordinator; construction/status never start a reader.
 * The local product endpoint requires the separate identity consent UI.
 */
export class WechatConnection {
  private session: Session | null = null;
  private state: WechatConnectionStatus['state'] = 'idle';
  private error: string | null = null;
  private opening = false;
  private stopping: Promise<void> | null = null;
  private generation = 0;
  private account: string | null = null;
  private profile: { account: string; source: string; nickname: string } | null = null;

  constructor(private readonly options: Options) {}
  status(): WechatConnectionStatus {
    const nickname = this.profile?.account === this.account && this.profile?.source === this.session?.sourceKey
      && this.state === 'identified' ? this.profile.nickname : undefined;
    return { state: this.state, connection_id: this.session?.sourceKey ?? null, error: this.error, collecting: false,
      ...(nickname ? { nickname } : {}) };
  }
  setNickname(account: string, source: string, nickname: string | null): void {
    if (this.account !== account || this.session?.sourceKey !== source || this.state !== 'identified') return;
    this.profile = nickname ? { account, source, nickname } : null;
  }
  verifies(account: string): boolean { return this.session?.verifies(account) === true; }
  revalidate(account: string): Promise<boolean> { return this.session?.revalidate(account) ?? Promise.resolve(false); }
  /** Internal read scope only; never supplied by an HTTP account field or status DTO. */
  identity(): { account: string; connectionId: string } | null {
    return this.account !== null && this.session?.verifies(this.account)
      ? { account: this.account, connectionId: this.session.sourceKey } : null;
  }
  /** Internal source ownership, not a read credential. A routine fresh sample
   * briefly suspends operation tickets; that must not look like a new logout
   * to catalog status polling. Revocation clears this immediately, and every
   * actual read/selection must still await revalidate and compare its source.
   */
  source(): { account: string; connectionId: string } | null {
    return this.state === 'identified' && this.account !== null && this.session !== null
      ? { account: this.account, connectionId: this.session.sourceKey } : null;
  }

  private check(epoch: string): void {
    if (typeof epoch !== 'string' || !epoch || epoch !== this.options.epoch()) throw new Error('WECHAT_CONNECTION_STALE');
    if (!this.options.workspace()) throw new Error('WECHAT_WORKSPACE_NOT_READY');
  }
  async connect(epoch: string, approvedIdentityRead: boolean): Promise<void> {
    this.check(epoch);
    if (approvedIdentityRead !== true) throw new Error('WECHAT_IDENTITY_CONSENT_REQUIRED');
    if (this.opening || this.stopping) throw new Error('WECHAT_CONNECTION_BUSY');
    if (this.session !== null) throw new Error('WECHAT_CONNECTION_ALREADY_OPEN');
    this.profile = null;
    this.opening = true; this.state = 'connecting'; this.error = null;
    const generation = ++this.generation;
    let session: Session | null = null;
    try {
      session = (this.options.createSession ?? ((settings) => new WechatIdentitySession(settings)))({
        root: this.options.root,
        onVerified: async (account, sourceKey) => {
          if (this.session !== session || session?.sourceKey !== sourceKey) throw new Error('WECHAT_CONNECTION_STALE');
          const runtime = this.options.workspace();
          if (!runtime || !this.verifies(account)) throw new Error('WECHAT_IDENTITY_NOT_AVAILABLE');
          this.account = account;
          // Only owned-session evidence enters the workspace. No caller-supplied wxid.
          await runtime.observe({ platform: 'wechat', account_id: account }, sourceKey);
          if (this.session !== session) throw new Error('WECHAT_CONNECTION_STALE');
          this.state = 'identified';
        },
        onRevoked: (account, sourceKey, reason) => {
          if (this.session === session) {
            try { this.options.stopWechatIntake(); } catch { /* Still revoke proof and space access. */ }
            this.session = null;
            this.account = null;
            this.profile = null;
            this.state = reason === 'manual_close' ? 'idle' : 'error';
            this.error = reason === 'manual_close' ? null : safeReason(reason);
          }
          // Source-key checks inside revoke also protect a newly reconnected account.
          return this.options.workspace()?.revoke({ platform: 'wechat', account_id: account }, sourceKey);
        },
      });
      this.session = session;
      await session.start(true);
      if (this.session !== session) throw new Error('WECHAT_CONNECTION_STALE');
    } catch (error) {
      if (session) await session.close();
      if (this.generation === generation) {
        this.session = null; this.state = 'error';
        this.account = null;
        this.profile = null;
        const code = error instanceof Error ? error.message : '';
        this.error ??= ['WECHAT_NOT_RUNNING', 'WECHAT_VERSION_UNSUPPORTED', 'WECHAT_MULTIPLE_CLIENTS',
          'WECHAT_RUNTIME_MISSING'].includes(code) ? code : 'WECHAT_CONNECTION_FAILED';
      }
      // Never expose native errors, account values or paths to HTTP/logs.
      throw new Error(this.error ?? 'WECHAT_CONNECTION_FAILED');
    } finally { this.opening = false; }
  }

  async disconnect(epoch: string, connectionId: string | null): Promise<void> {
    this.check(epoch);
    const session = this.session;
    if ((session?.sourceKey ?? null) !== connectionId) throw new Error('WECHAT_CONNECTION_STALE');
    await this.stop();
  }
  /** Application shutdown uses stop without an HTTP epoch; never logs out WeChat/QQ. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    ++this.generation;
    try { this.options.stopWechatIntake(); } catch { /* Proof must close even if intake cleanup fails. */ }
    const session = this.session;
    this.session = null; this.state = 'idle'; this.error = null;
    this.account = null;
    this.profile = null;
    let finish!: () => void;
    const stopping = new Promise<void>((resolve) => { finish = resolve; });
    this.stopping = stopping;
    void (async () => {
      try { if (session) await session.close(); }
      finally { this.stopping = null; finish(); }
    })().catch(() => {});
    return stopping;
  }
}

function safeReason(reason: WechatIdentityFailure): string {
  if (reason === 'unsupported_version') return 'WECHAT_VERSION_UNSUPPORTED';
  if (reason === 'wechat_not_running') return 'WECHAT_NOT_RUNNING';
  if (reason === 'multiple_clients') return 'WECHAT_MULTIPLE_CLIENTS';
  return 'WECHAT_IDENTITY_LOST';
}
