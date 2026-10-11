import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerHistoryJobRoutes } from './history-jobs.js';
import type { HistoryJobs } from '../ingest/history-jobs.js';
import type { WechatIntake } from '../ingest/wechat-intake.js';

function fixture(remote = '127.0.0.1') {
  const job = { id: 'synthetic-job', platform: 'qq', status: 'running' };
  const jobs = { list: vi.fn(() => [job]), get: vi.fn(() => job), create: vi.fn(() => job),
    cancel: vi.fn(() => ({ ...job, status: 'cancelling' })), retry: vi.fn(() => job) };
  const app = new Hono();
  app.use('*', async (c, next) => { c.env = { incoming: { socket: { remoteAddress: remote } } }; await next(); });
  registerHistoryJobRoutes(app, {} as WechatIntake, jobs as unknown as HistoryJobs);
  return { app, jobs };
}
const body = (value: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
describe('history task endpoints', () => {
  it('creates asynchronously and exposes state after a browser reconnect', async () => {
    const f = fixture();
    const response = await f.app.request('/api/history-jobs', body({ platform: 'qq', days: 7, expected_account_epoch: 'synthetic' }));
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ job: { id: 'synthetic-job' } });
    expect(await (await f.app.request('/api/history-jobs')).json()).toMatchObject({ jobs: [{ id: 'synthetic-job' }] });
    expect(await (await f.app.request('/api/history-jobs/synthetic-job')).json()).toMatchObject({ job: { status: 'running' } });
  });
  it('rejects LAN reads and writes on both collection and item endpoints', async () => {
    const f = fixture('192.168.1.2');
    for (const path of ['/api/history-jobs', '/api/history-jobs/synthetic-job']) expect((await f.app.request(path)).status).toBe(403);
    expect((await f.app.request('/api/history-jobs', body({ platform: 'qq', days: 7, expected_account_epoch: 'synthetic' }))).status).toBe(403);
    expect(f.jobs.create).not.toHaveBeenCalled();
  });
  it('requires an epoch and validates operation inputs before starting any work', async () => {
    const f = fixture();
    expect((await f.app.request('/api/history-jobs', body({ platform: 'qq', days: 7 }))).status).toBe(400);
    expect((await f.app.request('/api/history-jobs/id/cancel', body({}))).status).toBe(400);
    expect((await f.app.request('/api/history-jobs/id/retry', body({ expected_account_epoch: 'e', shell: 'no' }))).status).toBe(400);
    expect(f.jobs.create).not.toHaveBeenCalled(); expect(f.jobs.retry).not.toHaveBeenCalled();
  });
});
