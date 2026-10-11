import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ intake: vi.fn(), history: vi.fn(), sync: vi.fn() }));
vi.mock('../api/client', () => ({ getWechatIntake: api.intake, refreshWechatHistory: api.history, syncNow: api.sync }));
import { syncAllHistory } from './historySync';

const collecting = { state: 'collecting', error: null, collecting: true, intake_id: 'intake', last_received_at: null,
  scope: { account_epoch: 'epoch', connection_id: 'conn' },
  groups: [{ group_id: 'a@chatroom', pending: 0, deferred: 0 }, { group_id: 'b@chatroom', pending: 0, deferred: 0 }] };

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.intake.mockResolvedValue(collecting);
  api.sync.mockResolvedValue({ groups: 3, messages: 10, failures: 0 });
  api.history.mockResolvedValue({ inserted: 1, has_more: false });
});

describe('统一补拉历史', () => {
  it('QQ 与微信同时补拉，微信只遍历正在监听的群并续页', async () => {
    api.history.mockResolvedValueOnce({ inserted: 100, has_more: true }).mockResolvedValueOnce({ inserted: 5, has_more: false })
      .mockResolvedValueOnce({ inserted: 2, has_more: false });
    const res = await syncAllHistory(7, { epoch: 'epoch', qq: true, wechat: true });
    expect(api.sync).toHaveBeenCalledWith(7);
    expect(api.history.mock.calls.map((c) => [c[0].group_id, c[0].continue_existing, c[0].days])).toEqual([
      ['a@chatroom', false, 7], ['a@chatroom', true, 7], ['b@chatroom', false, 7]]);
    expect(api.history.mock.calls[0]?.[0]).toMatchObject({ expected_account_epoch: 'epoch', intake_id: 'intake', approve_history_read: true });
    expect(res).toEqual({ qq: { groups: 3, messages: 10, failures: 0 },
      wechat: { groups: 2, messages: 107, skipped: [], failed: false }, errors: [] });
  });

  it('报告 QQ 完成及微信逐页、逐群的实际进度', async () => {
    const progress = vi.fn();
    api.history.mockResolvedValueOnce({ inserted: 2, has_more: true })
      .mockResolvedValueOnce({ inserted: 3, has_more: false })
      .mockResolvedValueOnce({ inserted: 1, has_more: false });
    await syncAllHistory(1, { epoch: 'epoch', qq: true, wechat: true, onProgress: progress });
    expect(progress).toHaveBeenCalledWith({ kind: 'qq_done' });
    expect(progress.mock.calls.map(([event]) => event).filter(event => event.kind !== 'qq_done')).toEqual([
      { kind: 'wechat_start', total: 2 },
      { kind: 'wechat_request', completed: 0, total: 2, page: 1, group_id: 'a@chatroom' },
      { kind: 'wechat_page', completed: 0, total: 2, page: 1, messages: 2 },
      { kind: 'wechat_request', completed: 0, total: 2, page: 2, group_id: 'a@chatroom' },
      { kind: 'wechat_page', completed: 0, total: 2, page: 2, messages: 5 },
      { kind: 'wechat_group_done', completed: 1, total: 2, messages: 5, skipped: false },
      { kind: 'wechat_request', completed: 1, total: 2, page: 1, group_id: 'b@chatroom' },
      { kind: 'wechat_page', completed: 1, total: 2, page: 1, messages: 6 },
      { kind: 'wechat_group_done', completed: 2, total: 2, messages: 6, skipped: false },
    ]);
  });

  it('某个微信群读取失败时跳过该群，换用重启后的采集继续下一个群', async () => {
    api.intake.mockResolvedValue({ ...collecting, groups: [...collecting.groups, { group_id: 'c@chatroom', pending: 0, deferred: 0 }] });
    api.history.mockResolvedValueOnce({ inserted: 3, has_more: true })
      .mockResolvedValueOnce({ inserted: 0, has_more: false, skipped: 'WECHAT_MESSAGE_SELECTED_GROUP_NOT_FOUND', intake_id: 'intake-2' })
      .mockResolvedValueOnce({ inserted: 2, has_more: false })
      .mockResolvedValueOnce({ inserted: 4, has_more: false });
    const res = await syncAllHistory(7, { epoch: 'epoch', qq: false, wechat: true });
    expect(api.history.mock.calls.map((c) => [c[0].group_id, c[0].intake_id])).toEqual([
      ['a@chatroom', 'intake'], ['a@chatroom', 'intake'], ['b@chatroom', 'intake-2'], ['c@chatroom', 'intake-2']]);
    expect(res.wechat).toEqual({ groups: 2, messages: 9, failed: false,
      skipped: [{ group_id: 'a@chatroom', reason: 'WECHAT_MESSAGE_SELECTED_GROUP_NOT_FOUND' }] });
    expect(res.errors).toEqual([]);
  });

  it('达到微信翻页上限仍有后续页时报告未补全', async () => {
    api.intake.mockResolvedValue({ ...collecting, groups: [collecting.groups[0]] });
    api.history.mockResolvedValue({ inserted: 1, has_more: true });
    const progress = vi.fn();
    const res = await syncAllHistory(30, { epoch: 'epoch', qq: false, wechat: true, onProgress: progress });
    expect(api.history).toHaveBeenCalledTimes(200);
    expect(res.wechat?.skipped).toEqual([{ group_id: 'a@chatroom', reason: 'WECHAT_HISTORY_PAGE_LIMIT' }]);
    expect(progress).toHaveBeenCalledWith({ kind: 'wechat_group_done', completed: 1, total: 1, messages: 200, skipped: true });
  });

  it('微信空间不一致时明确报告失败，不把未读取误报为无新增消息', async () => {
    api.intake.mockResolvedValue({ ...collecting, scope: { account_epoch: 'other', connection_id: 'conn' } });
    const res = await syncAllHistory(1, { epoch: 'epoch', qq: false, wechat: true });
    expect(api.sync).not.toHaveBeenCalled(); expect(api.history).not.toHaveBeenCalled();
    expect(res.wechat?.failed).toBe(true);
    expect(res.errors).toEqual([{ platform: '微信', error: expect.objectContaining({ message: expect.stringContaining('空间已变化') }) }]);
  });

  it('点击后监听已停止时明确报告，QQ 补拉仍正常完成', async () => {
    api.intake.mockResolvedValue({ ...collecting, collecting: false, intake_id: null, scope: null });
    const res = await syncAllHistory(1, { epoch: 'epoch', qq: true, wechat: true });
    expect(res.qq?.messages).toBe(10);
    expect(res.errors[0]?.error).toMatchObject({ message: expect.stringContaining('已停止监听') });
    expect(api.history).not.toHaveBeenCalled();
  });

  it('等待当前页时停止，保留已读取数量且不续页、不开始后续群、不误报页上限', async () => {
    let alive = true;
    let finish!: (page: { inserted: number; has_more: boolean }) => void;
    api.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const progress = vi.fn();
    const work = syncAllHistory(7, { epoch: 'epoch', qq: false, wechat: true, alive: () => alive, onProgress: progress });
    await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(1));
    expect(progress).toHaveBeenCalledWith({ kind: 'wechat_request', completed: 0, total: 2, page: 1, group_id: 'a@chatroom' });
    alive = false;
    finish({ inserted: 4, has_more: true });
    const res = await work;
    expect(api.history).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ cancelled: true, wechat: { groups: 0, messages: 4, skipped: [], failed: false }, errors: [] });
    expect(progress.mock.calls.some(([event]) => event.kind === 'wechat_group_done')).toBe(false);
  });

  it('状态请求返回前取消后，不发出任何历史页请求', async () => {
    let alive = true;
    api.intake.mockImplementationOnce(async () => { alive = false; return collecting; });
    const res = await syncAllHistory(7, { epoch: 'epoch', qq: false, wechat: true, alive: () => alive });
    expect(res.cancelled).toBe(true);
    expect(api.history).not.toHaveBeenCalled();
  });

  it('微信无法恢复时停止并保留已补入数量，不影响 QQ 结果', async () => {
    const boom = new Error('微信读取失败');
    api.history.mockResolvedValueOnce({ inserted: 4, has_more: false }).mockRejectedValueOnce(boom);
    const res = await syncAllHistory(30, { epoch: 'epoch', qq: true, wechat: true });
    expect(res.qq?.messages).toBe(10);
    expect(res.wechat).toEqual({ groups: 1, messages: 4, skipped: [], failed: true });
    expect(res.errors).toEqual([{ platform: '微信', error: boom }]);
  });

  it('QQ 请求失败时保留平台和错误，不把未知结果报成零个群失败', async () => {
    const boom = new Error('请求超时');
    api.sync.mockRejectedValueOnce(boom);
    const res = await syncAllHistory(7, { epoch: 'epoch', qq: true, wechat: true });
    expect(res.qq).toBeNull();
    expect(res.wechat?.groups).toBe(2);
    expect(res.errors).toEqual([{ platform: 'QQ', error: boom }]);
  });
});
