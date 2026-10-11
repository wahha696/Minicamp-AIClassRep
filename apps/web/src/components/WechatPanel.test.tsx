// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ status: vi.fn(), intake: vi.fn(), groups: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), refresh: vi.fn(), select: vi.fn() }));
vi.mock('../api/client', () => ({ getWechatStatus: api.status, getWechatGroups: api.groups,
  getWechatIntake: api.intake,
  connectWechat: api.connect, disconnectWechat: api.disconnect, refreshWechatGroups: api.refresh, selectWechatGroups: api.select }));
import WechatPanel from './WechatPanel';
import { MemoryRouter } from 'react-router-dom';
import { loadWechatDataRoot, saveWechatDataRoot } from '../lib/wechat-data-root';
const connection = { state: 'identified', connection_id: 'synthetic-source', error: null, collecting: false };
const catalog = { state: 'ready', error: null, collecting: false,
  scope: { connection_id: 'synthetic-source', account_epoch: 'synthetic-epoch' }, selected_group_ids: [],
  catalog: { catalog_id: 'synthetic-catalog', groups: [{ group_id: 'a@chatroom', name: '同名群' }, { group_id: 'b@chatroom', name: '同名群' }] } };
beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach((item) => item.mockReset());
  api.status.mockResolvedValue(connection); api.groups.mockResolvedValue(catalog);
  api.intake.mockResolvedValue({ state: 'idle', error: null, collecting: false, intake_id: null, scope: null, groups: [] });
  api.connect.mockResolvedValue({ ok: true }); api.disconnect.mockResolvedValue({ ok: true });
  api.refresh.mockResolvedValue({ catalog: catalog.catalog, collecting: false });
  api.select.mockImplementation(async (input) => {
    api.groups.mockResolvedValue({ ...catalog, selected_group_ids: input.group_ids });
    return { selected_group_ids: input.group_ids, collecting: false };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });
function panel(props: Partial<Parameters<typeof WechatPanel>[0]> = {}) {
  return render(<MemoryRouter><WechatPanel installationId="synthetic-installation" mode="groups" available local epoch="synthetic-epoch" account="wxid_synthetic" onChanged={vi.fn()} {...props} /></MemoryRouter>);
}

describe('微信连接诊断按实际原因区分', () => {
  it.each([
    ['WECHAT_VERSION_UNSUPPORTED', '此微信版本尚未适配'],
    ['WECHAT_MODULE_UNSUPPORTED', '实际程序模块的构建或结构尚未通过验证'],
    ['WECHAT_PROCESS_UNAVAILABLE', '尚不能判断版本是否兼容'],
    ['WECHAT_RUNTIME_MISSING', '随应用提供的 Python 或读取程序缺失'],
    ['WECHAT_RUNTIME_FAILED', 'Python 或本机原生依赖加载失败'],
    ['WECHAT_NOT_RUNNING', '请先打开并登录微信'],
    ['WECHAT_MULTIPLE_CLIENTS', '检测到多个微信实例'],
    ['WECHAT_IDENTITY_LOST', '微信登录状态无法确认或已经变化'],
    ['UNKNOWN_SYNTHETIC_FAILURE', '原因尚未确定'],
  ])('连接页准确呈现 %s，不凭失败猜测版本', async (error, message) => {
    api.status.mockResolvedValue({ ...connection, state: 'error', connection_id: null, error });
    panel({ mode: 'connection' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
    expect(api.connect).not.toHaveBeenCalled();
    if (error !== 'WECHAT_VERSION_UNSUPPORTED') expect(screen.getByRole('alert').textContent).not.toContain('此微信版本尚未适配');
  });

  it('群管理同样展示连接故障，不能只叫用户重新登录', async () => {
    api.status.mockResolvedValue({ ...connection, state: 'error', connection_id: null, error: 'WECHAT_RUNTIME_FAILED' });
    panel(); await screen.findByText('微信尚未连接。');
    expect(screen.getByRole('alert').textContent).toContain('原生依赖加载失败');
  });

  it.each([
    ['WECHAT_CATALOG_CONTACT_SCOPE_ACCOUNT_NOT_FOUND', '未找到当前微信账号'],
    ['WECHAT_CATALOG_SNAPSHOT_LOCK_BUSY', '正在整理本地数据'],
    ['WECHAT_CATALOG_WORKER_FAILED', '群列表读取组件未能完成'],
    ['UNKNOWN_SYNTHETIC_CATALOG', '原因尚未确定'],
  ])('群列表故障 %s 不统一归咎存储位置', async (error, message) => {
    api.groups.mockResolvedValue({ ...catalog, state: 'error', error });
    panel(); await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('兼容说明同时解释旧版本、相同版本的不同构建及非版本故障', async () => {
    panel({ mode: 'connection' }); await screen.findByText('微信账号已识别');
    expect(screen.getByText(/读取适配基线：4.1.15.50 指定构建/)).toBeTruthy();
    expect(screen.getByText(/旧版不一定更兼容/)).toBeTruthy();
    expect(screen.getByText(/版本号相同也可能有不同构建/)).toBeTruthy();
    expect(screen.getByText(/普通连接失败不等于版本不支持/)).toBeTruthy();
  });
});

describe('local WeChat path preference (synthetic accounts only)', () => {
  const pathA = 'E:\\Synthetic A\\xwechat_files';
  const pathB = 'D:\\Synthetic B\\xwechat_files';
  const input = () => screen.getByLabelText('微信存储位置') as HTMLInputElement;
  const renderAccount = (account: string | undefined, epoch = 'synthetic-epoch') =>
    <MemoryRouter><WechatPanel installationId="synthetic-installation" mode="groups" available local epoch={epoch} account={account} onChanged={vi.fn()} /></MemoryRouter>;

  it('does not migrate an old account-only path or read another installation on the same browser origin', async () => {
    const legacyKey = 'classrep.wechat.data-root.v1:wxid_synthetic';
    localStorage.setItem(legacyKey, pathA);
    saveWechatDataRoot('other-installation', 'wxid_synthetic', pathB);
    const view = panel(); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe('');
    expect(localStorage.getItem(legacyKey)).toBe(pathA);
    fireEvent.change(input(), { target: { value: pathA } });
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_synthetic')).toBe(pathA);
    expect(loadWechatDataRoot('other-installation', 'wxid_synthetic')).toBe(pathB);
    view.unmount(); panel({ installationId: 'other-installation' }); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(pathB);
    expect(screen.getByText(/已回填此浏览器为当前安装和账号保存的路径/)).toBeTruthy();
    expect((screen.getByLabelText('允许读取微信群目录') as HTMLInputElement).checked).toBe(false);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('does not use a fallback cache when the installation identity is unavailable', async () => {
    saveWechatDataRoot('synthetic-installation', 'wxid_synthetic', pathA);
    panel({ installationId: undefined }); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: pathB } });
    expect(loadWechatDataRoot(undefined, 'wxid_synthetic')).toBe('');
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_synthetic')).toBe(pathA);
    expect(localStorage.length).toBe(1);
    expect(screen.getByText(/路径不会保存/)).toBeTruthy();
  });

  it('clears only the current installation/account memory and revokes the draft read consent', async () => {
    saveWechatDataRoot('synthetic-installation', 'wxid_synthetic', pathA);
    saveWechatDataRoot('other-installation', 'wxid_synthetic', pathB);
    panel(); await screen.findByLabelText('微信存储位置');
    fireEvent.click(screen.getByText('更新群列表'));
    fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    fireEvent.click(screen.getByRole('button', { name: '清除当前路径记忆' }));
    expect(input().value).toBe('');
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_synthetic')).toBe('');
    expect(loadWechatDataRoot('other-installation', 'wxid_synthetic')).toBe(pathB);
    expect((screen.getByLabelText('允许读取微信群目录') as HTMLInputElement).checked).toBe(false);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('restores only the identified account when its binding arrives after the initial render', async () => {
    saveWechatDataRoot('synthetic-installation', 'wxid_synthetic', pathA);
    saveWechatDataRoot('synthetic-installation', 'wxid_other', pathB);
    const view = panel({ account: undefined });
    await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: 'C:\\Unknown account\\xwechat_files' } });
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_synthetic')).toBe(pathA);
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_other')).toBe(pathB);
    view.rerender(renderAccount('wxid_other'));
    await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(pathB);
    expect((screen.getByLabelText('允许读取微信群目录') as HTMLInputElement).checked).toBe(false);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('restores through logout and relogin rerenders even when the account binding arrives last', async () => {
    saveWechatDataRoot('synthetic-installation', 'wxid_synthetic', pathA);
    const view = panel();
    await screen.findByLabelText('微信存储位置');
    fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    api.status.mockResolvedValue({ ...connection, state: 'idle', connection_id: null });
    view.rerender(renderAccount(undefined, 'logged-out'));
    await screen.findByText('微信尚未连接。');
    expect(screen.queryByLabelText('微信存储位置')).toBeNull();
    api.status.mockResolvedValue({ ...connection, connection_id: 'relogin-source' });
    api.groups.mockResolvedValue({ ...catalog, scope: { connection_id: 'relogin-source', account_epoch: 'relogin-epoch' } });
    view.rerender(renderAccount(undefined, 'relogin-epoch'));
    await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe('');
    view.rerender(renderAccount('wxid_synthetic', 'relogin-epoch'));
    await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(pathA);
    expect((screen.getByLabelText('允许读取微信群目录') as HTMLInputElement).checked).toBe(false);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it.each(['source-first', 'binding-first'] as const)('keeps paths scoped while account and source updates arrive %s', async (order) => {
    saveWechatDataRoot('synthetic-installation', 'wxid_synthetic', pathA);
    saveWechatDataRoot('synthetic-installation', 'wxid_other', pathB);
    vi.useFakeTimers();
    let view!: ReturnType<typeof panel>;
    await act(async () => { view = panel(); });
    expect(input().value).toBe(pathA);
    const changeSource = () => {
      api.status.mockResolvedValue({ ...connection, connection_id: 'other-source' });
      api.groups.mockResolvedValue({ ...catalog, scope: { connection_id: 'other-source', account_epoch: 'other-epoch' } });
    };
    if (order === 'source-first') {
      changeSource();
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(screen.queryByLabelText('微信存储位置')).toBeNull();
      await act(async () => { view.rerender(renderAccount('wxid_other', 'other-epoch')); });
    } else {
      await act(async () => { view.rerender(renderAccount('wxid_other', 'other-epoch')); });
      expect(screen.queryByLabelText('微信存储位置')).toBeNull();
      changeSource();
      await act(() => vi.advanceTimersByTimeAsync(2000));
    }
    expect(input().value).toBe(pathB);
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_synthetic')).toBe(pathA);
    expect(api.refresh).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('saves an entered path and restores after refresh without granting consent or reading', async () => {
    const view = panel(); await screen.findByLabelText('微信存储位置');
    expect(input().placeholder).toBe('以 xwechat_files 结尾，可从微信复制：设置 → 账号与存储 → 存储位置');
    fireEvent.change(input(), { target: { value: `  ${pathA}  ` } });
    fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    view.unmount(); panel(); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(pathA);
    expect((screen.getByLabelText('允许读取微信群目录') as HTMLInputElement).checked).toBe(false);
    expect(api.refresh).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(pathA);
  });

  it('restores for the same account after logout and a new connection/epoch', async () => {
    const view = panel(); await screen.findByLabelText('微信存储位置');
    fireEvent.change(input(), { target: { value: pathA } }); view.unmount();
    api.status.mockResolvedValue({ ...connection, state: 'idle', connection_id: null });
    const loggedOut = panel({ epoch: 'logged-out', account: undefined });
    await screen.findByText('微信尚未连接。'); expect(screen.queryByLabelText('微信存储位置')).toBeNull();
    loggedOut.unmount();
    api.status.mockResolvedValue({ ...connection, connection_id: 'new-source' });
    api.groups.mockResolvedValue({ ...catalog, scope: { connection_id: 'new-source', account_epoch: 'new-epoch' } });
    panel({ epoch: 'new-epoch' }); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(pathA); expect(api.refresh).not.toHaveBeenCalled();
  });

  it('isolates accounts even within the same workspace and epoch', async () => {
    const view = panel(); await screen.findByLabelText('微信存储位置');
    fireEvent.change(input(), { target: { value: pathA } });
    const renderAccount = (account: string) => <MemoryRouter><WechatPanel installationId="synthetic-installation" mode="groups" available local epoch="synthetic-epoch" account={account} onChanged={vi.fn()} /></MemoryRouter>;
    view.rerender(renderAccount('wxid_other')); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: pathB } });
    view.rerender(renderAccount('wxid_synthetic')); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(pathA);
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_other')).toBe(pathB); expect(api.refresh).not.toHaveBeenCalled();
  });

  it('keeps edits through polling and sends the edited path only on an explicit read', async () => {
    saveWechatDataRoot('synthetic-installation', 'wxid_synthetic', pathA); vi.useFakeTimers();
    await act(async () => { panel(); });
    fireEvent.change(input(), { target: { value: pathB } });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(input().value).toBe(pathB); expect(api.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('更新群列表'));
    fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    fireEvent.click(screen.getByRole('button', { name: '读取群列表' }));
    await act(async () => {});
    expect(api.refresh).toHaveBeenCalledWith(expect.objectContaining({ data_root: pathB }));
  });

  it('rejects malformed paths without replacing the saved path; clearing forgets it', async () => {
    saveWechatDataRoot('synthetic-installation', 'wxid_synthetic', pathA);
    const view = panel(); await screen.findByLabelText('微信存储位置');
    fireEvent.click(screen.getByText('更新群列表'));
    fireEvent.change(input(), { target: { value: 'relative\\xwechat_files' } });
    fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    expect((screen.getByRole('button', { name: '读取群列表' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('完整 Windows 路径');
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_synthetic')).toBe(pathA);
    fireEvent.change(input(), { target: { value: '' } }); view.unmount();
    panel(); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(''); expect(api.refresh).not.toHaveBeenCalled();
  });

  it('ignores corrupted storage and does not use a shared fallback for an unknown account', async () => {
    saveWechatDataRoot('synthetic-installation', 'wxid_synthetic', pathA);
    localStorage.setItem(localStorage.key(0)!, '{"invalid":true}');
    const view = panel(); await screen.findByLabelText('微信存储位置'); expect(input().value).toBe('');
    view.unmount(); localStorage.clear(); panel({ account: undefined }); await screen.findByLabelText('微信存储位置');
    fireEvent.change(input(), { target: { value: pathB } });
    expect(localStorage.length).toBe(0); expect(api.refresh).not.toHaveBeenCalled();
  });

  it('still allows manual use when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
    panel(); await screen.findByLabelText('微信存储位置');
    fireEvent.click(screen.getByText('更新群列表'));
    fireEvent.change(input(), { target: { value: pathA } });
    fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    fireEvent.click(screen.getByRole('button', { name: '读取群列表' }));
    await waitFor(() => expect(api.refresh).toHaveBeenCalledOnce());
  });

  it('leaves a nonexistent but well-formed path editable after a read error', async () => {
    api.refresh.mockRejectedValue(new Error('请核对存储位置后重试。'));
    panel(); await screen.findByLabelText('微信存储位置');
    fireEvent.click(screen.getByText('更新群列表'));
    fireEvent.change(input(), { target: { value: pathA } });
    fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    fireEvent.click(screen.getByRole('button', { name: '读取群列表' }));
    await screen.findByRole('alert'); expect(input().disabled).toBe(false);
    fireEvent.change(input(), { target: { value: pathB } });
    expect(loadWechatDataRoot('synthetic-installation', 'wxid_synthetic')).toBe(pathB);
    expect((screen.getByLabelText('允许读取微信群目录') as HTMLInputElement).checked).toBe(false);
    expect(api.refresh).toHaveBeenCalledOnce();
  });
});
describe('微信连接与明确选群界面（人工数据，不启动微信）', () => {
  it('connection page offers group management without reading the catalog or showing selection', async () => {
    panel({ mode: 'connection' });
    expect((await screen.findByRole('link', { name: '管理微信群' })).getAttribute('href')).toBe('/groups?platform=wechat');
    expect(screen.queryByRole('button', { name: '确认所选群' })).toBeNull();
    expect(screen.queryByRole('button', { name: '开始采集所选群' })).toBeNull();
    expect(api.groups).not.toHaveBeenCalled();
  });
  it('clears a failed status read after recovery without starting collection', async () => {
    vi.useFakeTimers(); api.status.mockRejectedValueOnce(new Error('人工状态读取失败')).mockResolvedValue(connection);
    await act(async () => { panel(); });
    expect(screen.getByRole('alert').textContent).toBe('人工状态读取失败');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('微信账号已识别')).toBeTruthy();
    expect(api.connect).not.toHaveBeenCalled();
  });
  it('polling reflects another page saved selection but preserves an unsaved local draft', async () => {
    vi.useFakeTimers();
    await act(async () => { panel(); });
    const a = () => screen.getByText('a@chatroom').closest('label')!.querySelector('input')!;
    const b = () => screen.getByText('b@chatroom').closest('label')!.querySelector('input')!;
    api.groups.mockResolvedValue({ ...catalog, selected_group_ids: ['a@chatroom'] });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(a().checked).toBe(true);
    fireEvent.click(b());
    api.groups.mockResolvedValue({ ...catalog, selected_group_ids: [] });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(a().checked).toBe(true); expect(b().checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认所选群' }));
    await act(async () => {});
    expect(api.select).toHaveBeenCalledWith(expect.objectContaining({ group_ids: ['a@chatroom', 'b@chatroom'] }));
  });
  it('disabled feature or remote access never starts status/contact/identity reads', () => {
    const disabled = panel({ mode: 'connection', available: false, unavailableReason: 'runtime_missing' });
    expect(screen.getByRole('heading', { name: '微信连接' })).toBeTruthy();
    expect(screen.getByText(/微信读取组件不完整/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '连接电脑微信' }) as HTMLButtonElement).disabled).toBe(true);
    disabled.unmount();
    panel({ local: false }); expect(screen.getByText(/请在电脑本机管理/)).toBeTruthy();
    expect(api.status).not.toHaveBeenCalled(); expect(api.groups).not.toHaveBeenCalled();
  });
  it('explains unsupported platforms and old-server unavailability without starting a worker', () => {
    const view = panel({ available: false, unavailableReason: 'platform_unsupported' });
    expect(screen.getByText(/仅支持 Windows/)).toBeTruthy();
    view.rerender(<WechatPanel available={false} local epoch="synthetic-epoch" onChanged={vi.fn()} />);
    expect(screen.getByText(/请重启课代表后重试/)).toBeTruthy();
    expect(api.status).not.toHaveBeenCalled(); expect(api.connect).not.toHaveBeenCalled();
  });
  it('identity consent defaults off; checking alone does not connect', async () => {
    api.status.mockResolvedValue({ ...connection, state: 'idle', connection_id: null }); panel({ mode: 'connection' });
    const button = await screen.findByRole('button', { name: '连接电脑微信' });
    expect((button as HTMLButtonElement).disabled).toBe(true); expect(api.connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox')); expect(api.connect).not.toHaveBeenCalled();
    fireEvent.click(button); await waitFor(() => expect(api.connect).toHaveBeenCalledWith('synthetic-epoch'));
    expect(api.groups).not.toHaveBeenCalled();
  });
  it('does not auto-select same-name groups and requires a root plus separate explicit catalog consent', async () => {
    panel(); await screen.findByText('共 2 个群，已选 0 个。相同群名请核对群 ID。');
    fireEvent.click(screen.getByText('更新群列表'));
    const button = screen.getByRole('button', { name: '读取群列表' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); expect(api.refresh).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('微信存储位置'), { target: { value: 'E:\\人工\\xwechat_files' } });
    expect(button.disabled).toBe(true); fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    expect(api.refresh).not.toHaveBeenCalled(); fireEvent.click(button);
    await waitFor(() => expect(api.refresh).toHaveBeenCalledWith({ expected_account_epoch: 'synthetic-epoch', data_root: 'E:\\人工\\xwechat_files', approve_key_read: true, approve_contact_read: true }));
    expect(screen.getByText('a@chatroom')).toBeTruthy(); expect(screen.getByText('b@chatroom')).toBeTruthy();
  });
  it('keeps choices when searching and submits only explicitly selected IDs, including an empty selection', async () => {
    panel(); await screen.findByText('a@chatroom');
    fireEvent.click(screen.getByText('a@chatroom').closest('label')!);
    fireEvent.change(screen.getByLabelText('搜索微信群'), { target: { value: 'b@chatroom' } });
    expect(screen.queryByText('a@chatroom')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '确认所选群' }));
    await waitFor(() => expect(api.select).toHaveBeenCalledWith({ expected_account_epoch: 'synthetic-epoch', catalog_id: 'synthetic-catalog', group_ids: ['a@chatroom'] }));
    await waitFor(() => expect((screen.getByRole('button', { name: '确认所选群' }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.change(screen.getByLabelText('搜索微信群'), { target: { value: '' } });
    fireEvent.click(screen.getByText('a@chatroom').closest('label')!);
    fireEvent.click(screen.getByRole('button', { name: '确认所选群' }));
    await waitFor(() => expect(api.select).toHaveBeenLastCalledWith({ expected_account_epoch: 'synthetic-epoch', catalog_id: 'synthetic-catalog', group_ids: [] }));
    expect(await screen.findByText(/未监听微信群/)).toBeTruthy();
  });
  it('rejects stale-source catalogs and does not show a list before the account enters its space', async () => {
    api.groups.mockResolvedValue({ ...catalog, scope: { ...catalog.scope, connection_id: 'old-source' } }); panel();
    await screen.findByText(/正在核对群目录/); expect(screen.queryByText('a@chatroom')).toBeNull();
    expect(api.refresh).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled();
  });
  it('unmount discards a delayed old-space catalog without updating the new-space panel', async () => {
    let release!: (value: typeof catalog) => void;
    api.groups.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const old = panel(); await waitFor(() => expect(api.groups).toHaveBeenCalledOnce()); old.unmount();
    api.groups.mockResolvedValue({ ...catalog, scope: null }); panel({ epoch: 'new-epoch' });
    release(catalog); await screen.findByText(/正在核对群目录/);
    expect(screen.queryByText('a@chatroom')).toBeNull();
  });
});
