import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { db, openDb } from '../db/index.js';
import { ingestMessages } from '../ingest/index.js';
import { registerBusinessRoutes } from '../routes/business.js';
import type { Message } from '../types.js';
import type { ExtractedEvent } from './extract.js';
import { applyEvents, listActiveEvents } from './reconcile.js';
import { messagePlatform } from './cross-platform.js';

const qq = '123456'; const wechat = 'wechat:synthetic';
const at = Date.parse('2026-10-15T08:00:00Z');
let sequence = 0;
function notify(group: string, changes: Partial<ExtractedEvent> = {}, text = '人工通知：周四提交实验报告，交到 A301。') {
  const message: Message = { group_id: group, group_name: group === qq ? '人工QQ群' : '人工微信群',
    message_id: group.startsWith('wechat:') ? `wechat:synthetic-${++sequence}` : String(++sequence), text,
    sender_name: '人工发信人', sent_at: at - 86400_000 + sequence * 1000 };
  const event: ExtractedEvent = { action: 'create', update_of: null, type: 'assignment', title: '实验报告', description: '人工摘要',
    start_at: null, end_at: null, deadline_at: at, location: 'A301', action_required: '提交报告', confidence: 0.9, level: 3,
    source_message_ids: [message.message_id], ...changes };
  applyEvents(group, [event], [message]); return { message, event };
}
beforeEach(() => {
  openDb(':memory:'); sequence = 0;
  const add = db.prepare('INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES(?,?,1,?,1)');
  add.run(qq, '人工QQ群', 'onebot'); add.run(wechat, '人工微信群', 'wechat');
});
afterEach(() => db.close());
const events = () => db.prepare('SELECT * FROM events ORDER BY id').all();
it('有真实入库来源时不凭数字群号把粘贴导入误认成QQ通知', () => {
  const result = notify(qq);
  db.exec('DELETE FROM event_sources; DELETE FROM events');
  expect(ingestMessages([result.message], 'import').inserted).toBe(1);
  expect(messagePlatform(result.message)).toBe('import');
  applyEvents(qq, [result.event], [result.message]);
  expect(db.prepare('SELECT platform FROM event_sources').get()!.platform).toBe('import');
  notify(wechat); expect(events()).toHaveLength(2);
});
it('正文与关键字段完全相同，统一为一件、保留双平台来源与两群后续更新入口', () => {
  notify(qq); const second = notify(wechat); const id = Number(events()[0]!.id);
  expect(events()).toHaveLength(1);
  expect(db.prepare('SELECT platform,group_name FROM event_sources ORDER BY sent_at').all()).toEqual([
    { platform: 'qq', group_name: '人工QQ群' }, { platform: 'wechat', group_name: '人工微信群' },
  ]);
  expect(listActiveEvents(qq, at).map(e => e.id)).toEqual([id]);
  expect(listActiveEvents(wechat, at).map(e => e.id)).toEqual([id]);
  applyEvents(wechat, [second.event], [second.message]); expect(events()).toHaveLength(1);
  notify(wechat, { action: 'update', update_of: id, deadline_at: at + 86400_000 }, '人工通知：截止改到明天。');
  expect(events()).toHaveLength(1); expect(events()[0]?.deadline_at).toBe(at + 86400_000);
  notify(qq, { action: 'cancel', update_of: id }, '人工通知：取消。');
  expect(events()[0]?.status).toBe('cancelled');
});
it.each([
  [{ deadline_at: at + 1 }, undefined], [{ location: 'B202' }, undefined],
  [{ confidence: 0.4 }, undefined], [{}, '人工通知：另一份报告。'],
] as [Partial<ExtractedEvent>, string | undefined][])('关键字段或正文不同、低置信度都不跨平台合并', (changes, text) => {
  notify(qq); notify(wechat, changes, text); expect(events()).toHaveLength(2);
});
it('多个同样候选不猜，未知旧来源也不猜', () => {
  notify(qq); notify('654321'); notify(wechat); expect(events()).toHaveLength(3);
  db.exec('DELETE FROM events; DELETE FROM event_sources;');
  notify(qq); db.exec("UPDATE event_sources SET platform='unknown',group_id=''");
  notify(wechat); expect(events()).toHaveLength(2);
});
it('重复跨平台通知不会撤销用户已完成状态，重放也不重复建事项', () => {
  notify(qq); db.exec("UPDATE events SET status='done'"); const second = notify(wechat);
  expect(events()).toHaveLength(1); expect(events()[0]?.status).toBe('done');
  applyEvents(wechat, [second.event], [second.message]); expect(events()).toHaveLength(1);
});
it.each([qq, wechat])('清理 %s 只移除本群证据，保留另一群事项、状态与历史去重', async group => {
  const first = notify(qq); const second = notify(wechat); const id = Number(events()[0]!.id);
  db.exec("UPDATE events SET status='done'");
  const app = new Hono(); registerBusinessRoutes(app);
  expect((await app.request(`/api/groups/${encodeURIComponent(group)}/data`, { method: 'DELETE' })).status).toBe(200);
  const remaining = group === qq ? wechat : qq;
  expect(events()).toHaveLength(1); expect(events()[0]).toMatchObject({ id, group_id: remaining, status: 'done' });
  expect(db.prepare('SELECT group_id FROM event_sources').all()).toEqual([{ group_id: remaining }]);
  const deleted = group === qq ? first : second;
  expect(ingestMessages([deleted.message], group === qq ? 'history' : 'wechat').inserted).toBe(0);
  expect((await app.request(`/api/groups/${encodeURIComponent(remaining)}/data`, { method: 'DELETE' })).status).toBe(200);
  expect(events()).toHaveLength(0);
});

it('清理同名群不删除另一群或仍有来源事项的个人等级反馈', async () => {
  notify(qq); notify(wechat); const sharedId = Number(events()[0]!.id);
  db.prepare('UPDATE groups SET name=?').run('人工同名群');
  const other = '654321';
  db.prepare('INSERT INTO groups(group_id,name,adapter,created_at) VALUES(?,?,?,1)').run(other, '人工同名群', 'onebot');
  notify(other, { title: '另一份实验' }, '人工另一份实验通知');
  const otherId = Number(events()[1]!.id);
  const addFeedback = db.prepare('INSERT INTO level_feedback(event_id,group_name,type,title,ai_level,user_level,created_at) VALUES(?,?,?,?,2,3,1)');
  addFeedback.run(sharedId, '人工同名群', 'assignment', '实验报告');
  addFeedback.run(otherId, '人工同名群', 'assignment', '另一份实验');
  const app = new Hono(); registerBusinessRoutes(app);
  await app.request(`/api/groups/${qq}/data`, { method: 'DELETE' });
  expect(db.prepare('SELECT event_id FROM level_feedback ORDER BY event_id').all()).toEqual([{ event_id: sharedId }, { event_id: otherId }]);
  await app.request(`/api/groups/${encodeURIComponent(wechat)}/data`, { method: 'DELETE' });
  expect(db.prepare('SELECT event_id FROM level_feedback').all()).toEqual([{ event_id: otherId }]);
});
