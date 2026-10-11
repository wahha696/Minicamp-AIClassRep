import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { WechatIntake } from '../ingest/wechat-intake.js';
import type { WechatCatalog } from '../ingest/wechat-catalog.js';
import { registerWechatMessageRoutes } from './wechat-messages.js';

function fixture() {
  const context = { connection_id: randomUUID(), expected_account_epoch: 'synthetic-epoch', catalog_id: randomUUID(), group_ids: ['synthetic@chatroom'] };
  const intake = { status: vi.fn(() => ({ collecting: false })), start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    history: vi.fn(async () => ({ inserted: 1, has_more: false })), issues: vi.fn(async () => []), retryIssues: vi.fn(async () => {}) };
  const catalog = { selectedScope: vi.fn(() => ({ connectionId: context.connection_id, epoch: context.expected_account_epoch,
    groups: [{ group_id: 'synthetic@chatroom', name: '人工群' }] })), catalog: vi.fn(() => ({ catalog_id: context.catalog_id })) };
  const app = new Hono(); registerWechatMessageRoutes(app, intake as unknown as WechatIntake, catalog as unknown as WechatCatalog);
  const request = (action: string, body?: unknown, address = '127.0.0.1') => app.request(`http://localhost/api/connect/wechat/messages/${action}`,
    { method: action === 'status' ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, { incoming: { socket: { remoteAddress: address } } });
  return { context, intake, request };
}
describe('local selected-message routes', () => {
  it('requires all consents and exact current selection, excluding arbitrary account/path fields', async () => {
    const f = fixture(); const body = { ...f.context, approve_key_read: true, approve_message_read: true, approve_selected_storage: true };
    for (const input of [{ ...body, approve_message_read: false }, { ...body, account: 'private' }, { ...body, receipt_path: 'C:\\private' }]) {
      expect((await f.request('start', input)).status).toBe(400);
    }
    expect((await f.request('start', { ...body, group_ids: ['other@chatroom'] })).status).toBe(409);
    expect(f.intake.start).not.toHaveBeenCalled();
    expect((await f.request('start', body)).status).toBe(200);
  });
  it('keeps status/history/issues and source-start local, with no raw failure reflection', async () => {
    const f = fixture();
    for (const action of ['status', 'start', 'history', 'issues', 'retry']) expect((await f.request(action, action === 'status' ? undefined : {}, '192.168.1.2')).status).toBe(403);
    expect(f.intake.status).not.toHaveBeenCalled(); expect(f.intake.start).not.toHaveBeenCalled();
    f.intake.start.mockRejectedValueOnce(new Error('PRIVATE_BODY_PATH'));
    const response = await f.request('start', { ...f.context, approve_key_read: true, approve_message_read: true, approve_selected_storage: true });
    expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toContain('PRIVATE');
  });
  it('only supports explicit 1/7/30 day history, and carries continuation without source cursors', async () => {
    const f = fixture(); const body = { expected_account_epoch: 'synthetic-epoch', intake_id: randomUUID(),
      group_id: 'synthetic@chatroom', days: 7, approve_history_read: true, continue_existing: true };
    expect((await f.request('history', { ...body, days: 365 })).status).toBe(400);
    expect((await f.request('history', { ...body, approve_history_read: false })).status).toBe(400);
    expect(await (await f.request('history', body)).json()).toEqual({ inserted: 1, has_more: false });
    expect(f.intake.history).toHaveBeenCalledWith(body.expected_account_epoch, body.intake_id, body.group_id, 7, true, true);
  });
});
