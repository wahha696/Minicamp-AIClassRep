// 用 :memory: 库，不碰 data/classrep.db
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { resolveEventProposal } from '../event-proposals.js';
import type { Message } from '../types.js';
import type { ExtractedEvent } from './extract.js';
import { applyEvents, listActiveEvents, titleSimilarity } from './reconcile.js';

const G = 'demo-test';
const DAY = 86400_000;
const T0 = Date.parse('2026-09-29T14:00+08:00'); // 周二 14:00

let seq = 0;
const msg = (text: string): Message => ({
  message_id: `m${++seq}`,
  group_id: G,
  group_name: '测试群',
  sender_name: '班长',
  text,
  sent_at: T0 - DAY + seq * 60_000,
});

const ev = (m: Message, over: Partial<ExtractedEvent> = {}): ExtractedEvent => ({
  action: 'create',
  update_of: null,
  type: 'exam',
  title: '高数小测',
  description: '第三章导数与微分',
  start_at: T0,
  end_at: null,
  deadline_at: null,
  location: 'A301',
  action_required: '带计算器',
  confidence: 0.9,
  level: 2,
  source_message_ids: [m.message_id],
  ...over,
});

const events = () => db.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[];
const history = (id: number) =>
  db.prepare('SELECT * FROM event_history WHERE event_id = ? ORDER BY version').all(id) as Record<string, unknown>[];
const sources = (id: number) =>
  db.prepare('SELECT * FROM event_sources WHERE event_id = ? ORDER BY sent_at').all(id) as Record<string, unknown>[];
const proposals = (id: number) =>
  db.prepare('SELECT * FROM event_proposals WHERE event_id = ? ORDER BY id').all(id) as Array<{
    id: number;
    kind: string;
    proposed_changes: string;
    source_message_ids: string;
    status: string;
  }>;

/** 建一个事件并返回它的 id */
function create(over: Partial<ExtractedEvent> = {}, text = '明天下午两点 A301 高数小测'): number {
  const m = msg(text);
  applyEvents(G, [ev(m, over)], [m]);
  return Number(events().at(-1)!.id);
}

beforeAll(() => openDb(':memory:'));
afterAll(() => db.close());
beforeEach(() => {
  db.exec('DELETE FROM event_proposals; DELETE FROM events; DELETE FROM event_sources; DELETE FROM event_history;');
});

describe('update', () => {
  it('改期：库里 1 条、version=2、history 1 条、sources 2 条', () => {
    const id = create();
    const m = msg('小测改到周五下午两点，教室改 A203');
    const fri = T0 + 3 * DAY;
    applyEvents(
      G,
      [ev(m, { action: 'update', update_of: id, title: '', description: '', start_at: fri, location: 'A203', action_required: null })],
      [m],
    );

    const all = events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id,
      version: 2,
      start_at: fri,
      location: 'A203',
      title: '高数小测', // 空标题 = 不改
      description: '第三章导数与微分',
      action_required: '带计算器', // null = 不改
      status: 'active',
    });

    const h = history(id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ version: 2, source_message_id: m.message_id });
    expect(JSON.parse(h[0]!.changed_fields as string)).toEqual({
      start_at: { from: T0, to: fri },
      location: { from: 'A301', to: 'A203' },
    });

    const s = sources(id);
    expect(s).toHaveLength(2);
    expect(s[1]).toMatchObject({ message_id: m.message_id, sender_name: '班长', text: m.text, sent_at: m.sent_at });
  });

  it('值都没变：不升版本、不写 history，但追加来源', () => {
    const id = create();
    const m = msg('对，明天下午两点 A301');
    applyEvents(G, [ev(m, { action: 'update', update_of: id })], [m]);
    expect(events()[0]).toMatchObject({ version: 1 });
    expect(history(id)).toHaveLength(0);
    expect(sources(id)).toHaveLength(2);
  });

  it('update_of 无效（不存在 / 别的群）且标题不像 → 当作新建', () => {
    const other = msg('别的群的事');
    applyEvents('demo-other', [ev(other, { title: '英语四级报名', type: 'announcement' })], [other]);
    const foreign = Number(events()[0]!.id);

    const m = msg('周四交线代作业');
    applyEvents(
      G,
      [
        ev(m, { action: 'update', update_of: foreign, title: '线代作业', type: 'assignment' }),
        ev(m, { action: 'update', update_of: 9999, title: '体测', type: 'activity' }),
      ],
      [m],
    );
    expect(events().map((e) => [e.group_id, e.title, e.version])).toEqual([
      ['demo-other', '英语四级报名', 1],
      [G, '线代作业', 1],
      [G, '体测', 1],
    ]);
  });

  it('update_of 无效且没有标题 → 忽略', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = msg('改到周五');
    applyEvents(G, [ev(m, { action: 'update', update_of: 9999, title: '' })], [m]);
    expect(events()).toHaveLength(0);
  });
});

describe('cancel', () => {
  it('status=cancelled，写 history，追加来源', () => {
    const id = create({ type: 'activity', title: '迎新茶话会' });
    const m = msg('周六的迎新茶话会取消了');
    applyEvents(G, [ev(m, { action: 'cancel', update_of: id, title: '', type: 'activity' })], [m]);
    expect(events()[0]).toMatchObject({ status: 'cancelled', version: 2 });
    expect(JSON.parse(history(id)[0]!.changed_fields as string)).toEqual({
      status: { from: 'active', to: 'cancelled' },
    });
    expect(sources(id)).toHaveLength(2);
  });

  it('已取消的事件不再被改', () => {
    const id = create({ type: 'activity', title: '迎新茶话会' });
    const c = msg('取消');
    applyEvents(G, [ev(c, { action: 'cancel', update_of: id, type: 'activity' })], [c]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const again = msg('取消了取消了');
    applyEvents(G, [ev(again, { action: 'cancel', update_of: id, type: 'activity' })], [again]);
    expect(events()[0]).toMatchObject({ version: 2 });
  });

  it('A03：低置信度取消不直接取消 → 转 pending_confirm，来源照留', () => {
    const id = create({ type: 'activity', title: '迎新茶话会' });
    const m = msg('好像取消了？');
    applyEvents(G, [ev(m, { action: 'cancel', update_of: id, title: '', type: 'activity', confidence: 0.4 })], [m]);
    expect(events()[0]).toMatchObject({ status: 'pending_confirm', version: 2 });
    expect(JSON.parse(history(id)[0]!.changed_fields as string)).toEqual({
      status: { from: 'active', to: 'pending_confirm' },
    });
    expect(sources(id)).toHaveLength(2); // 原消息 + 取消消息都留证
  });

  it('A03：pending_confirm 上再来低置信度取消 → 维持待确认；高置信度取消 → 照取消', () => {
    const id = create({ type: 'activity', title: '迎新茶话会', confidence: 0.4 });
    expect(events()[0]).toMatchObject({ status: 'pending_confirm' });
    const m1 = msg('取消了吧');
    applyEvents(G, [ev(m1, { action: 'cancel', update_of: id, type: 'activity', confidence: 0.3 })], [m1]);
    expect(events()[0]).toMatchObject({ status: 'pending_confirm', version: 1 }); // 没写重复 history
    const m2 = msg('确认了，取消');
    applyEvents(G, [ev(m2, { action: 'cancel', update_of: id, type: 'activity', confidence: 0.9 })], [m2]);
    expect(events()[0]).toMatchObject({ status: 'cancelled', version: 2 });
  });
});

describe('A03：低置信度关键变更 → pending_confirm 门', () => {
  it('低置信度改期保留原时间，事件转待确认，改动留在来源快照', () => {
    const id = create();
    const m = msg('可能改到周五了？');
    applyEvents(
      G,
      [ev(m, { action: 'update', update_of: id, title: '', start_at: T0 + 3 * DAY, confidence: 0.4 })],
      [m],
    );
    const row = events()[0]!;
    expect(row).toMatchObject({ status: 'pending_confirm', start_at: T0, version: 2 });
    // 拟改动没写进字段，但这条消息进了来源——界面上能核对
    expect(sources(id).map((s) => s.text)).toContain('可能改到周五了？');
    expect(JSON.parse(history(id)[0]!.changed_fields as string)).toEqual({
      status: { from: 'active', to: 'pending_confirm' },
    });
  });

  it('低置信度只动非关键字段也先挂起，不静默覆盖', () => {
    const id = create();
    const m = msg('补充：带学生证');
    applyEvents(
      G,
      [ev(m, { action: 'update', update_of: id, title: '', description: '补充：带学生证', action_required: '带学生证', confidence: 0.4 })],
      [m],
    );
    expect(events()[0]).toMatchObject({ status: 'pending_confirm', action_required: '带计算器', version: 2 });
    expect(JSON.parse(proposals(id)[0]!.proposed_changes)).toMatchObject({
      description: { from: '第三章导数与微分', to: '补充：带学生证' },
      action_required: { from: '带计算器', to: '带学生证' },
    });
  });

  it('已经是 pending_confirm 的低置信度关键变更 → 只追加来源', () => {
    const id = create({ confidence: 0.4 });
    const m = msg('好像又变了');
    applyEvents(
      G,
      [ev(m, { action: 'update', update_of: id, title: '', start_at: T0 + DAY, confidence: 0.3 })],
      [m],
    );
    expect(events()[0]).toMatchObject({ status: 'pending_confirm', start_at: T0, version: 1 });
    expect(sources(id)).toHaveLength(2);
  });

  it('高置信度改期照常覆盖（不进门）', () => {
    const id = create();
    const m = msg('改到周五了');
    applyEvents(
      G,
      [ev(m, { action: 'update', update_of: id, title: '', start_at: T0 + 3 * DAY, confidence: 0.9 })],
      [m],
    );
    expect(events()[0]).toMatchObject({ status: 'active', start_at: T0 + 3 * DAY, version: 2 });
  });

  it('低置信度改期把全部候选字段保存为结构化提案，当前安排保持不动', () => {
    const id = create();
    const m = msg('可能改到周五 B201，还要带学生证');
    applyEvents(
      G,
      [ev(m, {
        action: 'update',
        update_of: id,
        title: '',
        start_at: T0 + 3 * DAY,
        location: 'B201',
        action_required: '带学生证',
        confidence: 0.4,
      })],
      [m],
    );

    expect(events()[0]).toMatchObject({
      status: 'pending_confirm',
      start_at: T0,
      location: 'A301',
      action_required: '带计算器',
    });
    const [proposal] = proposals(id);
    expect(proposal).toMatchObject({ kind: 'update', status: 'pending' });
    expect(JSON.parse(proposal!.proposed_changes)).toEqual({
      start_at: { from: T0, to: T0 + 3 * DAY },
      location: { from: 'A301', to: 'B201' },
      action_required: { from: '带计算器', to: '带学生证' },
    });
    expect(JSON.parse(proposal!.source_message_ids)).toEqual([m.message_id]);
  });

  it('人工锁定字段遇到高置信度新值：锁定字段进提案，未锁字段正常更新', () => {
    const id = create();
    db.prepare("UPDATE events SET manual_locked_fields = '[\"start_at\"]' WHERE id = ?").run(id);
    const m = msg('确认改到周五 B201');
    applyEvents(
      G,
      [ev(m, {
        action: 'update',
        update_of: id,
        title: '',
        start_at: T0 + 3 * DAY,
        location: 'B201',
        confidence: 0.95,
      })],
      [m],
    );

    expect(events()[0]).toMatchObject({
      status: 'pending_confirm',
      start_at: T0,
      location: 'B201',
      manual_locked_fields: '["start_at"]',
    });
    expect(JSON.parse(proposals(id)[0]!.proposed_changes)).toEqual({
      start_at: { from: T0, to: T0 + 3 * DAY },
    });
  });

  it('未确认新建后又出现改期和取消，三类提案互不覆盖；同一来源重复处理不重复新增', () => {
    const first = msg('可能有一场高数小测');
    applyEvents(G, [ev(first, { confidence: 0.4 })], [first]);
    const id = Number(events()[0]!.id);

    const update = msg('好像改到周五');
    const updateEvent = ev(update, {
      action: 'update',
      update_of: id,
      title: '',
      start_at: T0 + 3 * DAY,
      confidence: 0.4,
    });
    applyEvents(G, [updateEvent], [update]);
    applyEvents(G, [updateEvent], [update]);

    const cancel = msg('听说又取消了');
    applyEvents(
      G,
      [ev(cancel, { action: 'cancel', update_of: id, title: '', confidence: 0.4 })],
      [cancel],
    );

    expect(events()[0]).toMatchObject({ status: 'pending_confirm', start_at: T0 });
    expect(proposals(id).map((p) => [p.kind, p.status])).toEqual([
      ['create', 'pending'],
      ['update', 'pending'],
      ['cancel', 'pending'],
    ]);
  });

  it('不相交的低置信度改动分别保留；高置信自动更新也不丢另一字段提案', () => {
    const id = create();
    const locationMessage = msg('地点可能改到 B201');
    applyEvents(G, [ev(locationMessage, {
      action: 'update', update_of: id, title: '', location: 'B201', confidence: 0.4,
    })], [locationMessage]);

    const timeMessage = msg('确定改到周五');
    applyEvents(G, [ev(timeMessage, {
      action: 'update', update_of: id, title: '', start_at: T0 + 3 * DAY, location: null, confidence: 0.95,
    })], [timeMessage]);

    expect(events()[0]).toMatchObject({
      status: 'pending_confirm', start_at: T0 + 3 * DAY, location: 'A301',
    });
    const pending = proposals(id).filter((proposal) => proposal.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]!.proposed_changes)).toEqual({
      location: { from: 'A301', to: 'B201' },
    });

    const actionMessage = msg('可能还要带学生证');
    applyEvents(G, [ev(actionMessage, {
      action: 'update', update_of: id, title: '', start_at: null,
      location: null, action_required: '带学生证', confidence: 0.4,
    })], [actionMessage]);
    expect(proposals(id).filter((proposal) => proposal.status === 'pending')).toHaveLength(2);
  });

  it('已处理提案的同一来源重放不会再次挂起且不会丢失结构化差异', () => {
    const id = create();
    const m = msg('地点可能改到 B201');
    const update = ev(m, {
      action: 'update', update_of: id, title: '', location: 'B201', confidence: 0.4,
    });
    applyEvents(G, [update], [m]);
    const proposal = proposals(id)[0]!;
    const event = events()[0]!;
    expect(resolveEventProposal(
      id,
      proposal.id,
      'reject',
      Number(event.version),
      Number(event.updated_at),
    )).toBe('ok');

    applyEvents(G, [update], [m]);
    expect(events()[0]).toMatchObject({ status: 'active', location: 'A301' });
    expect(proposals(id).map((item) => item.status)).toEqual(['rejected']);
  });

  it('已拒绝的低置信度新建来源重放不会创建第二条事件', () => {
    const m = msg('可能有一场临时小测');
    const createEvent = ev(m, { confidence: 0.4 });
    applyEvents(G, [createEvent], [m]);
    const event = events()[0]!;
    const proposal = proposals(Number(event.id))[0]!;
    expect(resolveEventProposal(
      Number(event.id),
      proposal.id,
      'reject',
      Number(event.version),
      Number(event.updated_at),
    )).toBe('ok');

    applyEvents(G, [createEvent], [m]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ status: 'cancelled' });
  });

  it('pending create 人工改值再拒绝后，同来源被改判为 update 也不新建第二条事件', () => {
    const m = msg('可能在 A301 有一场高数小测');
    const original = ev(m, { confidence: 0.4 });
    applyEvents(G, [original], [m]);
    const id = Number(events()[0]!.id);
    const proposal = proposals(id)[0]!;
    const persistedBeforeEdit = db.prepare(
      'SELECT event_fingerprint FROM event_proposals WHERE id = ?',
    ).get(proposal.id) as { event_fingerprint: string };
    expect(JSON.parse(persistedBeforeEdit.event_fingerprint)).toMatchObject({
      title: '高数小测',
      description: '第三章导数与微分',
      start_at: T0,
      location: 'A301',
    });

    db.prepare(
      `UPDATE events SET title = '人工核对后的临时测验', description = '人工补充说明',
         start_at = ?, location = '人工确认 B202',
         manual_locked_fields = '["title","description","start_at","location"]',
         updated_at = updated_at + 1 WHERE id = ?`,
    ).run(T0 + DAY, id);
    const edited = events()[0]!;
    expect(resolveEventProposal(
      id,
      proposal.id,
      'reject',
      Number(edited.version),
      Number(edited.updated_at),
    )).toBe('ok');

    // update 的正式合约只带实际字段，其余是 ''/null；不能拿这些空值做完整指纹比较。
    // update_of 丢失且标题已被人工改到无法模糊匹配，只能用持久化快照做稀疏约束查重。
    applyEvents(G, [ev(m, {
      action: 'update',
      update_of: null,
      title: '高数小测',
      description: '',
      start_at: null,
      end_at: null,
      deadline_at: null,
      location: 'A301',
      action_required: null,
      level: null,
      confidence: 0.95,
    })], [m]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      status: 'cancelled',
      title: '人工核对后的临时测验',
      location: '人工确认 B202',
    });
    expect(proposals(id).map((item) => item.status)).toEqual(['rejected']);
    expect((db.prepare('SELECT event_fingerprint FROM event_proposals WHERE id = ?').get(proposal.id) as {
      event_fingerprint: string;
    }).event_fingerprint).toBe(persistedBeforeEdit.event_fingerprint);
  });

  it('同一来源可提取多个不同低置信新建；拒绝一个后整批重放既不重复也不吞另一个', () => {
    const m = msg('本周有高数小测，周末还要交实验报告');
    const exam = ev(m, { title: '高数小测', confidence: 0.4 });
    const assignment = ev(m, {
      type: 'assignment',
      title: '实验报告',
      start_at: null,
      deadline_at: T0 + 4 * DAY,
      location: null,
      confidence: 0.4,
    });
    applyEvents(G, [exam, assignment], [m]);
    expect(events()).toHaveLength(2);
    expect(events().map((row) => row.title)).toEqual(['高数小测', '实验报告']);

    const examRow = events().find((row) => row.title === '高数小测')!;
    const examProposal = proposals(Number(examRow.id))[0]!;
    expect(resolveEventProposal(
      Number(examRow.id),
      examProposal.id,
      'reject',
      Number(examRow.version),
      Number(examRow.updated_at),
    )).toBe('ok');

    applyEvents(G, [exam, assignment], [m]);
    expect(events()).toHaveLength(2);
    expect(events().find((row) => row.title === '高数小测')).toMatchObject({ status: 'cancelled' });
    expect(events().find((row) => row.title === '实验报告')).toMatchObject({ status: 'pending_confirm' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_proposals WHERE kind = 'create'").get()).toEqual({ n: 2 });
  });

  it('低置信 create 接受并人工改值后，原来源跨 action 重放仍保持人工结果且不新增提案', () => {
    const m = msg('可能在 A301 有一场高数小测');
    const createEvent = ev(m, { confidence: 0.4 });
    applyEvents(G, [createEvent], [m]);
    const row = events()[0]!;
    const id = Number(row.id);
    const createProposal = proposals(id)[0]!;
    expect(resolveEventProposal(
      id,
      createProposal.id,
      'accept',
      Number(row.version),
      Number(row.updated_at),
    )).toBe('ok');
    db.prepare(
      `UPDATE events SET location = '人工确认 B202', start_at = ?,
         manual_locked_fields = '["location","start_at"]', updated_at = updated_at + 1 WHERE id = ?`,
    ).run(T0 + DAY, id);

    // 同一来源若重跑时被模型改判成 update 或 cancel，也不能反向覆盖已确认/人工修改。
    applyEvents(G, [ev(m, {
      action: 'update', update_of: id, title: '', location: 'A301', start_at: T0, confidence: 0.4,
    })], [m]);
    applyEvents(G, [ev(m, {
      action: 'cancel', update_of: id, title: '', confidence: 0.4,
    })], [m]);

    expect(events()[0]).toMatchObject({
      status: 'active', location: '人工确认 B202', start_at: T0 + DAY,
    });
    expect(proposals(id).map((proposal) => proposal.status)).toEqual(['accepted']);
  });

  it('已接受 create 被人工大幅修改后，无目标的同来源 update 仍按原始指纹幂等', () => {
    const m = msg('可能在 A301 有一场高数小测');
    const original = ev(m, { confidence: 0.4 });
    applyEvents(G, [original], [m]);
    const id = Number(events()[0]!.id);
    const createProposal = proposals(id)[0]!;
    const row = events()[0]!;
    expect(resolveEventProposal(
      id,
      createProposal.id,
      'accept',
      Number(row.version),
      Number(row.updated_at),
    )).toBe('ok');

    db.prepare(
      `UPDATE events SET title = '人工最终安排', description = '完全重写的说明',
         start_at = ?, end_at = ?, deadline_at = ?, location = 'C909',
         action_required = '携带人工确认材料', level = 4,
         manual_locked_fields = '["title","description","start_at","end_at","deadline_at","location","action_required"]',
         updated_at = updated_at + 1 WHERE id = ?`,
    ).run(T0 + 5 * DAY, T0 + 5 * DAY + 3600_000, T0 + 4 * DAY, id);

    // 没有 update_of，且原标题与人工标题不相似，findTarget 必然找不到；稀疏字段仍应
    // 唯一命中持久化的原始 create 快照。
    applyEvents(G, [ev(m, {
      action: 'update',
      update_of: null,
      title: '高数小测',
      description: '',
      start_at: null,
      end_at: null,
      deadline_at: null,
      location: 'A301',
      action_required: null,
      level: null,
      confidence: 0.99,
    })], [m]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      status: 'active',
      title: '人工最终安排',
      description: '完全重写的说明',
      start_at: T0 + 5 * DAY,
      location: 'C909',
      level: 4,
    });
    expect(proposals(id).map((proposal) => proposal.status)).toEqual(['accepted']);
  });

  it('稀疏 update_of 指向已拒绝 create 时优先按来源判重，不误改同名 LIVE 事件', () => {
    const originalMessage = msg('可能在 A301 有一场高数小测');
    applyEvents(G, [ev(originalMessage, { confidence: 0.4 })], [originalMessage]);
    const rejectedId = Number(events()[0]!.id);
    const createProposal = proposals(rejectedId)[0]!;
    const pending = events()[0]!;
    expect(resolveEventProposal(
      rejectedId,
      createProposal.id,
      'reject',
      Number(pending.version),
      Number(pending.updated_at),
    )).toBe('ok');

    const liveMessage = msg('确定有一场高数小测，在 C909');
    applyEvents(G, [ev(liveMessage, {
      title: '高数小测',
      location: 'C909',
      start_at: T0 + DAY,
      confidence: 0.95,
    })], [liveMessage]);
    const live = events().find((row) => row.status === 'active')!;

    // q.byId 找不到 cancelled 的 rejectedId；若先做模糊匹配，会错误命中并改写同名 live。
    applyEvents(G, [ev(originalMessage, {
      action: 'update',
      update_of: rejectedId,
      title: '',
      description: '',
      start_at: null,
      end_at: null,
      deadline_at: null,
      location: 'A301',
      action_required: null,
      level: null,
      confidence: 0.9,
    })], [originalMessage]);

    expect(events()).toHaveLength(2);
    expect(events().find((row) => row.id === live.id)).toMatchObject({
      status: 'active', location: 'C909', start_at: T0 + DAY, version: 1,
    });
  });

  it('同一来源的稀疏重放只匹配满足约束的 create，不吞掉新的不同事件', () => {
    const m = msg('可能有高数小测和线代小测');
    const calculus = ev(m, { title: '高数小测', location: 'A301', confidence: 0.4 });
    const algebra = ev(m, {
      title: '线代小测',
      location: 'B202',
      start_at: T0 + DAY,
      confidence: 0.4,
    });
    applyEvents(G, [calculus, algebra], [m]);
    expect(events()).toHaveLength(2);

    for (const row of events()) {
      const proposal = proposals(Number(row.id))[0]!;
      expect(resolveEventProposal(
        Number(row.id), proposal.id, 'reject', Number(row.version), Number(row.updated_at),
      )).toBe('ok');
    }

    // 稀疏字段唯一指向线代快照，因此是重放。
    applyEvents(G, [ev(m, {
      action: 'update', update_of: null, title: '线代小测', description: '',
      start_at: null, end_at: null, deadline_at: null, location: 'B202',
      action_required: null, level: null, confidence: 0.9,
    })], [m]);
    expect(events()).toHaveLength(2);

    // 同一来源也可能包含第三件事；不满足任一旧快照的约束时必须正常新建。
    applyEvents(G, [ev(m, {
      action: 'update', update_of: null, title: '物理实验', description: '', type: 'activity',
      start_at: T0 + 2 * DAY, end_at: null, deadline_at: null, location: '实验楼',
      action_required: null, level: null, confidence: 0.95,
    })], [m]);
    expect(events()).toHaveLength(3);
    expect(events().at(-1)).toMatchObject({ title: '物理实验', location: '实验楼', status: 'active' });
  });

  it('低置信 create 后的 update/cancel 继承 active 基线，排列处理完不会卡 pending', () => {
    const createMessage = msg('可能有一场临时小测');
    applyEvents(G, [ev(createMessage, { confidence: 0.4 })], [createMessage]);
    const id = Number(events()[0]!.id);

    const updateMessage = msg('地点可能改到 B201');
    applyEvents(G, [ev(updateMessage, {
      action: 'update', update_of: id, title: '', location: 'B201', confidence: 0.4,
    })], [updateMessage]);
    const cancelMessage = msg('也可能取消');
    applyEvents(G, [ev(cancelMessage, {
      action: 'cancel', update_of: id, title: '', confidence: 0.4,
    })], [cancelMessage]);

    const byKind = Object.fromEntries(proposals(id).map((proposal) => [proposal.kind, proposal]));
    const decide = (proposalId: number, decision: 'accept' | 'reject') => {
      const row = events()[0]!;
      return resolveEventProposal(
        id, proposalId, decision, Number(row.version), Number(row.updated_at),
      );
    };
    expect(decide(byKind.create!.id, 'accept')).toBe('ok');
    expect(events()[0]).toMatchObject({ status: 'pending_confirm' });
    expect(decide(byKind.update!.id, 'reject')).toBe('ok');
    expect(events()[0]).toMatchObject({ status: 'pending_confirm', location: 'A301' });
    expect(decide(byKind.cancel!.id, 'reject')).toBe('ok');
    expect(events()[0]).toMatchObject({ status: 'active', location: 'A301' });
    expect(proposals(id).filter((proposal) => proposal.status === 'pending')).toHaveLength(0);
  });

  it('active 上的 update/cancel 多提案无论逐条拒绝都最终恢复 active', () => {
    const id = create();
    const updateMessage = msg('地点可能改到 B201');
    applyEvents(G, [ev(updateMessage, {
      action: 'update', update_of: id, title: '', location: 'B201', confidence: 0.4,
    })], [updateMessage]);
    const cancelMessage = msg('也可能取消');
    applyEvents(G, [ev(cancelMessage, {
      action: 'cancel', update_of: id, title: '', confidence: 0.4,
    })], [cancelMessage]);

    const byKind = Object.fromEntries(proposals(id).map((proposal) => [proposal.kind, proposal]));
    for (const proposal of [byKind.cancel!, byKind.update!]) {
      const row = events()[0]!;
      expect(resolveEventProposal(
        id, proposal.id, 'reject', Number(row.version), Number(row.updated_at),
      )).toBe('ok');
    }
    expect(events()[0]).toMatchObject({ status: 'active', location: 'A301' });
    expect(proposals(id).filter((proposal) => proposal.status === 'pending')).toHaveLength(0);
  });
});

describe('create', () => {
  it('「高数期中」和「线代期中」不合并', () => {
    create({ title: '高数期中考试', location: '3号楼105' });
    create({ title: '线代期中考试', location: '3号楼207', start_at: T0 + 2 * DAY });
    expect(events().map((e) => [e.title, e.location])).toEqual([
      ['高数期中考试', '3号楼105'],
      ['线代期中考试', '3号楼207'],
    ]);
  });

  it('兜底：同群同 type 标题很像的 create 视为 update', () => {
    const id = create({ title: '高数第三章小测' });
    create({ title: '高数第三章小测！', location: 'A203' });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ id, location: 'A203', version: 2 });
  });

  it('标题像但 type 不同不合并', () => {
    create({ title: '高数第三章小测' });
    create({ title: '高数第三章小测', type: 'assignment' });
    expect(events()).toHaveLength(2);
  });

  it('confidence < 0.6 → pending_confirm，之后仍可被改期', () => {
    const id = create({ confidence: 0.4 });
    expect(events()[0]).toMatchObject({ status: 'pending_confirm' });
    const m = msg('改到周五');
    applyEvents(G, [ev(m, { action: 'update', update_of: id, title: '', start_at: T0 + 3 * DAY })], [m]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ version: 2, status: 'pending_confirm' });
  });

  it('不在 sourceMsgs 里的消息不写来源', () => {
    const m = msg('小测');
    applyEvents(G, [ev(m, { source_message_ids: [m.message_id, 'ghost'] })], [m]);
    expect(sources(Number(events()[0]!.id)).map((s) => s.message_id)).toEqual([m.message_id]);
  });

  it('同一批里先建后改能对上', () => {
    const a = msg('周二小测');
    const b = msg('改周五');
    applyEvents(
      G,
      [ev(a), ev(b, { action: 'create', title: '高数小测', start_at: T0 + 3 * DAY })],
      [a, b],
    );
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ start_at: T0 + 3 * DAY, version: 2 });
  });
});

describe('历史补齐：旧消息晚于新消息进流水线', () => {
  /** 造一条比已有消息都早的消息 */
  const oldMsg = (text: string): Message => ({ ...msg(text), sent_at: T0 - 5 * DAY });

  it('旧消息指向的已有事件是更新消息建的 → 只追加来源，不把字段改回旧的', () => {
    const id = create({ start_at: T0 + DAY, location: 'B201' }, '改到周三 B201');
    const old = oldMsg('周二 A301 小测');
    applyEvents(G, [ev(old, { action: 'update', update_of: id, start_at: T0, location: 'A301' })], [old]);
    expect(events()[0]).toMatchObject({ start_at: T0 + DAY, location: 'B201', version: 1 });
    expect(sources(id)).toHaveLength(2);
  });

  it('旧消息的取消不会取消更新消息建的事件', () => {
    const id = create();
    const old = oldMsg('小测取消');
    applyEvents(G, [ev(old, { action: 'cancel', update_of: id })], [old]);
    expect(events()[0]).toMatchObject({ status: 'active' });
  });

  it('同名不同日（差超过 1 天）的旧消息 → 另建事件，不合并', () => {
    create({ title: '组会', type: 'activity', start_at: T0 + 2 * DAY });
    const old = oldMsg('周一开组会');
    applyEvents(G, [ev(old, { title: '组会', type: 'activity', start_at: T0 - 4 * DAY })], [old]);
    expect(events()).toHaveLength(2);
    expect(events()[0]).toMatchObject({ start_at: T0 + 2 * DAY, version: 1 });
  });

  it('同名同日的旧消息 → 视为同一件事，只追加来源', () => {
    const id = create();
    const old = oldMsg('明天小测');
    applyEvents(G, [ev(old, { start_at: T0 + 3600_000 })], [old]);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ start_at: T0, version: 1 });
    expect(sources(id)).toHaveLength(2);
  });
});

describe('事务', () => {
  it('中途出错整批回滚', () => {
    const m = msg('小测');
    const bad = ev(m, { title: '坏的' }) as unknown as Record<string, unknown>;
    bad.type = null; // NOT NULL 约束失败
    expect(() => applyEvents(G, [ev(m), bad as unknown as ExtractedEvent], [m])).toThrow();
    expect(events()).toHaveLength(0);
  });
});

describe('listActiveEvents', () => {
  it('只要本群还活着、时间没过去 14 天的', () => {
    const keep = create({ title: '下周考试' });
    const old = create({ title: '上个月的考试', start_at: T0 - 20 * DAY });
    const gone = create({ title: '取消的活动', type: 'activity' });
    const c = msg('取消');
    applyEvents(G, [ev(c, { action: 'cancel', update_of: gone, type: 'activity' })], [c]);
    const o = msg('别的群');
    applyEvents('demo-other', [ev(o, { title: '别的群考试' })], [o]);

    const list = listActiveEvents(G, T0);
    expect(list.map((e) => e.id)).toEqual([keep]);
    expect(list[0]).toEqual({
      id: keep, type: 'exam', title: '下周考试', start_at: T0, end_at: null, deadline_at: null, location: 'A301',
      action_required: '带计算器', level: 2,
    });
    expect(old).toBeGreaterThan(0);
  });
});

describe('level（FR-12 危机等级）', () => {
  it('create 写 level；缺省（null）用 2', () => {
    const a = create({ level: 4 });
    const b = create({ level: null, title: '普通通知', type: 'announcement' });
    const rows = events();
    expect(rows.find((r) => r.id === a)!.level).toBe(4);
    expect(rows.find((r) => r.id === b)!.level).toBe(2);
  });

  it('update 改 level：没锁且变了 → level 更新 + history 记 level 字段', () => {
    const id = create({ level: 2 });
    const m = msg('这个其实很紧急');
    applyEvents(G, [ev(m, { action: 'update', update_of: id, title: '', level: 4 })], [m]);
    expect(events()[0]).toMatchObject({ level: 4, version: 2 });
    expect(JSON.parse(history(id)[0]!.changed_fields as string)).toMatchObject({
      level: { from: 2, to: 4 },
    });
  });

  it('level_locked=1 时 update 不改 level', () => {
    const id = create({ level: 2 });
    db.prepare('UPDATE events SET level_locked = 1 WHERE id = ?').run(id); // 模拟用户锁过
    const m = msg('AI 想降级');
    applyEvents(G, [ev(m, { action: 'update', update_of: id, title: '', level: 1 })], [m]);
    expect(events()[0]).toMatchObject({ level: 2, version: 1 });
    expect(history(id)).toHaveLength(0);
  });

  it('level 没变 / level=null → 不动', () => {
    const id = create({ level: 3 });
    const m = msg('补充说明');
    applyEvents(G, [ev(m, { action: 'update', update_of: id, title: '', level: null })], [m]);
    applyEvents(G, [ev(msg('还是 3 级'), { action: 'update', update_of: id, title: '', level: 3 })], [m]);
    expect(events()[0]).toMatchObject({ level: 3, version: 1 });
  });
});

describe('titleSimilarity', () => {
  it.each([
    ['高数期中考试', '线代期中考试', false],
    ['高数期中', '线代期中', false],
    ['高数第三章小测', '高数第三章小测！', true],
    ['牛顿环实验报告', '牛顿环实验报告提交', true],
  ])('%s vs %s → 超过阈值：%s', (a, b, same) => {
    expect(titleSimilarity(a, b) > 0.6).toBe(same);
  });
});
