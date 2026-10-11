import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { accountEpoch } from '../accounts.js';
import { accessGuard } from '../lan-guard.js';
import type { WechatCatalog } from '../ingest/wechat-catalog.js';
import { registerWechatGroupRoutes } from './wechat-groups.js';

function fixture() {
  const offer = { catalog_id: randomUUID(), groups: [{ group_id: 'synthetic@chatroom', name: '人工群 😀' }] };
  const refresh = vi.fn(async () => offer);
  const catalog = { status: vi.fn(() => ({ state: 'ready', error: null, collecting: false })), catalog: vi.fn(() => offer), refresh,
    scope: vi.fn(() => ({ connection_id: 'synthetic-source', account_epoch: 'synthetic-epoch' })),
    selectedGroupIds: vi.fn(() => []), select: vi.fn(async () => ({ groups: offer.groups })) };
  const app = new Hono();
  app.use('*', accessGuard({ lanToken: () => 'synthetic-token', lanHosts: () => [] }));
  registerWechatGroupRoutes(app, catalog as unknown as WechatCatalog);
  const request = (method: string, input?: unknown, address = '127.0.0.1', origin?: string) => {
    const suffix = address === '127.0.0.1' ? '' : `?token=synthetic-token&lan_epoch=${encodeURIComponent(accountEpoch())}`;
    return app.request(`http://localhost/api/connect/wechat/groups${method === 'POST' ? '/refresh' : ''}${suffix}`,
      { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) },
      { incoming: { socket: { remoteAddress: address } } });
  };
  return { app, offer, catalog, refresh, request };
}
describe('local opt-in group catalog route contract (synthetic)', () => {
  const input = { expected_account_epoch: 'synthetic-epoch', data_root: 'E:\\synthetic\\xwechat_files',
    approve_key_read: true, approve_contact_read: true };
  it('retrieves only an existing memory catalog without reading WeChat', async () => {
    const f = fixture(); const response = await f.request('GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ catalog: f.offer, collecting: false });
    expect(f.refresh).not.toHaveBeenCalled();
  });
  it('phone access cannot read the private group list or start a reader', async () => {
    const f = fixture();
    expect((await f.request('GET', undefined, '192.168.1.8')).status).toBe(403);
    expect((await f.request('POST', input, '192.168.1.8')).status).toBe(403);
    expect(f.catalog.catalog).not.toHaveBeenCalled(); expect(f.refresh).not.toHaveBeenCalled();
  });
  it('requires both consents and rejects account/PID/path injection and unsafe Origin', async () => {
    const f = fixture();
    for (const body of [{}, { ...input, approve_key_read: false }, { ...input, approve_contact_read: false },
      { ...input, account: 'wxid_other' }, { ...input, pid: 123 }, { ...input, root: 'C:\\private' }]) {
      expect((await f.request('POST', body)).status).toBe(400);
    }
    expect((await f.request('POST', input, '127.0.0.1', 'https://untrusted.example')).status).toBe(403);
    expect(f.refresh).not.toHaveBeenCalled();
    expect((await f.request('POST', input)).status).toBe(200);
    expect(f.refresh).toHaveBeenCalledWith(input.expected_account_epoch, true, true, input.data_root);
  });
  it('provides useful bounded errors and never reflects native paths, account values or exception text', async () => {
    const f = fixture(); f.refresh.mockRejectedValueOnce(new Error('WECHAT_CATALOG_CONTACT_SCOPE_ACCOUNT_AMBIGUOUS'));
    expect(await (await f.request('POST', input)).json()).toEqual({ error: '同一账号存在多个数据目录，需要核对后再读取' });
    f.refresh.mockRejectedValueOnce(new Error('private native account / path'));
    const response = await f.request('POST', input); expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('private');
  });
  it('selects only using catalog and epoch, does not return account fields or start intake, and excludes phones', async () => {
    const f = fixture(); const body = { catalog_id: f.offer.catalog_id, expected_account_epoch: 'synthetic-epoch', group_ids: ['synthetic@chatroom'] };
    const request = (input: unknown, address = '127.0.0.1') => f.app.request(`http://localhost/api/connect/wechat/groups/selection${address === '127.0.0.1' ? '' : `?token=synthetic-token&lan_epoch=${accountEpoch()}`}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, { incoming: { socket: { remoteAddress: address } } });
    expect((await request({ ...body, account: 'wxid_other' })).status).toBe(400);
    expect((await request(body, '192.168.1.8')).status).toBe(403);
    expect(f.catalog.select).not.toHaveBeenCalled();
    expect(await (await request(body)).json()).toEqual({ selected_group_ids: body.group_ids, collecting: false });
    expect(f.catalog.select).toHaveBeenCalledWith(body.catalog_id, body.expected_account_epoch, body.group_ids);
  });
});
