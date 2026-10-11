import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  epoch: 'current-epoch', control: null as string | null, saved: '10001' as string | undefined,
  stopped: true, conflict: false, pid: null as number | null, restart: vi.fn(), stop: vi.fn(), reset: vi.fn(),
}));
vi.mock('../accounts.js', () => ({
  accountControlContextMatches: (epoch: string, uin: string | null) => epoch === fixture.epoch && uin === fixture.control,
  logoutAccountData: vi.fn(),
}));
vi.mock('../paths.js', () => ({ NAPCAT_DIR: 'synthetic-napcat' }));
vi.mock('./config.js', () => ({ newOnebotToken: vi.fn(), writeNapcatConfig: vi.fn() }));
vi.mock('./manager.js', () => ({ IS_WINDOWS: true, getUin: () => fixture.saved,
  getManagerFacts: () => ({ conflictAtBoot: fixture.conflict, pid: fixture.pid }),
  restart: fixture.restart, clearUin: vi.fn(), killTree: vi.fn(), napcatInstalled: vi.fn(), startManager: vi.fn() }));
vi.mock('./onebot.js', () => ({ EXTERNAL_ONEBOT: false, getOnebotFacts: () => ({ stopped: fixture.stopped }),
  stopOnebotClient: fixture.stop, resetAfterRestart: fixture.reset,
  pickFreePort: vi.fn(), setOnebotEndpoint: vi.fn(), startOnebotClient: vi.fn() }));
import { restartNapcat } from './index.js';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.control = null; fixture.saved = '10001'; fixture.stopped = true; fixture.conflict = false; fixture.pid = null;
});

describe('暂停 QQ 的安全恢复', () => {
  it('启动冲突尚未暂停 OneBot 时，当前页面仍可接管已保存的 QQ', async () => {
    fixture.stopped = false; fixture.conflict = true;
    await expect(restartNapcat({ expectedAccountEpoch: fixture.epoch, expectedUin: '10001', killUserQQ: true })).resolves.toBe(true);
    expect(fixture.restart).toHaveBeenCalledWith({ expectedAccountEpoch: fixture.epoch, expectedUin: '10001', killUserQQ: true });
  });
  it('启动冲突不能放行其他活动账号或过期页面', async () => {
    fixture.stopped = false; fixture.conflict = true; fixture.control = '10002';
    await expect(restartNapcat({ expectedAccountEpoch: fixture.epoch, expectedUin: '10001', killUserQQ: true })).resolves.toBe(false);
    fixture.control = null;
    await expect(restartNapcat({ expectedAccountEpoch: 'old-epoch', expectedUin: '10001', killUserQQ: true })).resolves.toBe(false);
    expect(fixture.restart).not.toHaveBeenCalled();
  });
  it('当前空间无 QQ 会话时可重启记住的 QQ，重新核实身份', async () => {
    await expect(restartNapcat({ expectedAccountEpoch: fixture.epoch, expectedUin: '10001' })).resolves.toBe(true);
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.restart).toHaveBeenCalledOnce();
    expect(fixture.reset).toHaveBeenCalledOnce();
  });
  it.each([
    { expectedAccountEpoch: 'old-epoch', expectedUin: '10001' },
    { expectedAccountEpoch: 'current-epoch', expectedUin: '10002' },
    { expectedAccountEpoch: 'current-epoch', expectedUin: null },
  ])('过期页面或错误账号不可恢复：%j', async (context) => {
    await expect(restartNapcat(context)).resolves.toBe(false);
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.restart).not.toHaveBeenCalled();
  });
  it('其他活动 QQ 会话存在时不可恢复旧 QQ', async () => {
    fixture.control = '10002';
    await expect(restartNapcat({ expectedAccountEpoch: fixture.epoch, expectedUin: '10001' })).resolves.toBe(false);
    expect(fixture.restart).not.toHaveBeenCalled();
  });
  it('未主动暂停时不绕过活动会话检查', async () => {
    fixture.stopped = false;
    await expect(restartNapcat({ expectedAccountEpoch: fixture.epoch, expectedUin: '10001' })).resolves.toBe(false);
  });
  it('当前活动 QQ 保持原恢复规则', async () => {
    fixture.control = '10001'; fixture.stopped = false;
    await expect(restartNapcat({ expectedAccountEpoch: fixture.epoch, expectedUin: '10001' })).resolves.toBe(true);
  });
});
