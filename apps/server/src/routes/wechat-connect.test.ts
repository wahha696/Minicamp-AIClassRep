import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { accessGuard } from '../lan-guard.js';
import { registerWechatConnectionRoutes } from './wechat-connect.js';
import type { WechatConnection } from '../ingest/wechat-connection.js';
import { accountEpoch } from '../accounts.js';

function fixture() {
  const source = randomUUID();
  const connect = vi.fn(async () => {}); const disconnect = vi.fn(async () => {});
  const connection = { status: () => ({ state: 'identified', connection_id: source, error: null, collecting: false }), connect, disconnect };
  const app = new Hono();
  app.use('*', accessGuard({ lanToken: () => 'synthetic-token', lanHosts: () => [] }));
  registerWechatConnectionRoutes(app, connection as unknown as WechatConnection);
  function request(action: string, input: unknown, address = '127.0.0.1', origin?: string) {
    const token = address === '127.0.0.1' ? '' : `?token=synthetic-token&lan_epoch=${encodeURIComponent(accountEpoch())}`;
    return app.request(`http://localhost/api/connect/wechat/${action}${token}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(input) },
    { incoming: { socket: { remoteAddress: address } } });
  }
  return { app, source, connect, disconnect, request };
}

describe('opt-in WeChat route contract (not mounted in production, synthetic calls)', () => {
  it('rejects missing consent, extra account/process fields and a false approval before any reader starts', async () => {
    const f = fixture();
    for (const input of [{}, { expected_account_epoch: 'e' }, { expected_account_epoch: 'e', approve_identity_read: false },
      { expected_account_epoch: 'e', approve_identity_read: true, account_id: 'wxid_fake' },
      { expected_account_epoch: 'e', approve_identity_read: true, pid: 123 }]) {
      expect((await f.request('connect', input)).status).toBe(400);
    }
    expect(f.connect).not.toHaveBeenCalled();
    expect((await f.request('connect', { expected_account_epoch: 'e', approve_identity_read: true })).status).toBe(200);
    expect(f.connect).toHaveBeenCalledWith('e', true);
  });
  it('remote phone and cross-site pages cannot connect or disconnect', async () => {
    const f = fixture(); const input = { expected_account_epoch: 'e', approve_identity_read: true };
    expect((await f.request('connect', input, '192.168.1.3')).status).toBe(403);
    expect((await f.request('connect', input, '127.0.0.1', 'https://untrusted.example')).status).toBe(403);
    expect((await f.request('disconnect', { expected_account_epoch: 'e', connection_id: f.source }, '192.168.1.3')).status).toBe(403);
    expect(f.connect).not.toHaveBeenCalled(); expect(f.disconnect).not.toHaveBeenCalled();
  });
  it('status reads never connect and redact the control ID on the phone', async () => {
    const f = fixture();
    const local = await f.app.request('http://localhost/api/connect/wechat/status', {}, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect(await local.json()).toMatchObject({ connection_id: f.source, collecting: false });
    const phone = await f.app.request(`http://localhost/api/connect/wechat/status?token=synthetic-token&lan_epoch=${encodeURIComponent(accountEpoch())}`, {},
      { incoming: { socket: { remoteAddress: '192.168.1.3' } } });
    expect((await phone.json() as { connection_id: string | null }).connection_id).toBeNull();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('uses only epoch + owned connection ID to disconnect, never account deletion or desktop logout', async () => {
    const f = fixture();
    expect((await f.request('disconnect', { expected_account_epoch: 'e', connection_id: f.source, erase: true })).status).toBe(400);
    expect((await f.request('disconnect', { expected_account_epoch: 'e', connection_id: f.source })).status).toBe(200);
    expect(f.disconnect).toHaveBeenCalledWith('e', f.source);
  });
  it('provides useful safe errors without reflecting private paths or account values', async () => {
    const f = fixture(); const input = { expected_account_epoch: 'e', approve_identity_read: true };
    f.connect.mockRejectedValueOnce(new Error('WECHAT_VERSION_UNSUPPORTED'));
    expect(await (await f.request('connect', input)).json()).toEqual({ error: '当前微信版本尚未通过兼容验证' });
    f.connect.mockRejectedValueOnce(new Error('private native path / account'));
    const response = await f.request('connect', input);
    expect(response.status).toBe(409); expect(JSON.stringify(await response.json())).not.toContain('private');
  });
});
