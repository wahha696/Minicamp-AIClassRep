import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultReminderRules } from '../../../../shared/reminders.js';
import { db, openDb } from '../db/index.js';
import { accessGuard } from '../lan-guard.js';
import { registerReminderRoutes } from '../routes/reminders.js';
import { getReminderSettings, saveReminderRules } from './settings.js';
const local = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
const remote = { incoming: { socket: { remoteAddress: '192.168.1.20' } } } as never;
const directories: string[] = [];
beforeEach(() => openDb(':memory:'));
afterEach(() => { db.close(); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function fixture() {
  const app = new Hono();
  app.use('*', accessGuard({ lanToken: () => 'synthetic', accountEpoch: () => 'epoch', lanHosts: () => [] }));
  registerReminderRoutes(app);
  const put = (body: unknown) => app.request('/api/settings/reminders', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, local);
  return { app, put };
}
it('默认关闭，24/2小时、上限10条、无安静时段；读取不写入', () => {
  expect(getReminderSettings()).toEqual({ ...defaultReminderRules(), delivery_ready: false });
  expect(db.prepare("SELECT COUNT(*) n FROM kv WHERE key='reminder_rules_v1'").get()!.n).toBe(0);
});
it('偏好持久保存且不同空间隔离，重开不自动开启', () => {
  const directory = mkdtempSync(join(tmpdir(), 'classrep-reminder-')); directories.push(directory);
  const file = join(directory, 'space-a.db'); openDb(file);
  saveReminderRules({ ...defaultReminderRules(), before_minutes: [30, 5], daily_limit: 7 });
  openDb(join(directory, 'space-b.db')); expect(getReminderSettings().daily_limit).toBe(10);
  openDb(file); expect(getReminderSettings()).toMatchObject({ enabled: false, before_minutes: [30, 5], daily_limit: 7 });
});
it('损坏或未来格式不覆盖，错误不伪装成默认成功', async () => {
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run('reminder_rules_v1', '{damaged');
  const f = fixture();
  expect((await f.app.request('/api/settings/reminders', {}, local)).status).toBe(503);
  expect((await f.put(defaultReminderRules())).status).toBe(503);
  expect(db.prepare("SELECT value FROM kv WHERE key='reminder_rules_v1'").get()!.value).toBe('{damaged');
});
it('无渠道时不能开启，非法或额外字段不会落库；合法时间和上限可保存', async () => {
  const f = fixture();
  expect((await f.put({ ...defaultReminderRules(), enabled: true })).status).toBe(409);
  for (const body of [
    { ...defaultReminderRules(), before_minutes: [120, 120] },
    { ...defaultReminderRules(), daily_limit: 0 },
    { ...defaultReminderRules(), daily_limit: 2.5 },
    { ...defaultReminderRules(), token: 'not-a-credential' },
  ]) expect((await f.put(body)).status).toBe(400);
  expect(getReminderSettings()).toMatchObject({ enabled: false, daily_limit: 10 });
  expect((await f.put({ ...defaultReminderRules(), daily_limit: 5 })).status).toBe(200);
  expect(getReminderSettings().daily_limit).toBe(5);
});
it('远程只读客户端与跨站来源不能读取或修改提醒设置', async () => {
  const f = fixture();
  expect((await f.app.request('/api/settings/reminders?token=synthetic&lan_epoch=epoch', {}, remote)).status).toBe(403);
  expect((await f.app.request('/api/settings/reminders', {
    method: 'PUT', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify(defaultReminderRules()),
  }, local)).status).toBe(403);
});
