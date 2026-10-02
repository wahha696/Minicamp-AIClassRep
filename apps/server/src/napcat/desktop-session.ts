import { randomUUID } from 'node:crypto';
import type { DesktopQQStatusDTO } from '../types.js';

export interface DesktopQQHandle {
  poll(): Promise<'open' | 'closed'>;
  close(): Promise<void>;
}
export interface DesktopAccountSnapshot {
  epoch: string;
  uin: string | null;
  online: boolean;
  ready: boolean;
}
export interface DesktopSessionDependencies {
  supported: boolean;
  account(): DesktopAccountSnapshot;
  pause(): void;
  resume(): Promise<void>;
  openQQ(uin: string): Promise<DesktopQQHandle>;
  now?: () => number;
  pollMs?: number;
  onlineTimeoutMs?: number;
}
export class DesktopSessionError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}

/** Server-owned handoff survives a hidden, reloaded or closed browser. */
export class DesktopSession {
  private status: DesktopQQStatusDTO;
  private qq: DesktopQQHandle | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private operation: Promise<void> | null = null;
  private disposed = false;
  private resumeStartedAt = 0;
  private recovery: { uin: string; since: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: DesktopSessionDependencies) {
    this.status = { supported: deps.supported, state: 'idle' };
    this.now = deps.now ?? Date.now;
  }
  getStatus(): DesktopQQStatusDTO { return { ...this.status }; }
  isActive(): boolean { return this.status.state !== 'idle'; }
  private assertAccount(epoch: string, uin: string): void {
    const current = this.deps.account();
    if (!current.ready || current.epoch !== epoch || current.uin !== uin) {
      throw new DesktopSessionError('账号已发生变化，请刷新后重试');
    }
  }
  start(epoch: string, uin: string): DesktopQQStatusDTO {
    if (!this.deps.supported) throw new DesktopSessionError('当前部署不支持切换到本机 QQ');
    if (this.isActive() || this.operation !== null) throw new DesktopSessionError('QQ 切换正在进行，请稍后重试');
    this.assertAccount(epoch, uin);
    if (!this.deps.account().online) throw new DesktopSessionError('请先登录 QQ，再返回电脑版 QQ');
    this.status = { supported: true, state: 'opening', session_id: randomUUID(), uin, paused_at: this.now() };
    // Stop capture and new AI work synchronously before the first await.
    try { this.deps.pause(); } catch (error) { this.fail(error); return this.getStatus(); }
    this.operation = this.deps.openQQ(uin).then((qq) => {
      this.qq = qq;
      if (this.disposed) return;
      this.status = { ...this.status, state: 'qq', message: undefined };
      this.startMonitor();
    }, (error) => this.fail(error)).finally(() => { this.operation = null; });
    return this.getStatus();
  }
  returnToClassRep(epoch: string, uin: string, sessionId: string): DesktopQQStatusDTO {
    this.assertAccount(epoch, uin);
    if (!this.isActive() || this.status.uin !== uin || this.status.session_id !== sessionId) {
      throw new DesktopSessionError('切换状态已过期，请刷新后重试');
    }
    if (this.status.state === 'opening') throw new DesktopSessionError('正在打开 QQ，请稍后重试');
    if (this.status.state !== 'resuming') this.beginResume();
    return this.getStatus();
  }
  private startMonitor(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.check(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }
  private async check(): Promise<void> {
    if (this.disposed || this.polling || this.operation !== null) return;
    this.polling = true;
    const qq = this.qq;
    try {
      if (this.status.state === 'qq' && qq) {
        const closed = await qq.poll() === 'closed';
        if (closed && !this.disposed && this.status.state === 'qq' && this.qq === qq) this.beginResume();
      } else if (this.status.state === 'resuming' && this.now() - this.resumeStartedAt > (this.deps.onlineTimeoutMs ?? 90_000)) {
        this.fail(new Error('QQ 尚未重新连接，请点击“返回ClassRep”重试；如需扫码，请到连接页完成登录'));
      }
    } catch (error) {
      if (this.status.state === 'qq' && this.qq === qq) this.fail(error);
    }
    finally { this.polling = false; }
  }
  private beginResume(): void {
    if (this.operation !== null || this.disposed) return;
    this.status = { ...this.status, state: 'resuming', message: undefined };
    this.resumeStartedAt = this.now();
    this.startMonitor();
    this.operation = (async () => {
      if (this.qq) await this.qq.close();
      this.qq = null;
      if (this.disposed) return;
      this.recovery = { uin: this.status.uin!, since: this.status.paused_at! };
      await this.deps.resume();
    })().catch((error) => this.fail(error)).finally(() => { this.operation = null; });
  }
  /** Only an authenticated lifecycle with this account's DB can complete recovery. */
  onOnline(uin: string): number | null {
    if (this.disposed || !this.recovery || this.recovery.uin !== uin) return null;
    const since = this.recovery.since;
    this.recovery = null;
    this.stopMonitor();
    this.status = { supported: this.deps.supported, state: 'idle' };
    return since;
  }
  private fail(error: unknown): void {
    if (!this.disposed) this.status = { ...this.status, state: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  private stopMonitor(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  dispose(): void { this.disposed = true; this.stopMonitor(); }
}
