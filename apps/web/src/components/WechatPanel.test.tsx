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
  return render(<MemoryRouter><WechatPanel mode="groups" available local epoch="synthetic-epoch" account="wxid_synthetic" onChanged={vi.fn()} {...props} /></MemoryRouter>);
}

describe('local WeChat path preference (synthetic accounts only)', () => {
  const pathA = 'E:\\Synthetic A\\xwechat_files';
  const pathB = 'D:\\Synthetic B\\xwechat_files';
  const input = () => screen.getByLabelText('微信存储位置') as HTMLInputElement;
  const renderAccount = (account: string | undefined, epoch = 'synthetic-epoch') =>
    <MemoryRouter><WechatPanel mode="groups" available local epoch={epoch} account={account} onChanged={vi.fn()} /></MemoryRouter>;

  it('restores only the identified account when its binding arrives after the initial render', async () => {
    saveWechatDataRoot('wxid_synthetic', pathA);
    saveWechatDataRoot('wxid_other', pathB);
    const view = panel({ account: undefined });
    await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: 'C:\\Unknown account\\xwechat_files' } });
    expect(loadWechatDataRoot('wxid_synthetic')).toBe(pathA);
    expect(loadWechatDataRoot('wxid_other')).toBe(pathB);
    view.rerender(renderAccount('wxid_other'));
    await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(pathB);
    expect((screen.getByLabelText('允许读取微信群目录') as HTMLInputElement).checked).toBe(false);
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('restores through logout and relogin rerenders even when the account binding arrives last', async () => {
    saveWechatDataRoot('wxid_synthetic', pathA);
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
    saveWechatDataRoot('wxid_synthetic', pathA);
    saveWechatDataRoot('wxid_other', pathB);
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
    expect(loadWechatDataRoot('wxid_synthetic')).toBe(pathA);
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
    const renderAccount = (account: string) => <MemoryRouter><WechatPanel mode="groups" available local epoch="synthetic-epoch" account={account} onChanged={vi.fn()} /></MemoryRouter>;
    view.rerender(renderAccount('wxid_other')); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe('');
    fireEvent.change(input(), { target: { value: pathB } });
    view.rerender(renderAccount('wxid_synthetic')); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(pathA);
    expect(loadWechatDataRoot('wxid_other')).toBe(pathB); expect(api.refresh).not.toHaveBeenCalled();
  });

  it('keeps edits through polling and sends the edited path only on an explicit read', async () => {
    saveWechatDataRoot('wxid_synthetic', pathA); vi.useFakeTimers();
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
    saveWechatDataRoot('wxid_synthetic', pathA);
    const view = panel(); await screen.findByLabelText('微信存储位置');
    fireEvent.click(screen.getByText('更新群列表'));
    fireEvent.change(input(), { target: { value: 'relative\\xwechat_files' } });
    fireEvent.click(screen.getByLabelText('允许读取微信群目录'));
    expect((screen.getByRole('button', { name: '读取群列表' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('完整 Windows 路径');
    expect(loadWechatDataRoot('wxid_synthetic')).toBe(pathA);
    fireEvent.change(input(), { target: { value: '' } }); view.unmount();
    panel(); await screen.findByLabelText('微信存储位置');
    expect(input().value).toBe(''); expect(api.refresh).not.toHaveBeenCalled();
  });

  it('ignores corrupted storage and does not use a shared fallback for an unknown account', async () => {
    saveWechatDataRoot('wxid_synthetic', pathA);
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
    expect(loadWechatDataRoot('wxid_synthetic')).toBe(pathB);
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
