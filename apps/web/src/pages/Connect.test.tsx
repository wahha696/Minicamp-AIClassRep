// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectStatusDTO } from '../api/types';

const fixture = vi.hoisted(() => ({ data: null as ConnectStatusDTO | null, refresh: vi.fn(), status: vi.fn(), connect: vi.fn(), restart: vi.fn() }));
vi.mock('../components/ConnectStatus', () => ({ useConnectStatus: () => ({ data: fixture.data, refresh: fixture.refresh, error: null }) }));
vi.mock('../components/AiSettingsCard', () => ({ default: () => <div>人工 AI 设置</div> }));
vi.mock('../components/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../lib/status', async (original) => ({ ...await original<typeof import('../lib/status')>(), readAccountFlag: () => '1' }));
vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(),
  getWechatStatus: fixture.status, connectWechat: fixture.connect, restartConnect: fixture.restart,
}));
import Connect from './Connect';

beforeEach(() => {
  fixture.status.mockReset().mockResolvedValue({ state: 'idle', connection_id: null, collecting: false, error: null });
  fixture.connect.mockReset();
  fixture.restart.mockReset().mockResolvedValue({ ok: true });
  fixture.data = { state: 'online', uin: '10001', account_epoch: 'synthetic-epoch', since: 1,
    first_run: false, demo_available: true,
    workspace: { enabled: true, current: { space_id: 'synthetic', name: '人工空间',
      bindings: [{ platform: 'qq', account_id: '10001' }] }, pending: [], wechat_available: true } };
});
afterEach(cleanup);

describe('实际连接页中的微信入口（人工状态，不读取微信）', () => {
  it('启动占用时使用已保存的 QQ 校验接管，但不显示已登录账号的退出按钮', async () => {
    fixture.data!.state = 'qq_conflict';
    render(<MemoryRouter><Connect /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '关闭电脑版 QQ 并继续' }));
    expect(fixture.restart).toHaveBeenCalledWith({ accountEpoch: 'synthetic-epoch', uin: '10001' }, true);
    expect(screen.queryByRole('button', { name: '退出 QQ' })).toBeNull();
    await screen.findByRole('button', { name: '连接电脑微信' });
  });
  it('将平台连接和明确的退出操作收在空间内，AI 设置独立', async () => {
    const view = render(<MemoryRouter><Connect /></MemoryRouter>);
    const workspace = screen.getByRole('region', { name: '课代表空间' });
    expect(within(workspace).getByRole('region', { name: 'QQ 连接' })).toBeTruthy();
    expect(within(workspace).getByRole('region', { name: '微信连接' })).toBeTruthy();
    const logout = within(workspace).getByRole('button', { name: '退出 QQ' });
    expect(view.container.querySelector('aside')).toBeNull();
    expect(within(workspace).queryByText('人工 AI 设置')).toBeNull();
    fireEvent.click(logout);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/空间数据保留/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '退出 QQ' })).toBeTruthy();
    await screen.findByRole('button', { name: '连接电脑微信' });
    expect(fixture.connect).not.toHaveBeenCalled();
  });
  it('断连或暂停均提供恢复入口，不无限转圈', () => {
    fixture.data!.state = 'reconnecting';
    fixture.data!.message = 'QQ 采集已暂停，请重新连接后确认课代表空间';
    render(<MemoryRouter><Connect /></MemoryRouter>);
    expect(screen.getByText(fixture.data!.message)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新连接 QQ' })).toBeTruthy();
    expect(screen.queryByText('连接中断，重连中')).toBeNull();
  });
  it('shows WeChat connection alongside QQ when demo controls are available, without automatically connecting', async () => {
    render(<MemoryRouter><Connect /></MemoryRouter>);
    const connect = await screen.findByRole('button', { name: '连接电脑微信' });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/QQ 已连接/)).toBeTruthy();
    expect(fixture.connect).not.toHaveBeenCalled();
  });
  it('keeps the WeChat entry visible with a reason when the server cannot enable it', () => {
    fixture.data!.workspace!.wechat_available = false;
    fixture.data!.workspace!.wechat_unavailable_reason = 'runtime_missing';
    render(<MemoryRouter><Connect /></MemoryRouter>);
    expect(screen.getByText(/微信读取组件不完整/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '连接电脑微信' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fixture.status).not.toHaveBeenCalled();
  });
});
