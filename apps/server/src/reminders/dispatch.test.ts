import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultReminderRules } from '../../../../shared/reminders.js';
import { db, openDb } from '../db/index.js';
import { ReminderDispatcher, reminderCardHtml, type ReminderCard } from './dispatch.js';
import { ReminderOutbox } from './outbox.js';
const now = Date.parse('2026-10-10T08:00:00Z');
const input = { now, budgetDay: '2026-10-10' };
beforeEach(() => {
  openDb(':memory:');
  db.exec("INSERT INTO groups(group_id,name,adapter,created_at) VALUES('synthetic','人工群','onebot',1)");
});
afterEach(() => db.close());
function seed(id: number, changes: { status?: string; deadline?: number } = {}) {
  db.prepare('INSERT INTO events(id,group_id,type,title,description,status,confidence,deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,1,1)')
    .run(id, 'synthetic', 'assignment', '人工作业', '<script>人工摘要</script>', changes.status ?? 'active', changes.deadline ?? now + 3600_000);
}
function fixture(enabled = true) {
  let rules = { ...defaultReminderRules(), enabled };
  let current = true;
  const send = vi.fn(async (_card: ReminderCard) => ({ state: 'accepted' as const, receipt: 'synthetic-receipt' }));
  const dispatcher = new ReminderDispatcher({ spaceId: 'synthetic-space', targetId: 'synthetic-target',
    current: () => current, rules: () => rules, send });
  return { dispatcher, send, rules: (value: typeof rules) => { rules = value; }, revoke: () => { current = false; } };
}
it('默认关闭和绑定失效时完全不调用渠道，也不预留发送记录', async () => {
  seed(1); const f = fixture(false);
  expect(await f.dispatcher.run(input)).toEqual({ attempted: 0, blocked: 'disabled' });
  f.revoke(); expect((await f.dispatcher.run(input)).blocked).toBe('not_current');
  expect(f.send).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) n FROM kv WHERE key GLOB 'reminder_attempt_v1:*'").get()!.n).toBe(0);
});
it('补发合并、排除已处理/已截止/未确认事项；只含获准字段且不泄露聊天正文', async () => {
  seed(1); seed(2); seed(3, { status: 'done' }); seed(4, { deadline: now }); seed(5, { status: 'pending_confirm' });
  db.prepare("INSERT INTO messages(group_id,message_id,sender_name,text,sent_at,source,created_at) VALUES('synthetic','synthetic-message','member','RAW_CHAT_MUST_STAY_LOCAL',1,'onebot',1)").run();
  const f = fixture(); expect(await f.dispatcher.run(input)).toEqual({ attempted: 1, blocked: null });
  expect(f.send).toHaveBeenCalledOnce(); const card = f.send.mock.calls[0]![0];
  expect(JSON.stringify(card)).not.toContain('RAW_CHAT_MUST_STAY_LOCAL');
  expect(card.items.map(item => item.event_id)).toEqual([1, 2]);
  expect(card.items[0]).toMatchObject({ group_names: ['人工群'], deadline_at: now + 3600_000 });
  const html = reminderCardHtml(card, () => '人工时间');
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  await f.dispatcher.run({ ...input, now: now + 1000 }); expect(f.send).toHaveBeenCalledOnce();
  expect(new ReminderOutbox('synthetic-space', 'synthetic-target').list()[0]!.state).toBe('accepted');
});
it('未知请求结果不自动重发，原始渠道异常不会向外泄露', async () => {
  seed(1); const f = fixture(); f.send.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_CHANNEL_TEXT'));
  expect((await f.dispatcher.run(input)).attempted).toBe(1);
  expect(new ReminderOutbox('synthetic-space', 'synthetic-target').list()[0]!.state).toBe('unknown');
  await f.dispatcher.run(input); expect(f.send).toHaveBeenCalledOnce();
});
it('同实例不并发；请求在途时换空间，迟到回执不会写新空间', async () => {
  seed(1); const f = fixture();
  let finish!: (result: { state: 'accepted'; receipt: string }) => void;
  f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const running = f.dispatcher.run(input);
  expect(f.send).toHaveBeenCalledOnce(); expect((await f.dispatcher.run(input)).blocked).toBe('in_flight');
  openDb(':memory:'); finish({ state: 'accepted', receipt: 'synthetic-receipt' });
  expect((await running).blocked).toBe('not_current');
  expect(db.prepare("SELECT COUNT(*) n FROM kv WHERE key GLOB 'reminder_attempt_v1:*'").get()!.n).toBe(0);
});
