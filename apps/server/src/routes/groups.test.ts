// B5 验收：GET /api/groups、PATCH /api/groups/:id、DELETE /api/groups/:id/data
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { db, openDb } from '../db/index.js';
import { registerBusinessRoutes } from './business.js';
import type { GroupDTO } from '../types.js';

// ===== 测试脚手架

function freshApp(): Hono {
  openDb(':memory:');
  const app = new Hono();
  registerBusinessRoutes(app);
  return app;
}

function addGroup(group_id: string, name: string, enabled = 1): void {
  db.prepare(
    'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(group_id, name, enabled, 'demo', Date.now());
}

function addMessage(message_id: string, group_id: string): void {
  const now = Date.now();
  db.prepare(
    'INSERT OR IGNORE INTO messages (message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)',
  ).run(message_id, group_id, '张老师', '明天下午两点小测', now, 'demo', now);
}

function addEvent(group_id: string, title: string): number {
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO events (group_id, type, title, description, start_at, status, confidence, version, created_at, updated_at)
       VALUES (?, 'exam', ?, '', ?, 'active', 0.9, 1, ?, ?)`,
    )
    .run(group_id, title, now, now, now);
  return Number(res.lastInsertRowid);
}

function count(table: string, where = '', params: unknown[] = []): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where === '' ? '' : ` WHERE ${where}`}`;
  return (db.prepare(sql).get(...(params as never[])) as { n: number }).n;
}

async function getJson(app: Hono, path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

async function patchJson(
  app: Hono,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function deleteJson(app: Hono, path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path, { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}

// ===== GET /api/groups

describe('GET /api/groups', () => {
  it('返回所有群 + message_count / event_count', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    addGroup('g2', '物理实验');
    addMessage('m1', 'g1');
    addMessage('m2', 'g1');
    addMessage('m3', 'g2');
    addEvent('g1', '高数小测');
    addEvent('g1', '期中考试');

    const { status, body } = await getJson(app, '/api/groups');
    expect(status).toBe(200);
    const groups = body as GroupDTO[];
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.group_id)).toEqual(['g1', 'g2']); // 按接入顺序
    expect(groups[0]).toMatchObject({
      group_id: 'g1',
      name: '高数(2)班',
      enabled: true,
      message_count: 2,
      event_count: 2,
    });
    expect(groups[1]).toMatchObject({ group_id: 'g2', message_count: 1, event_count: 0 });
  });

  it('enabled 是布尔值（库里存 0/1）', async () => {
    const app = freshApp();
    addGroup('g-on', '开着的群', 1);
    addGroup('g-off', '关掉的群', 0);

    const { body } = await getJson(app, '/api/groups');
    const groups = body as GroupDTO[];
    expect(groups.find((g) => g.group_id === 'g-on')!.enabled).toBe(true);
    expect(groups.find((g) => g.group_id === 'g-off')!.enabled).toBe(false);
  });

  it('没有消息/事件的群计数为 0', async () => {
    const app = freshApp();
    addGroup('g1', '空群');
    const { body } = await getJson(app, '/api/groups');
    expect((body as GroupDTO[])[0]).toMatchObject({ message_count: 0, event_count: 0 });
  });

  it('一个群都没有时返回空数组', async () => {
    const app = freshApp();
    const { status, body } = await getJson(app, '/api/groups');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('不返回 adapter 等内部字段', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const { body } = await getJson(app, '/api/groups');
    expect(Object.keys((body as GroupDTO[])[0]!).sort()).toEqual([
      'course_name',
      'enabled',
      'event_count',
      'group_id',
      'message_count',
      'name',
    ]);
  });
});

// ===== PATCH /api/groups/:id

describe('PATCH /api/groups/:id', () => {
  it('关掉某个群并持久化，返回 GroupDTO', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    addMessage('m1', 'g1');

    const { status, body } = await patchJson(app, '/api/groups/g1', { enabled: false });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      group_id: 'g1',
      name: '高数(2)班',
      enabled: false,
      message_count: 1,
      event_count: 0,
    });
    const row = db.prepare('SELECT enabled FROM groups WHERE group_id = ?').get('g1') as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
  });

  it('能再打开', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班', 0);
    const { body } = await patchJson(app, '/api/groups/g1', { enabled: true });
    expect((body as GroupDTO).enabled).toBe(true);
  });

  it('关掉之后新消息不再入库（与 ingest 联动）', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    await patchJson(app, '/api/groups/g1', { enabled: false });

    const { ingestMessages } = await import('../ingest/index.js');
    const res = ingestMessages(
      [
        {
          message_id: 'm-new',
          group_id: 'g1',
          group_name: '高数(2)班',
          sender_name: '张老师',
          text: '这条不该进库',
          sent_at: Date.now(),
        },
      ],
      'onebot',
    );
    expect(res.inserted).toBe(0);
    expect(count('messages', 'group_id = ?', ['g1'])).toBe(0);
  });

  it('enabled 不是布尔 → 400 且不改库', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');

    for (const payload of [{ enabled: 'false' }, { enabled: 1 }, { enabled: 0 }, {}, null]) {
      const res = await patchJson(app, '/api/groups/g1', payload);
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    }
    const row = db.prepare('SELECT enabled FROM groups WHERE group_id = ?').get('g1') as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
  });

  it('群不存在 → 404；请求体不是 JSON → 400', async () => {
    const app = freshApp();
    expect(await patchJson(app, '/api/groups/nope', { enabled: false })).toMatchObject({
      status: 404,
    });
    const bad = await app.request('/api/groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{不是 JSON',
    });
    expect(bad.status).toBe(400);
  });
});

// ===== DELETE /api/groups/:id/data

describe('DELETE /api/groups/:id/data', () => {
  function seed(): { eventId: number } {
    addGroup('g1', '高数(2)班');
    addGroup('g2', '物理实验');
    addMessage('m1', 'g1');
    addMessage('m2', 'g1');
    addMessage('m3', 'g2');
    const eventId = addEvent('g1', '高数小测');
    addEvent('g2', '物理实验');
    db.prepare(
      'INSERT INTO event_sources (event_id, message_id, sender_name, text, sent_at) VALUES (?, ?, ?, ?, ?)',
    ).run(eventId, 'm1', '张老师', '明天下午两点小测', Date.now());
    db.prepare(
      'INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at) VALUES (?, 1, ?, ?, ?)',
    ).run(eventId, '{"location":{"from":null,"to":"A301"}}', 'm1', Date.now());
    return { eventId };
  }

  it('删掉该群的 messages/events/sources/history，群本身保留', async () => {
    const app = freshApp();
    const { eventId } = seed();

    const { status, body } = await deleteJson(app, '/api/groups/g1/data');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });

    expect(count('messages', 'group_id = ?', ['g1'])).toBe(0);
    expect(count('events', 'group_id = ?', ['g1'])).toBe(0);
    expect(count('event_sources', 'event_id = ?', [eventId])).toBe(0);
    expect(count('event_history', 'event_id = ?', [eventId])).toBe(0);

    // 群还在
    expect(count('groups', 'group_id = ?', ['g1'])).toBe(1);
    const groups = (await getJson(app, '/api/groups')).body as GroupDTO[];
    expect(groups.find((g) => g.group_id === 'g1')).toMatchObject({
      message_count: 0,
      event_count: 0,
    });
  });

  it('别的群的数据一条都不能少', async () => {
    const app = freshApp();
    seed();

    await deleteJson(app, '/api/groups/g1/data');

    expect(count('messages', 'group_id = ?', ['g2'])).toBe(1);
    expect(count('events', 'group_id = ?', ['g2'])).toBe(1);
    expect(count('groups')).toBe(2);
  });

  it('删完后 /api/today、/api/events、导出都没了该群的内容', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const eventId = addEvent('g1', '高数小测'); // start_at 是 now，算今天
    expect(eventId).toBeGreaterThan(0);

    await deleteJson(app, '/api/groups/g1/data');

    const today = (await getJson(app, '/api/today')).body as { events: unknown[] };
    expect(today.events).toEqual([]);
    expect((await getJson(app, '/api/events')).body).toEqual([]);
    expect(await (await app.request('/api/export.ics')).text()).not.toContain('BEGIN:VEVENT');
  });

  it('群不存在 → 404', async () => {
    const app = freshApp();
    expect(await deleteJson(app, '/api/groups/nope/data')).toMatchObject({ status: 404 });
  });

  it('重复删第二次仍然是 200（幂等，只是没数据可删）', async () => {
    const app = freshApp();
    seed();
    expect((await deleteJson(app, '/api/groups/g1/data')).status).toBe(200);
    expect((await deleteJson(app, '/api/groups/g1/data')).status).toBe(200);
  });
});
