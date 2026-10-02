import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopSession, type DesktopQQHandle, type DesktopSessionDependencies } from './desktop-session.js';

const sessions: DesktopSession[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { sessions.forEach((session) => session.dispose()); sessions.length = 0; vi.useRealTimers(); });
function fixture() {
  const qq: DesktopQQHandle = { poll: vi.fn().mockResolvedValue('open'), close: vi.fn().mockResolvedValue(undefined) };
  let account = { epoch: 'epoch-a', uin: '10001' as string | null, online: true, ready: true };
  const deps: DesktopSessionDependencies = {
    supported: true, account: () => account,
    pause: vi.fn(), resume: vi.fn().mockResolvedValue(undefined), openQQ: vi.fn().mockResolvedValue(qq),
    pollMs: 100, onlineTimeoutMs: 500,
  };
  const session = new DesktopSession(deps);
  sessions.push(session);
  return { session, deps, qq, changeAccount: () => { account = { ...account, epoch: 'epoch-b', uin: '20002' }; } };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('QQ / ClassRep handoff', () => {
  it('pauses synchronously, returns the same account, and consumes gap recovery exactly once', async () => {
    const { session, deps, qq } = fixture();
    const started = session.start('epoch-a', '10001');
    expect(started.state).toBe('opening');
    expect(deps.pause).toHaveBeenCalledOnce();
    await flush();
    expect(session.getStatus().state).toBe('qq');
    session.returnToClassRep('epoch-a', '10001', started.session_id!);
    session.returnToClassRep('epoch-a', '10001', started.session_id!);
    await flush();
    expect(qq.close).toHaveBeenCalledOnce();
    expect(deps.resume).toHaveBeenCalledOnce();
    expect(session.onOnline('20002')).toBeNull();
    expect(session.getStatus().state).toBe('resuming');
    expect(session.onOnline('10001')).toBe(started.paused_at);
    expect(session.onOnline('10001')).toBeNull();
    expect(session.isActive()).toBe(false);
  });
  it('closing QQ triggers recovery without a browser request', async () => {
    const { session, deps, qq } = fixture();
    session.start('epoch-a', '10001');
    await flush();
    vi.mocked(qq.poll).mockResolvedValue('closed');
    await vi.advanceTimersByTimeAsync(100);
    expect(session.getStatus().state).toBe('resuming');
    expect(deps.resume).toHaveBeenCalledOnce();
  });
  it('a late monitor failure cannot overwrite a manual return already in progress', async () => {
    const { session, qq } = fixture();
    const started = session.start('epoch-a', '10001');
    await flush();
    let failPoll!: (error: Error) => void;
    vi.mocked(qq.poll).mockImplementationOnce(() => new Promise((_resolve, reject) => { failPoll = reject; }));
    await vi.advanceTimersByTimeAsync(100);
    session.returnToClassRep('epoch-a', '10001', started.session_id!);
    await flush();
    failPoll(new Error('old monitor failed'));
    await flush();
    expect(session.getStatus().state).toBe('resuming');
    expect(session.onOnline('10001')).toBe(started.paused_at);
  });
  it('rejects stale accounts and session tokens before touching any process', async () => {
    const { session, deps, qq, changeAccount } = fixture();
    expect(() => session.start('old-epoch', '10001')).toThrow('账号已发生变化');
    expect(deps.pause).not.toHaveBeenCalled();
    const started = session.start('epoch-a', '10001');
    await flush();
    expect(() => session.returnToClassRep('epoch-a', '10001', 'old-session')).toThrow('切换状态已过期');
    changeAccount();
    expect(() => session.returnToClassRep('epoch-a', '10001', started.session_id!)).toThrow('账号已发生变化');
    expect(qq.close).not.toHaveBeenCalled();
  });
  it('keeps failed switches recoverable; no false success or background resume after shutdown', async () => {
    const { session, deps, qq } = fixture();
    vi.mocked(deps.openQQ).mockRejectedValueOnce(new Error('QQ 启动失败'));
    const started = session.start('epoch-a', '10001');
    await flush();
    expect(session.getStatus().state).toBe('error');
    session.returnToClassRep('epoch-a', '10001', started.session_id!);
    await flush();
    expect(deps.resume).toHaveBeenCalledOnce();
    session.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(qq.close).not.toHaveBeenCalled();
    expect(session.onOnline('10001')).toBeNull();
  });
  it('shows a retryable error if reconnect never completes', async () => {
    const { session } = fixture();
    const started = session.start('epoch-a', '10001');
    await flush();
    session.returnToClassRep('epoch-a', '10001', started.session_id!);
    await vi.advanceTimersByTimeAsync(600);
    expect(session.getStatus().state).toBe('error');
    expect(session.getStatus().message).toContain('尚未重新连接');
  });
});
