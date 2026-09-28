import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountDataState,
  accountDbPath,
  accountEpoch,
  currentAccount,
  setAccountsDirForTest,
  switchAccount,
  tryAcquireAccountMutationLease,
} from './accounts.js';
import { accountMutationGuard } from './account-request-guard.js';
import { db } from './db/index.js';

const root = mkdtempSync(join(tmpdir(), 'classrep-account-guard-'));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  await switchAccount('10001');
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true });
});

describe('账号数据请求闸门', () => {
  it('就绪状态下缺少 epoch 的写请求也返回 409，不能默认写入当前库', async () => {
    await switchAccount('10001');
    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.post('/api/events/test', () => {
      db.prepare("INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('missing-epoch', 'X', 1, 'import', 1)").run();
      return new Response(null, { status: 204 });
    });

    const response = await app.request('/api/events/test', { method: 'POST' });
    expect(response.status).toBe(409);
    expect(db.prepare("SELECT 1 FROM groups WHERE group_id = 'missing-epoch'").get()).toBeUndefined();
  });

  it('当前 epoch 的读写请求放行，读请求也可以用 ICS 查询参数', async () => {
    await switchAccount('10001');
    const epoch = accountEpoch();
    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.get('/api/events/test', (c) => c.json({ ok: true }));
    app.post('/api/events/test', (c) => c.json({ ok: true }));
    app.get('/api/export.ics', (c) => c.text('calendar'));

    expect((await app.request('/api/events/test', { headers: { 'X-ClassRep-Account-Epoch': epoch } })).status).toBe(200);
    expect((await app.request('/api/events/test', {
      method: 'POST',
      headers: { 'X-ClassRep-Account-Epoch': epoch },
    })).status).toBe(200);
    expect((await app.request(`/api/export.ics?account_epoch=${encodeURIComponent(epoch)}`)).status).toBe(200);
    expect((await app.request(`/api/events/test?account_epoch=${encodeURIComponent(epoch)}`)).status).toBe(409);
  });

  it('健康检查与登录恢复接口不要 epoch，挂库出错后仍有恢复入口', async () => {
    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.get('/health', (c) => c.json({ ok: true }));
    app.get('/api/connect/status', (c) => c.json({ ok: true }));
    app.post('/api/connect/restart', (c) => c.json({ ok: true }));
    app.post('/api/connect/logout', (c) => c.json({ ok: true }));

    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/api/connect/status')).status).toBe(200);
    expect((await app.request('/api/connect/restart', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/connect/logout', { method: 'POST' })).status).toBe(200);
  });

  it('旧页面携带过期 epoch 时返回 409', async () => {
    const epochA = accountEpoch();
    await switchAccount('10002');

    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.post('/api/events/test', (c) => c.json({ ok: true }));
    const response = await app.request('/api/events/test', {
      method: 'POST',
      headers: { 'X-ClassRep-Account-Epoch': epochA },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: '账号已切换或正在切换，请刷新后重试' });
  });

  it('旧页面携带过期 epoch 的 GET 也不能读取新账号', async () => {
    await switchAccount('10001');
    const epochA = accountEpoch();
    await switchAccount('10002');
    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.get('/api/events/test', (c) => c.json({ leaked: true }));

    const response = await app.request('/api/events/test', {
      headers: { 'X-ClassRep-Account-Epoch': epochA },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: '账号已切换或正在切换，请刷新后重试' });
  });

  it('切号等待正在执行的异步写完成，迟到写只落回原账号库', async () => {
    await switchAccount('10001');
    const epochA = accountEpoch();
    const bodyReached = deferred();
    const finishBody = deferred();
    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.post('/api/events/test', async (c) => {
      bodyReached.resolve();
      await finishBody.promise;
      db.prepare("INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('late-a', 'A', 1, 'import', 1)").run();
      return c.json({ ok: true });
    });

    const request = app.request('/api/events/test', {
      method: 'POST',
      headers: { 'X-ClassRep-Account-Epoch': epochA },
    });
    await bodyReached.promise;
    const switching = switchAccount('10002');
    await Promise.resolve();
    expect(currentAccount()).toBe('10001');

    finishBody.resolve();
    expect((await request).status).toBe(200);
    await switching;
    expect(currentAccount()).toBe('10002');
    expect(db.prepare("SELECT 1 FROM groups WHERE group_id = 'late-a'").get()).toBeUndefined();

    await switchAccount('10001');
    expect(db.prepare("SELECT 1 AS ok FROM groups WHERE group_id = 'late-a'").get()).toEqual({ ok: 1 });
  });

  it('切号 transition 等待 lease 时，账号数据 GET 不会读取仍挂载的旧账号库', async () => {
    await switchAccount('10001');
    const lease = tryAcquireAccountMutationLease();
    expect(lease).not.toBeNull();
    const switching = switchAccount('10002');
    expect(accountDataState()).toBe('switching');

    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.get('/api/events/test', (c) => c.json({ leaked: true }));
    const response = await app.request('/api/events/test');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: '账号正在切换，请稍后重试' });

    lease!.release();
    await switching;
    expect(currentAccount()).toBe('10002');
  });

  it('目标库损坏后账号数据读写全部 fail closed，修复重连后才恢复', async () => {
    await switchAccount('10001');
    mkdirSync(join(root, 'accounts', '30003'), { recursive: true });
    writeFileSync(accountDbPath('30003'), 'not a sqlite database');
    await expect(switchAccount('30003')).rejects.toThrow();
    expect(accountDataState()).toBe('error');

    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.get('/api/events/test', (c) => c.json({ leaked: true }));
    app.post('/api/events/test', () => {
      db.prepare("INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('should-not-write', 'X', 1, 'import', 1)").run();
      return new Response(null, { status: 204 });
    });
    expect((await app.request('/api/events/test')).status).toBe(503);
    expect((await app.request('/api/events/test', { method: 'POST' })).status).toBe(503);
    expect(db.prepare("SELECT 1 FROM groups WHERE group_id = 'should-not-write'").get()).toBeUndefined();

    rmSync(accountDbPath('30003'), { force: true });
    await switchAccount('30003');
    expect(accountDataState()).toBe('ready');
    expect((await app.request('/api/events/test', {
      headers: { 'X-ClassRep-Account-Epoch': accountEpoch() },
    })).status).toBe(200);
  });
});
