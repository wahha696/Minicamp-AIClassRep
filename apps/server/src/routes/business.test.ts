// B3 验收：/api/today、/api/events、/api/events/:id、PATCH /api/events/:id
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { db, openDb } from '../db/index.js';
import { registerBusinessRoutes } from './business.js';
import type { EventDetailDTO, EventDTO, TodayDTO } from '../types.js';

// ===== 测试脚手架

function makeApp(): Hono {
  const app = new Hono();
  registerBusinessRoutes(app);
  return app;
}

function freshApp(): Hono {
  openDb(':memory:');
  return makeApp();
}

function addGroup(group_id: string, name: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)',
  ).run(group_id, name, 'demo', Date.now());
}

function addEvent(
  opts: {
    group_id?: string;
    type?: string;
    title?: string;
    start_at?: number | null;
    end_at?: number | null;
    deadline_at?: number | null;
    status?: string;
  } = {},
): number {
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO events (group_id, type, title, description, start_at, end_at, deadline_at, status, confidence, version, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, 0.9, 1, ?, ?)`,
    )
    .run(
      opts.group_id ?? 'g1',
      opts.type ?? 'exam',
      opts.title ?? '高数小测',
      opts.start_at ?? null,
      opts.end_at ?? null,
      opts.deadline_at ?? null,
      opts.status ?? 'active',
      now,
      now,
    );
  return Number(res.lastInsertRowid);
}

/** 上海时间某天某刻的毫秒时间戳 */
function shTime(date: string, hhmm: string): number {
  return Date.parse(`${date}T${hhmm}:00+08:00`);
}

function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function nextDay(date: string): string {
  return shiftDay(date, 1);
}

function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
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

// ===== /api/today

describe('GET /api/today', () => {
  it('只返回落在上海时间今天的事件，并按时间升序', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    const tomorrow = nextDay(today);
    const yesterday = shiftDay(today, -1);

    addGroup('g1', '高数(2)班');
    addEvent({ title: '下午的小测', start_at: shTime(today, '14:00') });
    addEvent({ title: '早上的班会', type: 'meeting', start_at: shTime(today, '09:00') });
    addEvent({ title: '明天的活动', start_at: shTime(tomorrow, '10:00') });
    addEvent({ title: '昨天的事', start_at: shTime(yesterday, '10:00') });

    const { status, body } = await getJson(app, '/api/today');
    expect(status).toBe(200);
    const today_body = body as TodayDTO;
    expect(today_body.date).toBe(today);
    expect(today_body.events.map((e) => e.title)).toEqual(['早上的班会', '下午的小测']);
    expect(today_body.events.every((e) => e.group_name === '高数(2)班')).toBe(true);
  });

  it('没有 start_at 时按 deadline_at 落到今天', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '物理实验');
    addEvent({ title: '交实验报告', type: 'assignment', deadline_at: shTime(today, '23:00') });

    const { body } = await getJson(app, '/api/today');
    expect((body as TodayDTO).events.map((e) => e.title)).toEqual(['交实验报告']);
  });

  it('cancelled 的不出现', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '已取消的小测', start_at: shTime(today, '14:00'), status: 'cancelled' });
    addEvent({ title: '正常的小测', start_at: shTime(today, '15:00') });

    const { body } = await getJson(app, '/api/today');
    expect((body as TodayDTO).events.map((e) => e.title)).toEqual(['正常的小测']);
  });

  it('两个时间都为空的事件不算今天的事', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '没有时间的事' });

    const { body } = await getJson(app, '/api/today');
    expect((body as TodayDTO).events).toEqual([]);
    expect((body as TodayDTO).summary).toBe('今天没有待办，轻松一天');
  });

  it('摘要：无事件时是固定文案', async () => {
    const app = freshApp();
    const { body } = await getJson(app, '/api/today');
    expect((body as TodayDTO).summary).toBe('今天没有待办，轻松一天');
    expect((body as TodayDTO).events).toEqual([]);
  });

  it('摘要：最急的是「排序时间 ≥ 现在」的第一个', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    const now = Date.now();
    addGroup('g1', '高数(2)班');
    // 两件都在今天，但都已经过去 → 回落到第一个
    addEvent({ title: '上午已过的事', type: 'meeting', start_at: shTime(today, '01:00') });
    addEvent({ title: '凌晨已过的事', type: 'meeting', start_at: shTime(today, '00:30') });

    const { body } = await getJson(app, '/api/today');
    const b = body as TodayDTO;
    expect(b.events).toHaveLength(2);
    if (now < shTime(today, '23:59')) {
      // 正常情况：两件都已过去 → 第一个（00:30 那件）
      expect(b.summary).toBe('今天 2 件事，最急的是 00:30 凌晨已过的事');
    }
  });

  it('摘要：未来那件优先于已过去的那件', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '已过去的事', start_at: shTime(today, '00:10') });
    addEvent({ title: '稍后的事', start_at: Date.now() + 3600_000 });

    const { body } = await getJson(app, '/api/today');
    const b = body as TodayDTO;
    expect(b.events.map((e) => e.title)).toEqual(['已过去的事', '稍后的事']);
    expect(b.summary).toBe(
      `今天 2 件事，最急的是 ${new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(Date.now() + 3600_000))} 稍后的事`,
    );
  });

  it('今天 0 点整的事件算今天，次日 0 点整的不算', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    const tomorrow = nextDay(today);
    addGroup('g1', '高数(2)班');
    addEvent({ title: '零点整', start_at: shTime(today, '00:00') });
    addEvent({ title: '次日零点整', start_at: shTime(tomorrow, '00:00') });

    const { body } = await getJson(app, '/api/today');
    expect((body as TodayDTO).events.map((e) => e.title)).toEqual(['零点整']);
  });
});

// ===== /api/events

describe('GET /api/events', () => {
  it('不给 from/to 时返回全部非 cancelled（含无时间的）', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '有时间的', start_at: shTime(today, '14:00') });
    addEvent({ title: '没时间的' });
    addEvent({ title: '取消的', start_at: shTime(today, '15:00'), status: 'cancelled' });

    const { status, body } = await getJson(app, '/api/events');
    expect(status).toBe(200);
    const events = body as EventDTO[];
    expect(events.map((e) => e.title)).toEqual(['有时间的', '没时间的']);
    expect(events[0]).toHaveProperty('group_name', '高数(2)班');
  });

  it('给了 from/to 就只返回落在区间内的（无时间的排除）', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '区间内', start_at: shTime(today, '14:00') });
    addEvent({ title: '区间外', start_at: shTime(today, '20:00') });
    addEvent({ title: '没时间的' });

    const from = shTime(today, '00:00');
    const to = shTime(today, '18:00');
    const { body } = await getJson(app, `/api/events?from=${from}&to=${to}`);
    expect((body as EventDTO[]).map((e) => e.title)).toEqual(['区间内']);
  });

  it('deadline_at 落在区间内也算（排序时间 = start_at ?? deadline_at）', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '物理实验');
    addEvent({ title: '交报告', type: 'assignment', deadline_at: shTime(today, '23:00') });

    const from = shTime(today, '00:00');
    const to = shTime(today, '23:30');
    const { body } = await getJson(app, `/api/events?from=${from}&to=${to}`);
    expect((body as EventDTO[]).map((e) => e.title)).toEqual(['交报告']);
  });

  it('区间是左闭右开：to 那一刻的事件不算', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '正好在 to 上', start_at: shTime(today, '18:00') });

    const from = shTime(today, '00:00');
    const to = shTime(today, '18:00');
    const { body } = await getJson(app, `/api/events?from=${from}&to=${to}`);
    expect(body as EventDTO[]).toEqual([]);
  });

  it('只给一个参数 → 400', async () => {
    const app = freshApp();
    const { status, body } = await getJson(app, '/api/events?from=1000');
    expect(status).toBe(400);
    expect(body).toHaveProperty('error');
  });

  it('from/to 不是数字 → 400；to <= from → 400', async () => {
    const app = freshApp();
    expect((await getJson(app, '/api/events?from=abc&to=123')).status).toBe(400);
    expect((await getJson(app, '/api/events?from=2000&to=1000')).status).toBe(400);
  });

  it('排序：按排序时间升序，无时间的排最后', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '晚的', start_at: shTime(today, '20:00') });
    addEvent({ title: '没时间的' });
    addEvent({ title: '早的', start_at: shTime(today, '08:00') });

    const { body } = await getJson(app, '/api/events');
    expect((body as EventDTO[]).map((e) => e.title)).toEqual(['早的', '晚的', '没时间的']);
  });
});

// ===== /api/events/:id

describe('GET /api/events/:id', () => {
  it('返回完整 DTO + sources（按时间升序）+ history（按 version 升序）', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    const id = addEvent({
      title: '高数小测',
      start_at: shTime(today, '14:00'),
      end_at: shTime(today, '15:00'),
    });
    db.prepare(
      'INSERT INTO event_sources (event_id, message_id, sender_name, text, sent_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, 'm2', '班长', '小测改到周五下午两点', shTime(today, '10:00'));
    db.prepare(
      'INSERT INTO event_sources (event_id, message_id, sender_name, text, sent_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, 'm1', '张老师', '@全体成员 明天下午两点随堂小测', shTime(today, '09:00'));
    const insHistory = db.prepare(
      'INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at) VALUES (?, ?, ?, ?, ?)',
    );
    insHistory.run(id, 2, JSON.stringify({ start_at: { from: 1, to: 2 } }), 'm2', Date.now());
    insHistory.run(id, 1, JSON.stringify({ location: { from: null, to: 'A301' } }), 'm1', Date.now());

    const { status, body } = await getJson(app, `/api/events/${id}`);
    expect(status).toBe(200);
    const detail = body as EventDetailDTO;
    expect(detail.id).toBe(id);
    expect(detail.group_name).toBe('高数(2)班');
    expect(detail.type).toBe('exam');
    expect(detail.status).toBe('active');
    expect(detail.version).toBe(1);
    expect(detail.sources.map((s) => s.message_id)).toEqual(['m1', 'm2']);
    expect(detail.sources[0]).toMatchObject({ sender_name: '张老师', text: '@全体成员 明天下午两点随堂小测' });
    expect(detail.history.map((h) => h.version)).toEqual([1, 2]);
    expect(detail.history[1]!.changed_fields).toEqual({ start_at: { from: 1, to: 2 } });
  });

  it('没有来源和变更记录时返回空数组', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '孤单的事件' });
    const { body } = await getJson(app, `/api/events/${id}`);
    const detail = body as EventDetailDTO;
    expect(detail.sources).toEqual([]);
    expect(detail.history).toEqual([]);
  });

  it('id 不存在 → 404；id 不合法 → 400', async () => {
    const app = freshApp();
    expect((await getJson(app, '/api/events/9999')).status).toBe(404);
    expect((await getJson(app, '/api/events/abc')).status).toBe(400);
    expect((await getJson(app, '/api/events/0')).status).toBe(400);
  });

  it('changed_fields 是坏 JSON 时不让详情接口挂掉', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '高数小测' });
    db.prepare(
      'INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at) VALUES (?, 1, ?, NULL, ?)',
    ).run(id, '{不是 JSON', Date.now());

    const { status, body } = await getJson(app, `/api/events/${id}`);
    expect(status).toBe(200);
    expect((body as EventDetailDTO).history[0]!.changed_fields).toEqual({});
  });
});

// ===== PATCH /api/events/:id

describe('PATCH /api/events/:id', () => {
  it('改成 done 并持久化，返回 EventDTO', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '高数小测', start_at: shTime(today, '14:00') });

    const { status, body } = await patchJson(app, `/api/events/${id}`, { status: 'done' });
    expect(status).toBe(200);
    const event = body as EventDTO;
    expect(event.status).toBe('done');
    expect(event.group_name).toBe('高数(2)班');
    expect(event.id).toBe(id);

    const row = db.prepare('SELECT status, updated_at FROM events WHERE id = ?').get(id) as {
      status: string;
      updated_at: number;
    };
    expect(row.status).toBe('done');
    expect(row.updated_at).toBeGreaterThanOrEqual(event.created_at);
  });

  it('改成 cancelled 后 /api/today 里就没了', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '高数小测', start_at: shTime(today, '14:00') });

    await patchJson(app, `/api/events/${id}`, { status: 'cancelled' });
    const { body } = await getJson(app, '/api/today');
    expect((body as TodayDTO).events).toEqual([]);
  });

  it('四种合法状态都接受', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    for (const status of ['active', 'cancelled', 'done', 'pending_confirm']) {
      const id = addEvent({ title: `事件-${status}` });
      const res = await patchJson(app, `/api/events/${id}`, { status });
      expect(res.status).toBe(200);
      expect((res.body as EventDTO).status).toBe(status);
    }
  });

  it('非法状态 → 400 且不改库', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '高数小测' });

    for (const payload of [{ status: 'finished' }, { status: 123 }, {}, { other: 'done' }, null]) {
      const res = await patchJson(app, `/api/events/${id}`, payload);
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    }
    const row = db.prepare('SELECT status FROM events WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('active');
  });

  it('请求体不是 JSON → 400；id 不存在 → 404', async () => {
    const app = freshApp();
    const bad = await app.request('/api/events/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{不是 JSON',
    });
    expect(bad.status).toBe(400);
    expect(await patchJson(app, '/api/events/9999', { status: 'done' })).toMatchObject({
      status: 404,
    });
  });
});
