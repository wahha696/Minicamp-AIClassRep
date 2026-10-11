// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ sync: vi.fn(), health: vi.fn(), toast: vi.fn() }));
vi.mock('../lib/historySync', () => ({ syncAllHistory: api.sync }));
vi.mock('../api/client', () => ({ getHealth: api.health }));
vi.mock('./Toast', () => ({ useToast: () => api.toast }));
vi.mock('./ConnectStatus', () => ({
  useConnectStatus: () => ({ data: { state: 'online', wechat: 'collecting', account_epoch: 'epoch' } }),
  useAccess: () => ({ readonly: false, demoAvailable: false }),
}));
vi.mock('./ReturnQQ', () => ({ default: () => null }));
vi.mock('./StatusLights', () => ({ default: () => null }));
vi.mock('./ConnectBanner', () => ({ default: () => null }));
vi.mock('./Avatar', () => ({ default: () => null }));
vi.mock('./Pet', () => ({ default: () => null }));
import Layout from './Layout';

afterEach(() => { cleanup(); Object.values(api).forEach(fn => fn.mockReset()); });

it('切换页面后补拉与顶部进度保持运行', async () => {
  let finish!: (result: unknown) => void;
  api.sync.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<MemoryRouter initialEntries={['/groups']}><Routes><Route element={<Layout />}>
    <Route path="groups" element={<p>群页面</p>} />
    <Route path="week" element={<p>周页面</p>} />
  </Route></Routes></MemoryRouter>);

  fireEvent.click(screen.getByRole('button', { name: '补拉历史消息' }));
  fireEvent.click(screen.getByRole('button', { name: '补回最近 7 天' }));
  await waitFor(() => expect(api.sync).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getAllByRole('link', { name: '本周' })[0]);
  expect(screen.getByText('周页面')).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '微信历史读取进度' })).toBeTruthy();

  await act(async () => {
    api.sync.mock.calls[0][1].onProgress({ kind: 'wechat_start', total: 2 });
    api.sync.mock.calls[0][1].onProgress({ kind: 'wechat_group_done', completed: 1, total: 2, messages: 4, skipped: false });
  });
  expect(screen.getByText(/微信已尝试 1\/2 群/)).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');

  await act(async () => finish({ qq: { groups: 0, messages: 0, failures: 0 },
    wechat: { groups: 2, messages: 4, skipped: [], failed: false }, errors: [] }));
  expect(api.toast).toHaveBeenCalledWith('补回 4 条消息，正在整理…');
});

it('微信尝试完毕但 QQ 仍在运行时不显示整体接近完成，并保留失败结果', async () => {
  let finish!: (result: unknown) => void;
  api.sync.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<MemoryRouter><Layout /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '补拉历史消息' }));
  fireEvent.click(screen.getByRole('button', { name: '补回最近 7 天' }));
  await act(async () => {
    api.sync.mock.calls[0][1].onProgress({ kind: 'wechat_start', total: 2 });
    api.sync.mock.calls[0][1].onProgress({ kind: 'wechat_group_done', completed: 1, total: 2, messages: 0, skipped: true });
    api.sync.mock.calls[0][1].onProgress({ kind: 'wechat_group_done', completed: 2, total: 2, messages: 0, skipped: false });
  });
  expect(screen.getByText(/QQ 补拉中，暂无法估算剩余时间/)).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '微信历史读取进度' }).getAttribute('aria-valuenow')).toBe('2');
  expect(screen.getByText(/跳过 1 群/)).toBeTruthy();
  await act(async () => finish({ qq: { groups: 3, messages: 0, failures: 1 },
    wechat: { groups: 1, messages: 0, skipped: [{ group_id: 'a@chatroom', reason: 'WECHAT_HISTORY_PAGE_LIMIT' }], failed: false }, errors: [] }));
  expect(screen.getByRole('alert').textContent).toContain('1 个微信群跳过');
});

it('QQ 整段请求失败时显示平台与原因，不误报为 0 个群未补全', async () => {
  api.sync.mockResolvedValue({ qq: null, wechat: { groups: 2, messages: 0, skipped: [], failed: false },
    errors: [{ platform: 'QQ', error: new Error('请求超时') }] });
  render(<MemoryRouter><Layout /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '补拉历史消息' }));
  fireEvent.click(screen.getByRole('button', { name: '补回最近 7 天' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('QQ补拉失败：请求超时'));
  expect(screen.getByRole('alert').textContent).not.toContain('0 个 QQ 群未补全');
});

it('停止后续补拉会撤销续页许可，等待当前请求结束并保留部分成果', async () => {
  let finish!: (result: unknown) => void;
  api.sync.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<MemoryRouter><Layout /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '补拉历史消息' }));
  fireEvent.click(screen.getByRole('button', { name: '补回最近 7 天' }));
  const options = api.sync.mock.calls[0][1];
  await act(async () => {
    options.onProgress({ kind: 'wechat_start', total: 2 });
    options.onProgress({ kind: 'wechat_request', completed: 0, total: 2, page: 1, group_id: 'synthetic@chatroom' });
  });
  expect(screen.getByText('正在读取群 synthetic@chatroom 的第 1 页…')).toBeTruthy();
  expect(options.alive()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '停止后续补拉' }));
  expect(options.alive()).toBe(false);
  expect(screen.getByText(/正在等待当前请求结束/)).toBeTruthy();
  expect((screen.getByRole('button', { name: '补拉历史消息' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish({ qq: null, wechat: { groups: 0, messages: 4, skipped: [], failed: false }, errors: [], cancelled: true }));
  expect(screen.getByRole('alert').textContent).toContain('已读取的消息保留');
  expect(api.toast).toHaveBeenCalledWith('补回 4 条消息，正在整理…');
  expect(api.toast).not.toHaveBeenCalledWith('本次范围内没有新增消息');
});
