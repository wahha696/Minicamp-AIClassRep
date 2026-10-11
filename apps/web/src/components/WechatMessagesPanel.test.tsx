// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), stop: vi.fn(), history: vi.fn(), issues: vi.fn(), retry: vi.fn() }));
vi.mock('../api/client', () => ({ getWechatIntake: api.status, startWechatIntake: api.start, stopWechatIntake: api.stop,
  refreshWechatHistory: api.history, getWechatIssues: api.issues, retryWechatIssues: api.retry }));
import WechatMessagesPanel from './WechatMessagesPanel';
const idle = { state: 'idle', error: null, collecting: false, intake_id: null, scope: null, groups: [] };
const running = { ...idle, state: 'collecting', collecting: true, intake_id: 'synthetic-intake',
  scope: { account_epoch: 'synthetic-epoch', connection_id: 'synthetic-source' },
  groups: [{ group_id: 'synthetic@chatroom', pending: 0, deferred: 1 }] };
beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.status.mockResolvedValue(idle); api.start.mockResolvedValue({ ok: true }); api.stop.mockResolvedValue({ ok: true });
  api.history.mockResolvedValue({ inserted: 1, has_more: false }); api.issues.mockResolvedValue([]); api.retry.mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function panel(selectionDirty = false) {
  return render(<WechatMessagesPanel epoch="synthetic-epoch" connectionId="synthetic-source" catalogId="synthetic-catalog"
    groups={[{ group_id: 'synthetic@chatroom', name: '人工群' }]} selectionDirty={selectionDirty} />);
}
describe('微信消息采集与历史操作', () => {
  it('does not report stopped intake when status is unavailable, and clears read errors on recovery', async () => {
    vi.useFakeTimers(); api.status.mockRejectedValueOnce(new Error('人工读取失败')).mockResolvedValue(running);
    await act(async () => { panel(); });
    expect(screen.getByText('人工读取失败')).toBeTruthy();
    expect(screen.queryByText(/未监听微信群/)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByText('人工读取失败')).toBeNull();
    expect(screen.getByText(/正在监听 1 个群/)).toBeTruthy();
  });
  it('shows status without a second consent or start/pause control and never starts on mount', async () => {
    panel(); await screen.findByText(/未监听微信群/);
    expect(screen.queryByLabelText('允许所选微信群消息采集')).toBeNull();
    expect(screen.queryByRole('button', { name: '开始采集所选群' })).toBeNull();
    expect(screen.queryByRole('button', { name: '暂停微信采集' })).toBeNull();
    expect(api.start).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled();
  });
  it('no longer offers per-group history refresh (unified 补拉历史 handles it)', async () => {
    api.status.mockResolvedValue(running);
    panel(); fireEvent.click(await screen.findByText('未整理消息'));
    expect(screen.queryByRole('button', { name: /刷新 \d+ 天/ })).toBeNull();
    expect(screen.queryByLabelText('允许刷新微信历史')).toBeNull();
    expect(api.history).not.toHaveBeenCalled();
  });
  it('shows deferred messages without bodies and retries only explicit IDs', async () => {
    api.status.mockResolvedValue(running);
    api.issues.mockResolvedValue([{ event_id: 'a'.repeat(64), group_id: 'synthetic@chatroom', reason: 'DELIVERY_MESSAGE_TYPE_UNSUPPORTED' }]);
    panel(); await screen.findByText(/有 1 条消息暂未支持或解码/);
    fireEvent.click(screen.getByText('未整理消息'));
    fireEvent.click(screen.getByRole('button', { name: '查看暂未整理的消息' }));
    await screen.findByText('暂不支持的图片、语音或其他消息');
    expect(api.retry).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '重试以上消息' }));
    await waitFor(() => expect(api.retry).toHaveBeenCalledWith({ expected_account_epoch: 'synthetic-epoch', intake_id: 'synthetic-intake',
      group_id: 'synthetic@chatroom', event_ids: ['a'.repeat(64)] }));
  });
});
