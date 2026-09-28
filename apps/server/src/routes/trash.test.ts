// 回收站：GET /api/trash、POST /api/trash/:id/restore，以及 PATCH 手动取消写 history
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { registerBusinessRoutes } from './business.js';
import { TRASH_KEEP_MS, registerTrashRoutes } from './trash.js';
import type { EventDTO, EventDetailDTO, TrashItemDTO } from '../types.js';

const FIXED_NOW = Date.parse('2026-09-23T12:00:00+08:00');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

function freshApp(): Hono {
  openDb(':memory:');
  db.prepare(
    "INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('g1', '高数(2)班', 1, 'demo', ?)",
  ).run(FIXED_NOW);
  const app = new Hono();
  registerBusinessRoutes(app);
  registerTrashRoutes(app);
  return app;
}

function addEvent(opts: { title?: string; start_at?: number | null; location?: string | null; status?: string } = {}): number {
  const res = db
    .prepare(
      `INSERT INTO events (group_id, type, title, description, start_at, location, status, confidence, version, created_at, updated_at)
       VALUES ('g1', 'exam', ?, '', ?, ?, ?, 0.9, 1, ?, ?)`,
    )
    .run(opts.title ?? '高数小测', opts.start_at ?? null, opts.location ?? null, opts.status ?? 'active', FIXED_NOW - DAY, FIXED_NOW - DAY);
  return Number(res.lastInsertRowid);
}

/** 模拟流水线按群消息改事件：同 reconcile.writeChange（升 version + history + 来源快照） */
function groupChange(eventId: number, changes: Record<string, { from: unknown; to: unknown }>, msgId: string, text: string, at: number): void {
  const fields = Object.keys(changes);
  const { version } = db.prepare('SELECT version FROM events WHERE id = ?').get(eventId) as { version: number };
  db.prepare(`UPDATE events SET ${fields.map((f) => `${f} = ?`).join(', ')}, version = ?, updated_at = ? WHERE id = ?`).run(
    ...fields.map((f) => changes[f]!.to as string | number | null),
    version + 1,
    at,
    eventId,
  );
  db.prepare(
    'INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at) VALUES (?, ?, ?, ?, ?)',
  ).run(eventId, version + 1, JSON.stringify(changes), msgId, at);
  db.prepare(
    "INSERT INTO event_sources (event_id, message_id, sender_name, text, sent_at) VALUES (?, ?, '张老师', ?, ?)",
  ).run(eventId, msgId, text, at);
}

async function getTrash(app: Hono): Promise<TrashItemDTO[]> {
  const res = await app.request('/api/trash');
  expect(res.status).toBe(200);
  return (await res.json()) as TrashItemDTO[];
}

async function restore(app: Hono, id: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`/api/trash/${id}/restore`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
}

async function patch(app: Hono, id: number, body: unknown): Promise<EventDetailDTO> {
  const res = await app.request(`/api/events/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as EventDetailDTO;
}

async function calendar(app: Hono): Promise<EventDTO[]> {
  return (await (await app.request('/api/events')).json()) as EventDTO[];
}

describe('回收站：取消的事件', () => {
  it('自己取消 → 进回收站（by=manual）→ 恢复后回到日历', async () => {
    const app = freshApp();
    const id = addEvent({ start_at: FIXED_NOW + DAY });
    db.prepare('UPDATE events SET manual_locked_fields = ? WHERE id = ?').run('["location"]', id);

    const detail = await patch(app, id, { status: 'cancelled' });
    // 手动改状态记一条 history，不升 version
    expect(detail.version).toBe(1);
    expect(detail.history.at(-1)).toMatchObject({
      changed_fields: { status: { from: 'active', to: 'cancelled' } },
      source_message_id: null,
    });
    expect(await calendar(app)).toEqual([]);

    const [item, ...rest] = await getTrash(app);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      id: `cancel-${id}`,
      kind: 'cancelled',
      by: 'manual',
      source_text: null,
      at: FIXED_NOW,
      expires_at: FIXED_NOW + TRASH_KEEP_MS,
    });
    expect(item!.event.title).toBe('高数小测');
    expect(item!.event.manual_locked_fields).toEqual(['location']);

    const res = await restore(app, `cancel-${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect((await calendar(app)).map((e) => e.id)).toEqual([id]);
  });

  it('群消息取消 → by=group，带原文；取消前是待确认的恢复回待确认', async () => {
    const app = freshApp();
    const id = addEvent({ start_at: FIXED_NOW + DAY, status: 'pending_confirm' });
    groupChange(id, { status: { from: 'pending_confirm', to: 'cancelled' } }, 'm1', '小测取消了', FIXED_NOW - HOUR);

    const [item] = await getTrash(app);
    expect(item).toMatchObject({ kind: 'cancelled', by: 'group', source_text: '小测取消了', at: FIXED_NOW - HOUR });

    await restore(app, `cancel-${id}`);
    const row = db.prepare('SELECT status, version FROM events WHERE id = ?').get(id) as { status: string; version: number };
    expect(row).toEqual({ status: 'pending_confirm', version: 2 });
  });

  it('拒绝低置信度新增只是确认误识别，不伪装成可恢复的取消项', async () => {
    const app = freshApp();
    const id = addEvent({ start_at: FIXED_NOW + DAY, status: 'pending_confirm' });
    const proposalId = Number(db.prepare(
      `INSERT INTO event_proposals
         (event_id, kind, reason, proposed_changes, source_message_ids, confidence,
          base_version, base_status, status, created_at)
       VALUES (?, 'create', 'low_confidence', ?, '["m-create"]', 0.4, 1,
               'pending_confirm', 'pending', ?)`,
    ).run(
      id,
      JSON.stringify({ status: { from: 'pending_confirm', to: 'active' } }),
      FIXED_NOW - HOUR,
    ).lastInsertRowid);

    const resolved = await app.request(`/api/events/${id}/proposals/${proposalId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', expected_version: 1 }),
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json()) as EventDetailDTO).toMatchObject({ status: 'cancelled' });
    expect(await getTrash(app)).toEqual([]);
  });

  it('老数据没有取消记录：按 updated_at 算时间，恢复成 active', async () => {
    const app = freshApp();
    const id = addEvent({ status: 'cancelled' });
    const [item] = await getTrash(app);
    expect(item).toMatchObject({ by: 'manual', at: FIXED_NOW - DAY, changes: { status: { from: 'active', to: 'cancelled' } } });
    await restore(app, `cancel-${id}`);
    expect((db.prepare('SELECT status FROM events WHERE id = ?').get(id) as { status: string }).status).toBe('active');
  });

  it('超过 30 天的不显示，也不能恢复（库里还在）', async () => {
    const app = freshApp();
    const id = addEvent({ start_at: FIXED_NOW + DAY });
    groupChange(id, { status: { from: 'active', to: 'cancelled' } }, 'm1', '取消', FIXED_NOW - 31 * DAY);
    expect(await getTrash(app)).toEqual([]);
    expect((await restore(app, `cancel-${id}`)).status).toBe(409);
    expect(db.prepare('SELECT 1 AS ok FROM events WHERE id = ?').get(id)).toBeDefined();
  });
});

describe('回收站：群消息改期 / 改地点', () => {
  it('改期后旧版本进回收站；恢复 → 时间地点改回去，写手动 history，不升 version', async () => {
    const app = freshApp();
    const oldT = FIXED_NOW + 2 * DAY;
    const newT = FIXED_NOW + 3 * DAY;
    const id = addEvent({ start_at: oldT, location: 'A301' });
    groupChange(
      id,
      { start_at: { from: oldT, to: newT }, location: { from: 'A301', to: 'A203' }, level: { from: 2, to: 3 } },
      'm2',
      '小测改到大后天，教室改 A203',
      FIXED_NOW - HOUR,
    );

    const items = await getTrash(app);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'changed',
      by: 'group',
      source_text: '小测改到大后天，教室改 A203',
      // level 不在回收站里显示、也不跟着回退
      changes: { start_at: { from: oldT, to: newT }, location: { from: 'A301', to: 'A203' } },
    });
    expect(items[0]!.changes).not.toHaveProperty('level');

    const res = await restore(app, items[0]!.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    const row = db.prepare('SELECT start_at, location, level, version FROM events WHERE id = ?').get(id);
    expect(row).toEqual({ start_at: oldT, location: 'A301', level: 3, version: 2 });
    const last = db.prepare('SELECT changed_fields, source_message_id FROM event_history ORDER BY id DESC LIMIT 1').get() as {
      changed_fields: string;
      source_message_id: string | null;
    };
    expect(last.source_message_id).toBeNull();
    expect(JSON.parse(last.changed_fields)).toEqual({
      start_at: { from: newT, to: oldT },
      location: { from: 'A203', to: 'A301' },
    });

    // 再恢复一次：已经不在回收站 → 409
    expect((await restore(app, items[0]!.id)).status).toBe(409);
  });

  it('连改两次：只有还在生效的那次能恢复，恢复一次退一步', async () => {
    const app = freshApp();
    const t1 = FIXED_NOW + DAY;
    const t2 = FIXED_NOW + 2 * DAY;
    const t3 = FIXED_NOW + 3 * DAY;
    const id = addEvent({ start_at: t1 });
    groupChange(id, { start_at: { from: t1, to: t2 } }, 'm1', '改到后天', FIXED_NOW - 2 * HOUR);
    groupChange(id, { start_at: { from: t2, to: t3 } }, 'm2', '再改到大后天', FIXED_NOW - HOUR);

    let items = await getTrash(app);
    expect(items.map((i) => i.source_text)).toEqual(['再改到大后天']);
    await restore(app, items[0]!.id);
    expect((db.prepare('SELECT start_at FROM events WHERE id = ?').get(id) as { start_at: number }).start_at).toBe(t2);

    items = await getTrash(app);
    expect(items.map((i) => i.source_text)).toEqual(['改到后天']);
    await restore(app, items[0]!.id);
    expect((db.prepare('SELECT start_at FROM events WHERE id = ?').get(id) as { start_at: number }).start_at).toBe(t1);
    expect(await getTrash(app)).toEqual([]);
  });

  it('只改了说明 / 等级的不算「从日历消失」，不进回收站；手动调级也不进', async () => {
    const app = freshApp();
    const id = addEvent({ start_at: FIXED_NOW + DAY });
    groupChange(id, { description: { from: '', to: '闭卷' }, level: { from: 2, to: 4 } }, 'm1', '闭卷哦', FIXED_NOW - HOUR);
    await patch(app, id, { level: 1 });
    await patch(app, id, { status: 'done' });
    expect(await getTrash(app)).toEqual([]);
  });

  it('事件被取消时只列「取消」那一项，不重复列它之前的改期', async () => {
    const app = freshApp();
    const id = addEvent({ start_at: FIXED_NOW + DAY });
    groupChange(id, { start_at: { from: FIXED_NOW + DAY, to: FIXED_NOW + 2 * DAY } }, 'm1', '改期', FIXED_NOW - 2 * HOUR);
    groupChange(id, { status: { from: 'active', to: 'cancelled' } }, 'm2', '取消', FIXED_NOW - HOUR);
    const items = await getTrash(app);
    expect(items.map((i) => i.kind)).toEqual(['cancelled']);
  });

  it('按时间倒序', async () => {
    const app = freshApp();
    const a = addEvent({ title: 'A', start_at: FIXED_NOW + DAY });
    const b = addEvent({ title: 'B', start_at: FIXED_NOW + DAY });
    groupChange(a, { start_at: { from: FIXED_NOW + DAY, to: FIXED_NOW + 2 * DAY } }, 'm1', '改期', FIXED_NOW - 3 * HOUR);
    await patch(app, b, { status: 'cancelled' });
    expect((await getTrash(app)).map((i) => i.event.title)).toEqual(['B', 'A']);
  });
});

describe('POST /api/trash/:id/restore 参数', () => {
  it('id 不合法 → 400；不存在 → 404；没取消的事件 → 409', async () => {
    const app = freshApp();
    const id = addEvent();
    for (const bad of ['x', 'cancel-', 'cancel-0', 'change-abc', 'delete-1']) {
      expect((await restore(app, bad)).status).toBe(400);
    }
    expect((await restore(app, 'cancel-999')).status).toBe(404);
    expect((await restore(app, 'change-999')).status).toBe(404);
    const res = await restore(app, `cancel-${id}`);
    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error');
  });
});
