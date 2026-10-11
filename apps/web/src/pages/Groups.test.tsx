// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import type { WechatCatalogDTO } from '../../../../shared/wechat';
import { loadPresets, savePresets, wechatBusinessGroupId } from '../lib/groups';
import type { GroupDTO } from '../api/types';
import { setCurrentSpace } from '../lib/account';
const api = vi.hoisted(() => ({ health: vi.fn(), panel: vi.fn(), groups: vi.fn(), timetable: vi.fn(), patch: vi.fn(), clear: vi.fn(), retry: vi.fn(), toast: vi.fn(), select: vi.fn(), catalog: vi.fn(), intake: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('../api/client', () => ({ getHealth: api.health, getGroups: api.groups, getTimetable: api.timetable, patchGroup: api.patch, deleteGroupData: api.clear, retryGroup: api.retry, selectWechatGroups: api.select, getWechatIntake: api.intake, startWechatIntake: api.start, stopWechatIntake: api.stop }));
vi.mock('../components/Toast', () => ({ useToast: () => api.toast }));
vi.mock('../components/SyncStatus', () => ({ default: () => null }));
vi.mock('../components/ConnectStatus', () => ({ useConnectStatus: () => ({ data: { account_epoch: 'test', workspace: { wechat_available: true, current: { bindings: [{ platform: 'wechat', account_id: 'wxid_test' }] } } }, refresh: vi.fn() }) }));
vi.mock('../components/WechatPanel', () => ({ default: ({ renderGroups, installationId }: { installationId?: string; renderGroups: (catalog: WechatCatalogDTO, reload: () => Promise<void>) => React.ReactNode }) => {
  api.panel(installationId);
  const [catalog, setCatalog] = useState(api.catalog());
  return <div>微信选群与采集{renderGroups(catalog, async () => { setCatalog(api.catalog()); })}</div>;
} }));
import Groups from './Groups';
const group = (id: string, extra: Partial<GroupDTO> = {}): GroupDTO => ({ group_id: id, name: id, enabled: false,
  message_count: 0, event_count: 0, course_name: null, platform: 'qq', ...extra });
beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset()); setCurrentSpace('synthetic-space'); localStorage.clear();
  api.health.mockResolvedValue({ installation_id: 'synthetic-installation' });
  vi.stubGlobal('crypto', webcrypto);
  api.catalog.mockReturnValue({ catalog: null, selected_group_ids: [] });
  const idle = { state: 'idle', collecting: false, intake_id: null, scope: null, groups: [] };
  api.intake.mockResolvedValue(idle);
  api.start.mockImplementation(async input => { api.intake.mockResolvedValue({ ...idle, state: 'collecting', collecting: true,
    intake_id: 'intake', scope: { account_epoch: input.expected_account_epoch, connection_id: input.connection_id },
    groups: input.group_ids.map((group_id: string) => ({ group_id, pending: 0, deferred: 0 })) }); });
  api.stop.mockImplementation(async () => { api.intake.mockResolvedValue(idle); });
  api.groups.mockResolvedValue([group('人工群')]); api.timetable.mockResolvedValue({ courses: [] }); api.patch.mockResolvedValue({});
});
afterEach(() => { cleanup(); setCurrentSpace(undefined); vi.unstubAllGlobals(); });
const page = () => render(<MemoryRouter><Groups /></MemoryRouter>);

it('passes only the installation identity from health, after the initial check completes', async () => {
  let finish!: (health: { installation_id: string }) => void;
  api.health.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  page(); fireEvent.click(screen.getByRole('tab', { name: '微信群' }));
  expect(api.panel).not.toHaveBeenCalled();
  await act(async () => { finish({ installation_id: 'server-installation' }); });
  await waitFor(() => expect(api.panel).toHaveBeenCalledWith('server-installation'));
});

it('allows manual path use without a cache identity if the health read fails', async () => {
  api.health.mockRejectedValue(new Error('unavailable'));
  page(); fireEvent.click(screen.getByRole('tab', { name: '微信群' }));
  await waitFor(() => expect(api.panel).toHaveBeenCalledWith(undefined));
});

it('distinguishes WeChat selection from actual collection and offers the connection entry', async () => {
  api.groups.mockResolvedValue([group('微信甲', { platform: 'wechat', enabled: true, collecting: false }),
    group('微信乙', { platform: 'wechat', enabled: true, collecting: true })]);
  page(); fireEvent.click(screen.getByRole('tab', { name: '微信群' })); await screen.findByText(/正在监听/);
  expect(screen.getByRole('switch', { name: '监听「微信甲」' }).getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText('微信选群与采集', { exact: false })).toBeTruthy();
  expect(screen.getAllByRole('switch')).toHaveLength(2);
});

it('QQ bulk actions do not change WeChat or imported groups', async () => {
  api.groups.mockResolvedValue([group('QQ甲'), group('微信甲', { platform: 'wechat' }), group('导入甲', { platform: 'import' })]);
  page(); fireEvent.click(await screen.findByRole('button', { name: '一键全部开启' }));
  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
  expect(api.patch).toHaveBeenCalledWith('QQ甲', { enabled: true });
  expect(screen.queryByText('微信甲')).toBeNull();
  expect(screen.queryByText('导入甲')).toBeNull();
});

it('WeChat directory uses the common list and saves bulk selection once without touching QQ', async () => {
  api.groups.mockResolvedValue([group('QQ甲')]);
  const catalog = { state: 'ready', error: null, collecting: false, scope: { connection_id: 'source', account_epoch: 'test' },
    catalog: { catalog_id: 'offer', groups: [{ group_id: 'a@chatroom', name: '微信甲' }, { group_id: 'b@chatroom', name: '微信乙' }] }, selected_group_ids: [] };
  api.catalog.mockReturnValue(catalog);
  api.select.mockImplementation(async (input) => { api.catalog.mockReturnValue({ ...catalog, selected_group_ids: input.group_ids }); });
  page(); fireEvent.click(screen.getByRole('tab', { name: '微信群' }));
  await screen.findByRole('switch', { name: '监听「微信甲」' });
  expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '确认所选群' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '一键全部开启' }));
  await waitFor(() => expect(api.select).toHaveBeenCalledWith({ expected_account_epoch: 'test', catalog_id: 'offer', group_ids: ['a@chatroom', 'b@chatroom'] }));
  await waitFor(() => expect(screen.getByRole('switch', { name: '监听「微信甲」' }).getAttribute('aria-checked')).toBe('true'));
  await waitFor(() => expect((screen.getByRole('button', { name: '一键全部关闭' }) as HTMLButtonElement).disabled).toBe(false));
  expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ group_ids: ['a@chatroom', 'b@chatroom'], approve_selected_storage: true }));
  expect(api.patch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '一键全部关闭' }));
  await waitFor(() => expect(api.select).toHaveBeenLastCalledWith(expect.objectContaining({ group_ids: [] })));
  expect(api.select).toHaveBeenCalledTimes(2);
  expect(api.stop).toHaveBeenCalledWith({ expected_account_epoch: 'test', intake_id: 'intake' });
  expect(api.start).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'b@chatroom' } });
  expect(screen.queryByRole('switch', { name: '监听「微信甲」' })).toBeNull();
  expect(screen.getByRole('switch', { name: '监听「微信乙」' })).toBeTruthy();
});

it('a failed WeChat selection restores switches and reports the failure', async () => {
  api.groups.mockResolvedValue([]);
  api.catalog.mockReturnValue({ scope: { connection_id: 'source', account_epoch: 'test' }, catalog: { catalog_id: 'offer', groups: [{ group_id: 'a@chatroom', name: '微信甲' }] }, selected_group_ids: [] });
  api.select.mockRejectedValue(new Error('人工保存失败'));
  page(); fireEvent.click(screen.getByRole('tab', { name: '微信群' }));
  fireEvent.click(await screen.findByRole('switch', { name: '监听「微信甲」' }));
  await waitFor(() => expect(api.toast).toHaveBeenCalledWith('人工保存失败', 'error'));
  expect(screen.getByRole('switch', { name: '监听「微信甲」' }).getAttribute('aria-checked')).toBe('false');
});

it('bulk enable keeps the previously enabled switch on while the collector restarts', async () => {
  api.groups.mockResolvedValue([]);
  api.catalog.mockReturnValue({ scope: { connection_id: 'source', account_epoch: 'test' }, catalog: { catalog_id: 'offer',
    groups: [{ group_id: 'a@chatroom', name: '微信甲' }, { group_id: 'b@chatroom', name: '微信乙' }] }, selected_group_ids: ['a@chatroom'] });
  api.intake.mockResolvedValue({ state: 'collecting', collecting: true, intake_id: 'old',
    scope: { connection_id: 'source', account_epoch: 'test' }, groups: [{ group_id: 'a@chatroom', pending: 0, deferred: 0 }] });
  let release!: () => void;
  api.start.mockImplementationOnce(input => new Promise<void>(resolve => { release = () => {
    api.intake.mockResolvedValue({ state: 'collecting', collecting: true, intake_id: 'new',
      scope: { connection_id: 'source', account_epoch: 'test' }, groups: input.group_ids.map((group_id: string) => ({ group_id, pending: 0, deferred: 0 })) });
    resolve();
  }; }));
  page(); fireEvent.click(screen.getByRole('tab', { name: '微信群' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: '监听「微信甲」' }).getAttribute('aria-checked')).toBe('true'));
  fireEvent.click(screen.getByRole('button', { name: '一键全部开启' }));
  await waitFor(() => expect(api.start).toHaveBeenCalled());
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(screen.getByRole('switch', { name: '监听「微信甲」' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('switch', { name: '监听「微信乙」' }).getAttribute('aria-checked')).toBe('true');
  expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ group_ids: ['a@chatroom', 'b@chatroom'] }));
  await act(async () => { release(); });
  await waitFor(() => expect((screen.getByRole('button', { name: '一键全部开启' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole('switch', { name: '监听「微信甲」' }).getAttribute('aria-checked')).toBe('true');
});

it('a failed listener start rolls back the saved group and leaves its switch off', async () => {
  api.groups.mockResolvedValue([]);
  const catalog = { scope: { connection_id: 'source', account_epoch: 'test' }, catalog: { catalog_id: 'offer', groups: [{ group_id: 'a@chatroom', name: '微信甲' }] }, selected_group_ids: [] };
  api.catalog.mockReturnValue(catalog);
  api.select.mockImplementation(async input => { api.catalog.mockReturnValue({ ...catalog, selected_group_ids: input.group_ids }); });
  api.start.mockRejectedValue(new Error('人工监听失败'));
  page(); fireEvent.click(screen.getByRole('tab', { name: '微信群' }));
  fireEvent.click(await screen.findByRole('switch', { name: '监听「微信甲」' }));
  await waitFor(() => expect(api.toast).toHaveBeenCalledWith('人工监听失败', 'error'));
  expect(screen.getByRole('switch', { name: '监听「微信甲」' }).getAttribute('aria-checked')).toBe('false');
  expect(api.select).toHaveBeenLastCalledWith(expect.objectContaining({ group_ids: [] }));
});

it('WeChat has course binding, delete and retry through the common group APIs', async () => {
  api.groups.mockResolvedValue([group('wx-stored', { platform: 'wechat', name: '微信甲', enabled: true, collecting: true, message_count: 5, event_count: 1,
    processing_failure: { pending_count: 5, failed_attempts: 3, reason: 'invalid_output', paused: true, next_retry_at: null, last_failed_at: 1000 } })]);
  api.timetable.mockResolvedValue({ courses: [{ name: '高数' }] });
  page(); fireEvent.click(screen.getByRole('tab', { name: '微信群' }));
  fireEvent.change(await screen.findByRole('combobox', { name: '「微信甲」对应课程' }), { target: { value: '高数' } });
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('wx-stored', { course_name: '高数' }));
  expect((screen.getByRole('button', { name: '删除本群数据' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '重试整理' }));
  await waitFor(() => expect(api.retry).toHaveBeenCalledWith('wx-stored'));
  fireEvent.click(screen.getByRole('button', { name: '删除本群数据' }));
  fireEvent.click(screen.getByRole('button', { name: /^删除$/ }));
  await waitFor(() => expect(api.clear).toHaveBeenCalledWith('wx-stored'));
});

it('platform presets are isolated and legacy QQ presets remain readable', async () => {
  savePresets([{ name: 'QQ重要', ids: ['QQ甲'] }]);
  savePresets([{ name: '微信重要', ids: [await wechatBusinessGroupId('wxid_test', 'a@chatroom')] }], 'wechat');
  expect(loadPresets()).toEqual([{ name: 'QQ重要', ids: ['QQ甲'] }]);
  expect(loadPresets('wechat')[0].name).toBe('微信重要');
  api.groups.mockResolvedValue([group('QQ甲'), group('微信甲', { platform: 'wechat' })]);
  page(); await screen.findByText('QQ重要');
  fireEvent.click(screen.getByRole('tab', { name: '微信群' }));
  await screen.findByText('微信重要'); expect(screen.queryByText('QQ重要')).toBeNull();
});

it('blocks competing bulk commands while a single switch save is pending', async () => {
  let release!: () => void; api.patch.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
  page(); fireEvent.click(await screen.findByRole('switch', { name: '监听「人工群」' }));
  expect((screen.getByRole('button', { name: '一键全部开启' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '一键全部开启' }));
  expect(api.patch).toHaveBeenCalledTimes(1);
  await act(async () => { release(); });
});

it('a retained bulk undo cannot mutate a different workspace', async () => {
  page(); fireEvent.click(await screen.findByRole('button', { name: '一键全部开启' }));
  await waitFor(() => expect(api.toast).toHaveBeenCalledWith(expect.any(String), 'info', expect.objectContaining({ label: '撤销' })));
  const undo = api.toast.mock.calls.find((call) => call[2]?.label === '撤销')![2].onClick;
  setCurrentSpace('other-space'); await act(async () => { undo(); });
  expect(api.patch).toHaveBeenCalledTimes(1);
});

it('an earlier toast undo cannot overlap a pending selection save', async () => {
  page(); fireEvent.click(await screen.findByRole('button', { name: '一键全部开启' }));
  await waitFor(() => expect(api.toast).toHaveBeenCalledWith(expect.any(String), 'info', expect.objectContaining({ label: '撤销' })));
  const undo = api.toast.mock.calls.find((call) => call[2]?.label === '撤销')![2].onClick;
  let release!: () => void;
  api.patch.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
  fireEvent.click(screen.getByRole('switch', { name: '监听「人工群」' }));
  await act(async () => { undo(); });
  expect(api.patch).toHaveBeenCalledTimes(2);
  await act(async () => { release(); });
});

it('a bulk operation stops submitting later batches after leaving its page', async () => {
  const rows = Array.from({ length: 9 }, (_, i) => group(`人工群${i}`));
  api.groups.mockResolvedValue(rows);
  const releases: (() => void)[] = [];
  api.patch.mockImplementation(() => new Promise<void>((resolve) => { releases.push(resolve); }));
  const view = page(); fireEvent.click(await screen.findByRole('button', { name: '一键全部开启' }));
  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(8));
  view.unmount(); setCurrentSpace('other-space');
  await act(async () => { releases.forEach((release) => release()); });
  expect(api.patch).toHaveBeenCalledTimes(8); expect(api.toast).not.toHaveBeenCalled();
});
