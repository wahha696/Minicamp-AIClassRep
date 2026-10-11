// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HistoryJobDTO } from '../../../../shared/history-jobs';
const api = vi.hoisted(() => ({ list: vi.fn(), start: vi.fn(), cancel: vi.fn(), retry: vi.fn(), health: vi.fn(), epoch: 'epoch' }));
vi.mock('../api/history-jobs', () => ({ getHistoryJobs: api.list, startHistoryJob: api.start, cancelHistoryJob: api.cancel, retryHistoryJob: api.retry }));
vi.mock('../api/client', () => ({ getHealth: api.health }));
vi.mock('./ConnectStatus', () => ({ useConnectStatus: () => ({ data: { state: 'online', wechat: 'collecting', account_epoch: api.epoch } }), useAccess: () => ({ readonly: false }) }));
import SyncButton from './SyncButton';
const job = (over: Partial<HistoryJobDTO> = {}): HistoryJobDTO => ({ id: 'job-qq', platform: 'qq', days: 7,
  status: 'running', created_at: 1, updated_at: 1, groups_total: 2, groups_completed: 0,
  pages: 3, messages: 12, current_group_id: 'synthetic-group', error: null, retryable: false,
  groups: [{ group_id: 'synthetic-group', status: 'running', pages: 3, messages: 12, error: null }], ...over });
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
beforeEach(() => {
  vi.useFakeTimers(); api.epoch = 'epoch';
  api.list.mockResolvedValue({ jobs: [] }); api.health.mockResolvedValue({ pending: 5, llm: 'ok' });
  api.start.mockImplementation(async (_epoch, platform) => ({ job: job({ id: `job-${platform}`, platform }) }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); [api.list, api.start, api.cancel, api.retry, api.health].forEach(fn => fn.mockReset()); });

it('恢复服务器现有任务，页面重新挂载不启动重复QQ/微信补拉', async () => {
  api.list.mockResolvedValue({ jobs: [job(), job({ id: 'job-wechat', platform: 'wechat', messages: 24 })] });
  const first = render(<SyncButton />); await flush();
  expect(screen.getByText(/QQ 补拉中 · 已补入 12 条/)).toBeTruthy();
  expect(screen.getByText(/微信 补拉中 · 已补入 24 条/)).toBeTruthy();
  expect(screen.getAllByText(/正在读取第 4 页/)).toHaveLength(2);
  first.unmount(); render(<SyncButton />); await flush();
  expect(api.start).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: '补拉历史消息' }) as HTMLButtonElement).disabled).toBe(true);
});

it('两平台只创建一次任务，重复点击被同步锁拦截', async () => {
  render(<SyncButton />); await flush();
  fireEvent.click(screen.getByRole('button', { name: '补拉历史消息' }));
  const pick = screen.getByRole('button', { name: '补回最近 7 天' });
  fireEvent.click(pick); fireEvent.click(pick); await flush();
  expect(api.start.mock.calls).toEqual([['epoch', 'qq', 7], ['epoch', 'wechat', 7]]);
});

it('正常补拉数小时仍显示正在执行，不用总耗时宣告失败', async () => {
  api.list.mockResolvedValue({ jobs: [job()] });
  render(<SyncButton />); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60 * 60_000); });
  expect(screen.getByText(/QQ 补拉中 · 已补入 12 条/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.start).not.toHaveBeenCalled();
});

it('状态连接失败保留数量并自动重连，不宣告任务失败或重启任务', async () => {
  api.list.mockResolvedValueOnce({ jobs: [job()] }).mockRejectedValueOnce(new Error('暂时无法确认后台状态，正在重连'))
    .mockResolvedValue({ jobs: [job({ messages: 30, pages: 5, updated_at: 3 })] });
  render(<SyncButton />); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.getByRole('alert').textContent).toContain('正在重连');
  expect(screen.getByText('以下为最后确认的进度，连接恢复后会自动更新。')).toBeTruthy();
  expect(screen.getByText(/已补入 12 条/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText(/已补入 30 条/)).toBeTruthy();
  expect(api.start).not.toHaveBeenCalled();
});

it('QQ和微信均可取消，保留当前页成果，并从服务器记录恢复', async () => {
  const stopped = job({ status: 'cancelled', retryable: true, updated_at: 3 });
  api.list.mockResolvedValue({ jobs: [job()] });
  api.cancel.mockResolvedValue({ job: stopped }); api.retry.mockResolvedValue({ job: job({ updated_at: 4 }) });
  render(<SyncButton />); await flush();
  fireEvent.click(screen.getByRole('button', { name: '停止 QQ 后续补拉' })); await flush();
  expect(api.cancel).toHaveBeenCalledWith('epoch', 'job-qq');
  expect(screen.getByText(/已补入记录保留；重试会恢复未完成部分/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '恢复 QQ 补拉' })); await flush();
  expect(api.retry).toHaveBeenCalledWith('epoch', 'job-qq');
  expect(screen.getByText(/QQ 补拉中/)).toBeTruthy();
});

it('后台重启中断显示原因及恢复入口，失败群不会误报整体完成', async () => {
  api.list.mockResolvedValue({ jobs: [job({ status: 'interrupted', retryable: true, error: '后台已重启，请恢复未完成任务',
    groups: [{ group_id: 'synthetic-group', status: 'failed', pages: 3, messages: 12, error: 'QQ连接已断开' }] })] });
  render(<SyncButton />); await flush();
  expect(screen.getByText(/后台重启后中断/)).toBeTruthy();
  expect(screen.getByText(/QQ连接已断开/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '恢复 QQ 补拉' })).toBeTruthy();
});

it('创建响应丢失后自动读取已有后台任务，绝不再次提交', async () => {
  api.start.mockRejectedValue(new Error('状态未知，请勿重复启动'));
  render(<SyncButton />); await flush();
  fireEvent.click(screen.getByRole('button', { name: '补拉历史消息' }));
  fireEvent.click(screen.getByRole('button', { name: '补回最近 7 天' })); await flush();
  expect(screen.getByRole('alert').textContent).toContain('状态未知');
  api.list.mockResolvedValue({ jobs: [job()] });
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.getByText(/QQ 补拉中/)).toBeTruthy(); expect(api.start).toHaveBeenCalledTimes(2);
});

it('换空间后忽略旧作用域返回，不泄露旧空间进度', async () => {
  let finish!: (value: unknown) => void;
  api.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<SyncButton />); await flush();
  api.epoch = 'new-epoch'; view.rerender(<SyncButton />); await flush();
  await act(async () => { finish({ jobs: [job()] }); });
  expect(screen.queryByText(/已补入 12 条/)).toBeNull();
});

it('旧状态响应晚于取消返回时，不把已取消任务回滚为运行中', async () => {
  let oldReply!: (value: unknown) => void;
  api.list.mockResolvedValueOnce({ jobs: [job()] }).mockImplementationOnce(() => new Promise(resolve => { oldReply = resolve; }));
  api.cancel.mockResolvedValue({ job: job({ status: 'cancelled', retryable: true, updated_at: 2 }) });
  render(<SyncButton />); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  fireEvent.click(screen.getByRole('button', { name: '停止 QQ 后续补拉' })); await flush();
  await act(async () => { oldReply({ jobs: [job()] }); });
  expect(screen.getByRole('button', { name: '恢复 QQ 补拉' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '停止 QQ 后续补拉' })).toBeNull();
});

it('微信和QQ分别取消，不把一个平台取消误认为另一个也停止', async () => {
  const wechat = job({ id: 'job-wechat', platform: 'wechat' });
  api.list.mockResolvedValue({ jobs: [job(), wechat] });
  api.cancel.mockResolvedValue({ job: { ...wechat, status: 'cancelling', updated_at: 2 } });
  render(<SyncButton />); await flush();
  fireEvent.click(screen.getByRole('button', { name: '停止 微信 后续补拉' })); await flush();
  expect(api.cancel).toHaveBeenCalledWith('epoch', 'job-wechat');
  expect(screen.getByText(/QQ 补拉中/)).toBeTruthy();
  expect(screen.getByText(/微信 正在停止后续补拉/)).toBeTruthy();
});

it('QQ单页超过180秒保持原任务等待，迟到结果到达后正常完成且不重发', async () => {
  const startedAt = Date.now();
  let phase: 'waiting' | 'complete' = 'waiting';
  api.list.mockImplementation(async () => ({ jobs: [phase === 'complete'
    ? job({ status: 'completed', messages: 18, pages: 4, groups_completed: 2, current_group_id: null, waiting_since: null, updated_at: startedAt + 600_000 })
    : job({ waiting_since: Date.now() - startedAt >= 180_000 ? startedAt + 180_000 : null, updated_at: Date.now() })] }));
  render(<SyncButton />); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(183_000); });
  expect(screen.getByText(/正在继续等待原请求，已存进度保留/)).toBeTruthy();
  expect(screen.getByText(/QQ 补拉中 · 已补入 12 条/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '停止 QQ 后续补拉' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '恢复 QQ 补拉' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(360_000); });
  phase = 'complete';
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.getByText(/QQ 补拉完成 · 已补入 18 条/)).toBeTruthy();
  expect(screen.queryByText(/正在继续等待原请求/)).toBeNull();
  expect(api.start).not.toHaveBeenCalled(); expect(api.retry).not.toHaveBeenCalled();
});

it('长等待期间刷新仍观察原任务，网络观察中断不冒充任务确定失败', async () => {
  const waiting = job({ waiting_since: Date.now() - 200_000 });
  api.list.mockResolvedValue({ jobs: [waiting] });
  const view = render(<SyncButton />); await flush(); view.unmount(); render(<SyncButton />); await flush();
  expect(screen.getByText(/正在继续等待原请求/)).toBeTruthy();
  api.list.mockRejectedValueOnce(new Error('暂时无法确认后台状态，正在重连'));
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.getByRole('alert').textContent).toContain('正在重连');
  expect(screen.getByText(/QQ 补拉中 · 已补入 12 条/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '恢复 QQ 补拉' })).toBeNull();
  api.list.mockResolvedValue({ jobs: [job({ status: 'failed', waiting_since: null, retryable: true, error: 'HISTORY_PAGE_UNAVAILABLE', updated_at: Date.now() })] });
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText(/QQ 部分记录未补全/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '恢复 QQ 补拉' })).toBeTruthy();
  expect(api.start).not.toHaveBeenCalled(); expect(api.retry).not.toHaveBeenCalled();
});

it('QQ取消等待和微信保存当前页后停止的说明分别对应服务端行为', async () => {
  api.list.mockResolvedValue({ jobs: [job({ status: 'cancelling' }), job({ id: 'wx', platform: 'wechat', status: 'cancelling' })] });
  render(<SyncButton />); await flush();
  expect(screen.getByText('正在取消等待，保留已保存进度。')).toBeTruthy();
  expect(screen.getByText('当前页保存后停止，已补入记录保留。')).toBeTruthy();
});
