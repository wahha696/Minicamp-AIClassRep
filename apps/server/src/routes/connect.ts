// /api/connect/* 与 /api/sync。主人是 A。
// B0 按 00-总约定 §7 注册这 4 个接口，先返回假数据。
import type { Hono } from 'hono';
import { getConnectStatus } from '../napcat/state.js';

export function registerConnectRoutes(app: Hono): void {
  // GET /api/connect/status → ConnectStatusDTO
  app.get('/api/connect/status', (c) => c.json(getConnectStatus()));

  // GET /api/connect/qrcode → PNG，不存在则 404
  app.get('/api/connect/qrcode', (c) => c.json({ error: '还没有二维码' }, 404));

  // POST /api/connect/restart → { ok: true }
  app.post('/api/connect/restart', (c) => c.json({ ok: true }));

  // POST /api/sync → { groups, messages }；未连接时 409
  app.post('/api/sync', (c) => c.json({ error: 'QQ 未连接' }, 409));
}
