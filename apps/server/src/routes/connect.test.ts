// A6 验收：routes/connect.ts 四个接口（00-总约定 §7 格式）。外部依赖全部 mock。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { restartMock, isOnlineMock, syncHistoryMock, getConnectStatusMock } = vi.hoisted(() => ({
  restartMock: vi.fn(),
  isOnlineMock: vi.fn(),
  syncHistoryMock: vi.fn(),
  getConnectStatusMock: vi.fn(),
}));

vi.mock('../napcat/manager.js', () => ({ restart: restartMock }));
vi.mock('../napcat/onebot.js', () => ({ isOnline: isOnlineMock }));
vi.mock('../ingest/history.js', () => ({ syncHistory: syncHistoryMock }));
vi.mock('../napcat/state.js', () => ({ getConnectStatus: getConnectStatusMock }));
// 二维码路径指向仓库外的固定临时文件（仓库外是因为测试目录可能被并发清理），beforeEach 里确保目录存在
vi.mock('../napcat/paths.js', async () => {
  const { join } = await import('node:path');
  return { QRCODE_PATH: join(tmpdir(), 'classrep-connect-test', 'qrcode.png') };
});

import { registerConnectRoutes } from './connect.js';
import { QRCODE_PATH } from '../napcat/paths.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

function app(): Hono {
  const a = new Hono();
  registerConnectRoutes(a);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(dirname(QRCODE_PATH), { recursive: true });
  writeFileSync(QRCODE_PATH, PNG_BYTES);
});

afterEach(() => {
  try { rmSync(dirname(QRCODE_PATH), { recursive: true, force: true }); } catch { /* 忽略 */ }
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
    rmSync(QRCODE_PATH, { force: true });
    const res = await app().request('/api/connect/qrcode');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
  });
});

describe('POST /api/connect/restart', () => {
  it('成功 → { ok: true }，restart 恰好一次', async () => {
    restartMock.mockResolvedValue(undefined);
    const res = await app().request('/api/connect/restart', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(restartMock).toHaveBeenCalledOnce();
  });

  it('restart 抛错 → 500 + 中文 error', async () => {
    restartMock.mockRejectedValue(new Error('boom'));
    const res = await app().request('/api/connect/restart', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('重启采集端失败');
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
