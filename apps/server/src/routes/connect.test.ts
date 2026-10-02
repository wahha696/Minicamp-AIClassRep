// A6 验收：routes/connect.ts 四个接口（00-总约定 §7 格式）。外部依赖全部 mock。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logoutMock, restartMock, isOnlineMock, syncHistoryMock, getConnectStatusMock, desktopStart, desktopReturn, desktopActive } = vi.hoisted(() => ({
  logoutMock: vi.fn(),
  restartMock: vi.fn(),
  isOnlineMock: vi.fn(),
  syncHistoryMock: vi.fn(),
  getConnectStatusMock: vi.fn(),
  desktopStart: vi.fn(), desktopReturn: vi.fn(), desktopActive: vi.fn(() => false),
}));

vi.mock('../napcat/index.js', () => ({ restartNapcat: restartMock, logoutNapcat: logoutMock }));
vi.mock('../napcat/onebot.js', () => ({ isOnline: isOnlineMock }));
vi.mock('../ingest/history.js', () => ({ syncHistory: syncHistoryMock }));
vi.mock('../napcat/state.js', () => ({ getConnectStatus: getConnectStatusMock }));
vi.mock('../napcat/desktop-qq.js', () => ({ desktopSession: { isActive: desktopActive, start: desktopStart, returnToClassRep: desktopReturn } }));
// 二维码路径指向仓库外的固定临时文件（仓库外是因为测试目录可能被并发清理），beforeEach 里确保目录存在
vi.mock('../napcat/paths.js', async () => {
  const { join } = await import('node:path');
  return { QRCODE_PATH: join(tmpdir(), 'classrep-connect-test', 'qrcode.png') };
});

import { registerConnectRoutes } from './connect.js';
import { QRCODE_PATH } from '../napcat/paths.js';
import { desktopModeGuard } from '../napcat/desktop-guard.js';
import { accessGuard } from '../lan-guard.js';
import { DesktopSessionError } from '../napcat/desktop-session.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

function app(): Hono {
  const a = new Hono();
  registerConnectRoutes(a);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  desktopActive.mockReturnValue(false);
  mkdirSync(dirname(QRCODE_PATH), { recursive: true });
  writeFileSync(QRCODE_PATH, PNG_BYTES);
});

describe('desktop QQ controls', () => {
  const body = { expected_account_epoch: 'v2:test:1:0', expected_uin: '10001' };
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const json = (data: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  it('validates account snapshot and return session before invoking the controller', async () => {
    desktopStart.mockReturnValue({ supported: true, state: 'opening' });
    desktopReturn.mockReturnValue({ supported: true, state: 'resuming' });
    expect((await app().request('/api/connect/desktop-qq', json(body))).status).toBe(200);
    expect(desktopStart).toHaveBeenCalledExactlyOnceWith(body.expected_account_epoch, '10001');
    expect((await app().request('/api/connect/desktop-qq/return', json(body))).status).toBe(400);
    expect(desktopReturn).not.toHaveBeenCalled();
    expect((await app().request('/api/connect/desktop-qq/return', json({ ...body, session_id: sessionId }))).status).toBe(200);
    expect(desktopReturn).toHaveBeenCalledExactlyOnceWith(body.expected_account_epoch, '10001', sessionId);
    desktopStart.mockImplementationOnce(() => { throw new DesktopSessionError('切换状态已过期'); });
    expect((await app().request('/api/connect/desktop-qq', json(body))).status).toBe(409);
  });
  it('blocks other-tab writes while allowing the return control, reads and presence', async () => {
    const a = new Hono();
    a.use('*', desktopModeGuard());
    registerConnectRoutes(a);
    a.post('/api/events', c => c.json({ ok: true }));
    a.post('/api/presence/bye', c => c.json({ ok: true }));
    desktopActive.mockReturnValue(true);
    expect((await a.request('/api/events', json({}))).status).toBe(409);
    expect((await a.request('/api/connect/logout', json(body))).status).toBe(409);
    expect((await a.request('/api/presence/bye', json({}))).status).toBe(200);
    desktopReturn.mockReturnValue({ supported: true, state: 'resuming' });
    expect((await a.request('/api/connect/desktop-qq/return', json({ ...body, session_id: sessionId }))).status).toBe(200);
  });
  it('rejects LAN, cross-site and form-based attempts before touching QQ', async () => {
    const a = new Hono();
    a.use('*', accessGuard({ lanToken: () => null, lanHosts: () => [] }));
    registerConnectRoutes(a);
    const local = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
    const lan = { incoming: { socket: { remoteAddress: '192.168.1.2' } } } as never;
    expect((await a.request('/api/connect/desktop-qq', json(body), lan)).status).toBe(403);
    expect((await a.request('/api/connect/desktop-qq', { ...json(body), headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } }, local)).status).toBe(403);
    expect((await a.request('/api/connect/desktop-qq', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1' }, local)).status).toBe(415);
    expect(desktopStart).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  try { rmSync(dirname(QRCODE_PATH), { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { /* 忽略 */ }
});

describe('GET /api/connect/status', () => {
  it('返回 ConnectStatusDTO', async () => {
    getConnectStatusMock.mockReturnValue({ state: 'online', uin: '10001', since: 1, first_run: false });
    const res = await app().request('/api/connect/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'online', uin: '10001', since: 1, first_run: false });
  });
});

describe('GET /api/connect/qrcode', () => {
  it('二维码存在 → 200 PNG + Cache-Control: no-store', async () => {
    const res = await app().request('/api/connect/qrcode');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('二维码不存在 → 404 + 中文 error', async () => {
    rmSync(QRCODE_PATH, { force: true, maxRetries: 8, retryDelay: 200 });
    const res = await app().request('/api/connect/qrcode');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });
});

describe('POST /api/connect/restart', () => {
  it('成功 → { ok: true }，restart 恰好一次', async () => {
    restartMock.mockResolvedValue(true);
    const res = await app().request('/api/connect/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_account_epoch: 'v2:test:1:0', expected_uin: '10001' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(restartMock).toHaveBeenCalledWith({
      expectedAccountEpoch: 'v2:test:1:0', expectedUin: '10001', killUserQQ: false,
    });
  });

  it('缺账号快照 → 400；快照过期 → 409，均不误报成功', async () => {
    expect((await app().request('/api/connect/restart', { method: 'POST' })).status).toBe(400);
    restartMock.mockResolvedValue(false);
    const stale = await app().request('/api/connect/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_account_epoch: 'v2:old:1:0', expected_uin: null }),
    });
    expect(stale.status).toBe(409);
  });

  it('restart 抛错 → 500 + 中文 error', async () => {
    restartMock.mockRejectedValue(new Error('boom'));
    const res = await app().request('/api/connect/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_account_epoch: 'v2:test:1:0', expected_uin: null }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('重启采集端失败');
  });
});

describe('POST /api/connect/logout', () => {
  it('成功 → { ok: true }，只调 logout 不调 restart', async () => {
    logoutMock.mockResolvedValue(true);
    const res = await app().request('/api/connect/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_account_epoch: 'v2:test:1:0', expected_uin: '10001', erase: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(logoutMock).toHaveBeenCalledWith({
      erase: true, expectedAccountEpoch: 'v2:test:1:0', expectedUin: '10001',
    });
    expect(restartMock).not.toHaveBeenCalled();
  });

  it('缺账号快照 → 400；旧页面快照 → 409', async () => {
    expect((await app().request('/api/connect/logout', { method: 'POST' })).status).toBe(400);
    logoutMock.mockResolvedValue(false);
    const stale = await app().request('/api/connect/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_account_epoch: 'v2:old:1:0', expected_uin: '10001' }),
    });
    expect(stale.status).toBe(409);
  });

  it('logout 抛错 → 500 + 中文 error', async () => {
    logoutMock.mockRejectedValue(new Error('boom'));
    const res = await app().request('/api/connect/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_account_epoch: 'v2:test:1:0', expected_uin: '10001' }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('退出登录失败');
  });
});

describe('POST /api/sync', () => {
  it('未连接 → 409 { error: "QQ 未连接" }，且不调 syncHistory', async () => {
    isOnlineMock.mockReturnValue(false);
    const res = await app().request('/api/sync', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'QQ 未连接' });
    expect(syncHistoryMock).not.toHaveBeenCalled();
  });

  it('online → 返回 { groups, messages }', async () => {
    isOnlineMock.mockReturnValue(true);
    syncHistoryMock.mockResolvedValue({ groups: 3, messages: 57 });
    const res = await app().request('/api/sync', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ groups: 3, messages: 57 });
    expect(syncHistoryMock).toHaveBeenCalledOnce();
    expect(syncHistoryMock).toHaveBeenCalledWith(7); // 缺省 7 天
  });

  it.each([1, 7, 30] as const)('days=%s 透传给 syncHistory', async (days) => {
    isOnlineMock.mockReturnValue(true);
    syncHistoryMock.mockResolvedValue({ groups: 0, messages: 0 });
    const res = await app().request('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    expect(res.status).toBe(200);
    expect(syncHistoryMock).toHaveBeenCalledWith(days);
  });

  it.each([0, 3, 365, '7', null])('days=%s 非法 → 400，不调 syncHistory', async (days) => {
    isOnlineMock.mockReturnValue(true);
    syncHistoryMock.mockResolvedValue({ groups: 0, messages: 0 });
    const res = await app().request('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    expect(res.status).toBe(400);
    expect(syncHistoryMock).not.toHaveBeenCalled();
  });

  it('syncHistory 抛错 → 500 + 中文 error', async () => {
    isOnlineMock.mockReturnValue(true);
    syncHistoryMock.mockRejectedValue(new Error('boom'));
    const res = await app().request('/api/sync', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('同步失败');
  });
});
