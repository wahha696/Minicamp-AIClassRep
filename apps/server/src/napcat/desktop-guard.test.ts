import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
const state = vi.hoisted(() => ({ active: true }));
vi.mock('./desktop-qq.js', () => ({ desktopSession: { isActive: () => state.active } }));
import { desktopModeGuard } from './desktop-guard.js';
let app: Hono;
beforeEach(() => {
  state.active = true; openDb(':memory:');
  db.prepare('INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES(?,?,1,?,1)').run('wechat:synthetic', '人工微信', 'wechat');
  db.prepare('INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES(?,?,1,?,1)').run('wechat:pretend', '人工QQ', 'onebot');
  app = new Hono(); app.use('*', desktopModeGuard()); app.all('*', c => c.json({ reached: true }));
});
afterEach(() => db.close());
it('permits independent WeChat message operations during QQ handoff', async () => {
  for (const action of ['start', 'stop', 'history', 'issues', 'retry']) {
    expect((await app.request(`/api/connect/wechat/messages/${action}`, { method: 'POST' })).status).toBe(200);
  }
  expect((await app.request('/api/groups/wechat%3Asynthetic/retry', { method: 'POST' })).status).toBe(200);
});
it('keeps account changes and other-platform writes blocked, without trusting an ID prefix', async () => {
  for (const path of ['/api/connect/logout', '/api/connect/restart', '/api/workspaces/choose',
    '/api/connect/wechat/connect', '/api/connect/wechat/disconnect', '/api/groups/wechat%3Apretend/retry',
    '/api/groups/missing/retry', '/api/connect/wechat/messages/not-an-action']) {
    expect((await app.request(path, { method: 'POST' })).status).toBe(409);
  }
  expect((await app.request('/api/groups/wechat%3Asynthetic', { method: 'DELETE' })).status).toBe(409);
});
it('preserves read and handoff controls, and removes restrictions when QQ returns', async () => {
  expect((await app.request('/api/groups')).status).toBe(200);
  expect((await app.request('/api/connect/desktop-qq/return', { method: 'POST' })).status).toBe(200);
  state.active = false;
  expect((await app.request('/api/workspaces/choose', { method: 'POST' })).status).toBe(200);
});
