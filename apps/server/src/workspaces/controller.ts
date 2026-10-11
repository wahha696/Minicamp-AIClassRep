import { randomUUID } from 'node:crypto';
import type { WechatCapability, WorkspaceChoiceRequest, WorkspacePending, WorkspaceStatus } from '../../../../shared/workspaces.js';
import { WorkspaceAccess } from './access.js';
import { WorkspaceError, type Platform, type PlatformIdentity, type Workspace, WorkspaceRegistry } from './registry.js';

export interface WorkspaceHost {
  automaticWorkspace?: boolean;
  wechatCapability?(): WechatCapability;
  epoch(): string;
  verify(identity: PlatformIdentity): boolean;
  revalidate?(identity: PlatformIdentity): Promise<boolean>;
  transition(work: () => Promise<void>, onQueued?: () => void): Promise<void>;
  mount(space: Workspace | null): void;
  changed(): void;
  stopCollectors(): void;
  restartCollectors(): void;
}
/** Real collectors supply verified identities; HTTP can choose a destination, never supply a login. */
export class WorkspaceController {
  private readonly access: WorkspaceAccess;
  private active: Workspace | null = null;
  private readonly pending = new Map<Platform, WorkspacePending>();
  private readonly sources = new Map<Platform, { account: string; key: string }>();
  constructor(readonly registry: WorkspaceRegistry, private readonly host: WorkspaceHost) {
    this.access = new WorkspaceAccess(registry);
  }
  currentQq(): string | null {
    return this.access.snapshot().sessions.find((s) => s.platform === 'qq')?.account_id ?? null;
  }
  currentWechat(): string | null {
    return this.access.snapshot().sessions.find((s) => s.platform === 'wechat')?.account_id ?? null;
  }
  currentSpaceId(): string | null { return this.hasAccess() ? this.active?.space_id ?? null : null; }
  isLocked(): boolean { return this.active !== null && !this.hasAccess(); }
  hasAccess(): boolean { return this.access.snapshot().space_id !== null; }
  controlQq(): string | null { return this.pending.get('qq')?.account_id ?? this.currentQq(); }
  status(): WorkspaceStatus {
    const capability: WechatCapability = this.host.wechatCapability?.() ?? { available: false, reason: 'unavailable' };
    const visible = this.host.automaticWorkspace ? this.registry.singleton() : this.hasAccess() ? this.active : null;
    const current = visible ? {
      space_id: visible.space_id, name: visible.name,
      bindings: this.registry.bindings().filter((b) => b.space_id === visible.space_id)
        .map(({ platform, account_id }) => ({ platform, account_id })),
    } : null;
    return { enabled: true, current, pending: [...this.pending.values()].map((p) => ({ ...p,
      ...(p.target ? { target: { ...p.target } } : {}) })), wechat_available: capability.available,
      ...(!capability.available ? { wechat_unavailable_reason: capability.reason } : {}) };
  }

  async observe(verified: PlatformIdentity, sourceKey: string = randomUUID()): Promise<'ready' | 'pending'> {
    // Validates identity before touching state. Saved settings / HTTP fields are never proof.
    const known = this.registry.find(verified);
    if (!this.host.verify(verified)) throw new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED');
    if (typeof sourceKey !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(sourceKey)) {
      throw new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED');
    }
    this.sources.set(verified.platform, { account: verified.account_id, key: sourceKey });
    const oldSession = this.access.snapshot().sessions.find((s) => s.platform === verified.platform);
    if (oldSession && oldSession.account_id !== verified.account_id) {
      this.access.logout(verified.platform, oldSession.session_id);
      this.host.changed(); // Immediately hide old data if this was the last qualifying platform.
    }
    if (this.host.automaticWorkspace) {
      await this.host.transition(async () => {
        if (verified.platform === 'wechat' && this.host.revalidate && !await this.host.revalidate(verified)) {
          throw new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED');
        }
        if (this.sources.get(verified.platform)?.key !== sourceKey || !this.host.verify(verified)) {
          throw new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED');
        }
        const target = this.registry.connectToSingleton(verified);
        this.activate(target, verified, false);
        this.pending.delete(verified.platform);
      });
      return 'ready';
    }
    if (!known || (this.active !== null && this.active.space_id !== known.space_id)) {
      this.pending.set(verified.platform, { request_id: randomUUID(), ...verified,
        kind: known ? 'switch' : 'choose',
        switch_required: this.active !== null,
        ...(known ? { target: { space_id: known.space_id, name: known.name } } : {}) });
      return 'pending';
    }
    await this.host.transition(async () => {
      if (verified.platform === 'wechat' && this.host.revalidate && !await this.host.revalidate(verified)) {
        throw new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED');
      }
      if (this.sources.get(verified.platform)?.key !== sourceKey || !this.host.verify(verified)) {
        throw new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED');
      }
      this.activate(known, verified, false);
      this.pending.delete(verified.platform);
    });
    return 'ready';
  }

  private activate(target: Workspace, verified: PlatformIdentity, switching: boolean): void {
    if (switching) {
      for (const session of this.access.snapshot().sessions) this.access.logout(session.platform, session.session_id);
      for (const platform of this.sources.keys()) if (platform !== verified.platform) this.sources.delete(platform);
    }
    // Runtime opens the DB first. Failure retains old state behind the host's closed gate.
    this.host.mount(target);
    this.access.connect(verified);
    this.active = target;
    this.host.changed();
  }

  choose(request: WorkspaceChoiceRequest): Promise<void> {
    if (this.host.automaticWorkspace) return Promise.reject(new WorkspaceError('WORKSPACE_SINGLE_FIXED'));
    const selected = [...this.pending.values()].find((p) => p.request_id === request.request_id);
    if (!selected || request.expected_account_epoch !== this.host.epoch()) {
      return Promise.reject(new WorkspaceError('WORKSPACE_REQUEST_STALE'));
    }
    const verified: PlatformIdentity = { platform: selected.platform, account_id: selected.account_id };
    const sourceKey = this.sources.get(verified.platform)?.key;
    if (!this.host.verify(verified)) return Promise.reject(new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED'));
    const known = this.registry.find(verified);
    if (known ? request.choice.mode !== 'known' : request.choice.mode === 'known') {
      return Promise.reject(new WorkspaceError('WORKSPACE_CHOICE_INVALID'));
    }
    if (request.choice.mode === 'current' && (!this.hasAccess() || !this.active)) {
      return Promise.reject(new WorkspaceError('WORKSPACE_NO_CURRENT'));
    }
    const targetId = known?.space_id ?? (request.choice.mode === 'current' ? this.active?.space_id : null);
    const switching = this.active !== null && targetId !== this.active.space_id;
    if (switching && !request.confirm_switch) {
      return Promise.reject(new WorkspaceError('WORKSPACE_SWITCH_CONFIRM_REQUIRED'));
    }
    // Freeze proof and stop old callbacks synchronously when a cross-space request is accepted.
    return this.host.transition(async () => {
      if (request.expected_account_epoch !== this.host.epoch()
          || this.pending.get(selected.platform)?.request_id !== selected.request_id
          || this.sources.get(verified.platform)?.key !== sourceKey) {
        throw new WorkspaceError('WORKSPACE_REQUEST_STALE');
      }
      // WeChat identity monitoring is independent of intake: even a cross-space
      // switch must recheck after the queue, never freeze a pre-queue snapshot.
      if (verified.platform === 'wechat' && this.host.revalidate) {
        if (!await this.host.revalidate(verified)) throw new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED');
        if (request.expected_account_epoch !== this.host.epoch()
            || this.pending.get(selected.platform)?.request_id !== selected.request_id
            || this.sources.get(verified.platform)?.key !== sourceKey || !this.host.verify(verified)) {
          throw new WorkspaceError('WORKSPACE_REQUEST_STALE');
        }
      }
      // QQ collectors stop on cross-space queueing and retain their frozen proof.
      if (!switching && !this.host.verify(verified)) throw new WorkspaceError('WORKSPACE_LOGIN_NOT_VERIFIED');
      const target = known ?? (request.choice.mode === 'create'
        ? this.registry.createForIdentity(verified, request.choice.name)
        : this.registry.bindToExisting(verified, this.active!.space_id));
      this.activate(target, verified, switching);
      if (switching) this.pending.clear();
      else this.pending.delete(selected.platform);
    }, switching ? () => this.host.stopCollectors() : undefined).catch((error) => {
      // Registry commit precedes opening the business DB. A failed mount must leave
      // a retryable known destination, rather than trapping the user in "create".
      if (this.pending.get(selected.platform)?.request_id === selected.request_id) {
        const saved = this.registry.find(verified);
        if (saved) this.pending.set(selected.platform, { ...verified, request_id: randomUUID(),
          kind: 'switch', switch_required: this.active !== null,
          target: { space_id: saved.space_id, name: saved.name } });
      }
      throw error;
    }).then(() => {
      // Re-authenticated lifecycle will recheck the selected QQ identity before raw intake.
      if (verified.platform === 'qq') this.host.restartCollectors();
    });
  }

  rename(label: string, expectedEpoch: string): Promise<void> {
    if (expectedEpoch !== this.host.epoch()) return Promise.reject(new WorkspaceError('WORKSPACE_REQUEST_STALE'));
    return this.host.transition(async () => {
      if (expectedEpoch !== this.host.epoch()) throw new WorkspaceError('WORKSPACE_REQUEST_STALE');
      const target = this.host.automaticWorkspace ? this.registry.singleton() : this.active;
      if (!target) throw new WorkspaceError('WORKSPACE_NO_CURRENT');
      const saved = this.registry.rename(target.space_id, label);
      if (this.active?.space_id === saved.space_id) this.active = saved;
    });
  }

  /** Internal collector callback. A late old-worker event cannot revoke a newer connection. */
  revoke(verified: PlatformIdentity, sourceKey: string): Promise<boolean> {
    const source = this.sources.get(verified.platform);
    if (!source || source.account !== verified.account_id || source.key !== sourceKey) return Promise.resolve(false);
    this.sources.delete(verified.platform);
    const pending = this.pending.get(verified.platform);
    if (pending?.account_id === verified.account_id) this.pending.delete(verified.platform);
    const session = this.access.snapshot().sessions.find((s) => s.platform === verified.platform);
    if (session?.account_id === verified.account_id) this.access.logout(session.platform, session.session_id);
    this.host.changed(); // Close the last platform's access immediately, before queued work drains.
    if (this.hasAccess()) return Promise.resolve(true);
    return this.host.transition(async () => {
      if (!this.hasAccess()) {
        this.host.mount(null);
        this.active = null;
        this.host.changed();
      }
    }).then(() => true);
  }

  logout(platform: Platform, expectedEpoch: string, onAccepted?: () => void, onFinished?: () => void): Promise<void> {
    if (expectedEpoch !== this.host.epoch()) return Promise.reject(new WorkspaceError('WORKSPACE_REQUEST_STALE'));
    const session = this.access.snapshot().sessions.find((s) => s.platform === platform);
    const pending = this.pending.get(platform);
    return this.host.transition(async () => {
      if (expectedEpoch !== this.host.epoch()) throw new WorkspaceError('WORKSPACE_REQUEST_STALE');
      if (session) this.access.logout(platform, session.session_id);
      if (pending) this.pending.delete(platform);
      this.sources.delete(platform);
      if (!this.hasAccess()) {
        this.host.mount(null);
        this.active = null;
      }
      this.host.changed();
      onFinished?.();
    }, onAccepted);
  }
}
