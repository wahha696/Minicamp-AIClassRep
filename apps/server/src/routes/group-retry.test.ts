import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { ingestMessages } from '../ingest/index.js';
import { extractEvents } from '../pipeline/extract.js';
import { getGroupFailure, llmConfigFingerprint, recordGroupFailure } from '../pipeline/failures.js';
import { setDesktopPipelinePaused } from '../pipeline/activity.js';
import { registerBusinessRoutes } from './business.js';

vi.mock('../pipeline/extract.js', async (original) => ({
  ...await original<typeof import('../pipeline/extract.js')>(), extractEvents: vi.fn(),
}));
vi.mock('../pipeline/jev.js', async (original) => ({
  ...await original<typeof import('../pipeline/jev.js')>(), scoreWithJev: vi.fn(async () => null),
}));

let app: Hono;
beforeEach(() => {
  openDb(':memory:');
  setDesktopPipelinePaused(false);
  vi.mocked(extractEvents).mockReset().mockResolvedValue([]);
  app = new Hono();
  registerBusinessRoutes(app);
  ingestMessages([{ message_id: 'm1', group_id: 'g1', group_name: '测试群',
    sender_name: '测试', text: '明天提交实验报告', sent_at: Date.now() }], 'demo');
});
afterEach(() => { setDesktopPipelinePaused(false); vi.restoreAllMocks(); });

describe('逐群重试接口', () => {
  it('返回失败分类和暂停状态，接口不暴露配置指纹或密钥', async () => {
    for (let i = 0; i < 3; i++) recordGroupFailure('g1', 'invalid_output', llmConfigFingerprint());
    const response = await app.request('/api/groups');
    const [group] = await response.json() as Array<Record<string, unknown>>;
    expect(group?.processing_failure).toMatchObject({ reason: 'invalid_output', paused: true, failed_attempts: 3, pending_count: 1 });
    expect(JSON.stringify(group)).not.toContain('fingerprint');
    expect(JSON.stringify(group)).not.toContain('apiKey');
  });

  it('请求立即接受，等待 AI 不阻塞接口；处理结束才清除失败状态', async () => {
    recordGroupFailure('g1', 'network', llmConfigFingerprint());
    let release!: () => void;
    vi.mocked(extractEvents).mockImplementation(() => new Promise((resolve) => { release = () => resolve([]); }));
    const response = await app.request('/api/groups/g1/retry', { method: 'POST' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(extractEvents).toHaveBeenCalledOnce());
    expect(getGroupFailure('g1')?.pending_count).toBe(1);
    release();
    await vi.waitFor(() => expect(getGroupFailure('g1')).toBeNull());
    expect((db.prepare('SELECT processed FROM messages').get() as { processed: number }).processed).toBe(1);
  });

  it('不存在、关闭监听或桌面 QQ 暂停时拒绝请求，不发 AI 请求', async () => {
    expect((await app.request('/api/groups/missing/retry', { method: 'POST' })).status).toBe(404);
    db.prepare("UPDATE groups SET enabled = 0 WHERE group_id = 'g1'").run();
    expect((await app.request('/api/groups/g1/retry', { method: 'POST' })).status).toBe(409);
    db.prepare("UPDATE groups SET enabled = 1 WHERE group_id = 'g1'").run();
    setDesktopPipelinePaused(true);
    expect((await app.request('/api/groups/g1/retry', { method: 'POST' })).status).toBe(409);
    expect(extractEvents).not.toHaveBeenCalled();
  });

  it('用户主动删除该群数据时同时清除失败记录', async () => {
    recordGroupFailure('g1', 'network', llmConfigFingerprint());
    const response = await app.request('/api/groups/g1/data', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(db.prepare('SELECT * FROM pipeline_failures').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM messages').all()).toHaveLength(0);
  });

  it('桌面QQ暂停时仍接受微信逐群重试，QQ积压保持未处理', async () => {
    db.prepare('INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES(?,?,1,?,1)')
      .run('synthetic-wechat', '人工微信群', 'wechat');
    ingestMessages([{ message_id: 'wechat-m1', group_id: 'synthetic-wechat', group_name: '人工微信群',
      sender_name: '人工', text: '明天提交实验报告', sent_at: Date.now() }], 'wechat');
    setDesktopPipelinePaused(true);
    expect((await app.request('/api/groups/synthetic-wechat/retry', { method: 'POST' })).status).toBe(202);
    await vi.waitFor(() => expect(db.prepare("SELECT processed FROM messages WHERE group_id='synthetic-wechat'").get()!.processed).toBe(1));
    expect(db.prepare("SELECT processed FROM messages WHERE group_id='g1'").get()!.processed).toBe(0);
  });
});
