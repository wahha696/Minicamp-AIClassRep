import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { ingestMessages, upsertGroup } from '../ingest/index.js';
import { bindWechatDestination, wechatBatchId, wechatGroupId, type WechatDelivery } from '../ingest/wechat.js';
import { registerBusinessRoutes } from '../routes/business.js';
import type { EventDetailDTO, EventDTO } from '../types.js';
import { extractEvents, type ExtractInput, type ExtractedEvent } from './extract.js';
import { runPipelineNow, runPipelineGroupNow, resetLlmRetry } from './scheduler.js';
import { getGroupFailure } from './failures.js';

vi.mock('./extract.js', async original => ({ ...await original<typeof import('./extract.js')>(), extractEvents: vi.fn() }));
vi.mock('./jev.js', async original => ({ ...await original<typeof import('./jev.js')>(),
  scoreWithJev: vi.fn(async () => null), jevAvailable: vi.fn(() => false) }));

// Actual ingestion, scheduler, reconciliation and HTTP business routes; only AI
// is replaced. No source client, WeChat reads or credentials are involved.
const at = Date.parse('2026-10-15T18:00:00+08:00');
const body = '人工通知：周四18点前提交实验报告，到A301。';
const account = 'synthetic-account', chatroom = 'synthetic@chatroom', qq = 'synthetic-qq';
const wx = wechatGroupId(account, chatroom);
let app: Hono;
let receive: ReturnType<typeof bindWechatDestination>;
let delivery: WechatDelivery;
const extract = vi.mocked(extractEvents);
const event = (input: ExtractInput, deadline = at): ExtractedEvent => ({
  action: 'create', update_of: null, type: 'assignment', title: '实验报告', description: '提交实验报告',
  start_at: null, end_at: null, deadline_at: deadline, location: 'A301', action_required: '提交报告',
  confidence: 0.9, level: 3, source_message_ids: input.candidates.map(m => m.message_id),
});
const events = async () => (await app.request('/api/events')).json() as Promise<EventDTO[]>;
const detail = async (id: number) => (await app.request(`/api/events/${id}`)).json() as Promise<EventDetailDTO>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: at - 86400_000 });
  openDb(':memory:'); resetLlmRetry();
  app = new Hono(); registerBusinessRoutes(app);
  for (const [id, name, source] of [[qq, '人工QQ群', 'onebot'], [wx, '人工微信群', 'wechat']] as const) {
    upsertGroup(id, name, source); db.prepare('UPDATE groups SET enabled=1 WHERE group_id=?').run(id);
  }
  ingestMessages([{ group_id: qq, group_name: '人工QQ群', message_id: 'qq-message',
    sender_name: '人工成员', text: body, sent_at: Date.now() }], 'onebot');
  receive = bindWechatDestination('synthetic-space', account, [chatroom]);
  delivery = { version: 1, destination: 'synthetic-space', wechat_account: account, batch_id: '',
    messages: [{ group_id: chatroom, group_name: '人工微信群', event_id: 'a'.repeat(64),
      sender_name: '人工成员', text: body, sent_at: Date.now() }] };
  delivery.batch_id = wechatBatchId(delivery);
  expect(receive(delivery).inserted).toBe(1);
  extract.mockReset().mockImplementation(async input => [event(input)]);
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('two concurrent source batches produce one shared item with both sources, and replay preserves completion', async () => {
  await runPipelineNow();
  const rows = await events(); expect(rows).toHaveLength(1);
  const item = await detail(rows[0]!.id);
  expect(item.sources.map(s => s.platform).sort()).toEqual(['qq', 'wechat']);
  expect(db.prepare('SELECT COUNT(*) n FROM messages WHERE processed=1').get()!.n).toBe(2);
  const response = await app.request(`/api/events/${item.id}`, { method: 'PATCH',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) });
  expect(response.status).toBe(200);
  expect(receive(delivery)).toMatchObject({ replayed: true, inserted: 0 });
  await runPipelineNow();
  expect(extract).toHaveBeenCalledTimes(2);
  expect(await events()).toHaveLength(1); expect((await detail(item.id)).status).toBe('done');
});

it('conflicting deadlines remain separate through the full flow', async () => {
  extract.mockImplementation(async input => [event(input, input.groupId === wx ? at + 3600_000 : at)]);
  await runPipelineNow();
  const rows = await events(); expect(rows).toHaveLength(2);
  expect(rows.map(row => row.deadline_at).sort()).toEqual([at, at + 3600_000]);
});

it('WeChat AI failure keeps its messages while QQ completes; explicit retry merges into the same item', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  extract.mockImplementation(async input => { if (input.groupId === wx) throw new Error('synthetic AI failure'); return [event(input)]; });
  await runPipelineNow();
  expect(await events()).toHaveLength(1);
  expect(getGroupFailure(wx)?.failed_attempts).toBe(1);
  expect(db.prepare('SELECT processed FROM messages WHERE group_id=?').get(wx)!.processed).toBe(0);
  expect(db.prepare('SELECT processed FROM messages WHERE group_id=?').get(qq)!.processed).toBe(1);
  extract.mockImplementation(async input => [event(input)]);
  await runPipelineGroupNow(wx);
  expect(getGroupFailure(wx)).toBeNull();
  const rows = await events(); expect(rows).toHaveLength(1);
  expect((await detail(rows[0]!.id)).sources).toHaveLength(2);
});
