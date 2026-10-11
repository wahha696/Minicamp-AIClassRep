import { beforeEach, expect, it, vi } from 'vitest';
import type { WechatCatalogDTO, WechatIntakeDTO } from '../../../../shared/wechat';
const api = vi.hoisted(() => ({ status: vi.fn(), select: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock('../api/client', () => ({ getWechatIntake: api.status, selectWechatGroups: api.select,
  startWechatIntake: api.start, stopWechatIntake: api.stop }));
import { changeWechatListening } from './wechat-listening';
const catalog: WechatCatalogDTO = { state: 'ready', collecting: false, error: null,
  scope: { account_epoch: 'epoch', connection_id: 'connection' }, selected_group_ids: ['stale@chatroom'],
  catalog: { catalog_id: 'catalog', groups: ['a@chatroom', 'b@chatroom', 'stale@chatroom'].map(group_id => ({ group_id, name: group_id })) } };
const idle: WechatIntakeDTO = { state: 'idle', collecting: false, error: null, intake_id: null, last_received_at: null, scope: null, groups: [] };
const running: WechatIntakeDTO = { ...idle, state: 'collecting', collecting: true, intake_id: 'intake', scope: catalog.scope,
  groups: [{ group_id: 'a@chatroom', pending: 0, deferred: 0 }, { group_id: 'b@chatroom', pending: 0, deferred: 0 }] };
beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset());
  api.status.mockResolvedValue(idle); api.select.mockResolvedValue({}); api.start.mockResolvedValue({}); api.stop.mockResolvedValue({});
});
const change = (source: string, enabled: boolean, current = () => true) => changeWechatListening(catalog, 'epoch', [{ source, enabled }], current);

it('opening one group starts listening immediately and does not resurrect an old idle selection', async () => {
  await change('a@chatroom', true);
  expect(api.select).toHaveBeenCalledWith({ expected_account_epoch: 'epoch', catalog_id: 'catalog', group_ids: ['a@chatroom'] });
  expect(api.start).toHaveBeenCalledWith({ expected_account_epoch: 'epoch', connection_id: 'connection', catalog_id: 'catalog',
    group_ids: ['a@chatroom'], approve_key_read: true, approve_message_read: true, approve_selected_storage: true });
  expect(api.stop).not.toHaveBeenCalled();
});

it('closing one group immediately stops its old scope and resumes the remaining group', async () => {
  api.status.mockResolvedValue(running);
  await change('a@chatroom', false);
  expect(api.stop).toHaveBeenCalledWith({ expected_account_epoch: 'epoch', intake_id: 'intake' });
  expect(api.start).toHaveBeenCalledWith(expect.objectContaining({ group_ids: ['b@chatroom'] }));
  expect(api.stop.mock.invocationCallOrder[0]).toBeLessThan(api.select.mock.invocationCallOrder[0]);
  expect(api.select.mock.invocationCallOrder[0]).toBeLessThan(api.start.mock.invocationCallOrder[0]);
});

it('bulk enable adds disabled groups while preserving all running groups', async () => {
  api.status.mockResolvedValue(running);
  await changeWechatListening(catalog, 'epoch', [{ source: 'stale@chatroom', enabled: true }], () => true);
  expect(api.start).toHaveBeenLastCalledWith(expect.objectContaining({ group_ids: ['a@chatroom', 'b@chatroom', 'stale@chatroom'] }));
});

it('an already enabled group never causes a restart', async () => {
  api.status.mockResolvedValue(running);
  await change('a@chatroom', true);
  expect(api.stop).not.toHaveBeenCalled(); expect(api.select).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled();
});

it('closing all groups stops without starting an empty collector', async () => {
  api.status.mockResolvedValue(running);
  await changeWechatListening(catalog, 'epoch', [{ source: 'a@chatroom', enabled: false }, { source: 'b@chatroom', enabled: false }], () => true);
  expect(api.select).toHaveBeenCalledWith(expect.objectContaining({ group_ids: [] }));
  expect(api.start).not.toHaveBeenCalled();
});

it('a failed first start rolls back selection and never resumes previously idle groups', async () => {
  api.start.mockRejectedValue(new Error('缺少群记录'));
  await expect(change('a@chatroom', true)).rejects.toThrow('缺少群记录');
  expect(api.select).toHaveBeenLastCalledWith(expect.objectContaining({ group_ids: [] }));
  expect(api.start).toHaveBeenCalledTimes(1);
});

it('a failed reconfiguration restores the formerly running groups', async () => {
  api.status.mockResolvedValue(running);
  api.start.mockRejectedValueOnce(new Error('人工启动失败')).mockResolvedValueOnce({});
  await expect(change('stale@chatroom', true)).rejects.toThrow('人工启动失败');
  expect(api.select).toHaveBeenLastCalledWith(expect.objectContaining({ group_ids: ['a@chatroom', 'b@chatroom'] }));
  expect(api.start).toHaveBeenLastCalledWith(expect.objectContaining({ group_ids: ['a@chatroom', 'b@chatroom'] }));
});

it('refuses a different account or an in-progress start without writing', async () => {
  api.status.mockResolvedValue({ ...running, scope: { account_epoch: 'changed', connection_id: 'other' } });
  await expect(change('a@chatroom', true)).rejects.toThrow('连接已变化');
  api.status.mockResolvedValue({ ...running, state: 'opening', collecting: false });
  await expect(change('a@chatroom', true)).rejects.toThrow('正在启动');
  expect(api.select).not.toHaveBeenCalled(); expect(api.stop).not.toHaveBeenCalled();
});

it('does not resume or roll back into a new account after a delayed save', async () => {
  let current = true;
  api.select.mockImplementationOnce(async () => { current = false; });
  await expect(change('a@chatroom', true, () => current)).rejects.toThrow('连接已变化');
  expect(api.select).toHaveBeenCalledTimes(1); expect(api.start).not.toHaveBeenCalled();
});
