// B3 验收：/api/today、/api/events、/api/events/:id、PATCH /api/events/:id
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { registerBusinessRoutes } from './business.js';
import type { EventDetailDTO, EventDTO, TodayDTO } from '../types.js';

// ===== 固定时钟：「现在」钉在上海时间某天 12:00，结果不随跑测试的时刻变化
// （否则 00:10 前 / 23:00 后跑，「未来那件」会落到明天，摘要断言就会挂）
const FIXED_NOW = Date.parse('2026-09-23T12:00:00+08:00');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: FIXED_NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

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
    location?: string | null;
  } = {},
): number {
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO events (group_id, type, title, description, start_at, end_at, deadline_at, location, status, confidence, version, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 0.9, 1, ?, ?)`,
    )
    .run(
      opts.group_id ?? 'g1',
      opts.type ?? 'exam',
      opts.title ?? '高数小测',
      opts.start_at ?? null,
      opts.end_at ?? null,
      opts.deadline_at ?? null,
      opts.location ?? null,
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
    addGroup('g1', '高数(2)班');
    // 两件都在今天，但都已经过去 → 回落到第一个
    addEvent({ title: '上午已过的事', type: 'meeting', start_at: shTime(today, '01:00') });
    addEvent({ title: '凌晨已过的事', type: 'meeting', start_at: shTime(today, '00:30') });

    const { body } = await getJson(app, '/api/today');
    const b = body as TodayDTO;
    expect(b.events).toHaveLength(2);
    // 两件都已过去（现在是 12:00）→ 回落到第一个（00:30 那件）
    expect(b.summary).toBe('今天 2 件事，最急的是 00:30 凌晨已过的事');
  });

  it('摘要：未来那件优先于已过去的那件', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '已过去的事', start_at: shTime(today, '00:10') });
    addEvent({ title: '稍后的事', start_at: shTime(today, '14:00') });

    const { body } = await getJson(app, '/api/today');
    const b = body as TodayDTO;
    expect(b.events.map((e) => e.title)).toEqual(['已过去的事', '稍后的事']);
    expect(b.summary).toBe('今天 2 件事，最急的是 14:00 稍后的事');
  });

  it('跨时区边界：上海 00:30（UTC 还是前一天）时「今天」按上海算', async () => {
    vi.setSystemTime(Date.parse('2026-09-23T00:30:00+08:00'));
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '上海今天', start_at: Date.parse('2026-09-23T09:00:00+08:00') });
    addEvent({ title: '上海昨天', start_at: Date.parse('2026-09-22T23:00:00+08:00') });

    const { body } = await getJson(app, '/api/today');
    const b = body as TodayDTO;
    expect(b.date).toBe('2026-09-23');
    expect(b.events.map((e) => e.title)).toEqual(['上海今天']);
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
  it('不给 from/to 时返回全部非 cancelled，待办类事件（无时间的）进 /api/todos 不进这里', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '有时间的', start_at: shTime(today, '14:00') });
    addEvent({ title: '没时间的' }); // 待办
    addEvent({ title: '取消的', start_at: shTime(today, '15:00'), status: 'cancelled' });

    const { status, body } = await getJson(app, '/api/events');
    expect(status).toBe(200);
    const events = body as EventDTO[];
    expect(events.map((e) => e.title)).toEqual(['有时间的']);
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

  it('只给一个参数 = 那一侧不设限（无时间的仍排除）', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '早的', start_at: shTime(today, '08:00') });
    addEvent({ title: '晚的', start_at: shTime(today, '20:00') });
    addEvent({ title: '没时间的' });

    const mid = shTime(today, '12:00');
    const onlyFrom = await getJson(app, `/api/events?from=${mid}`);
    expect(onlyFrom.status).toBe(200);
    expect((onlyFrom.body as EventDTO[]).map((e) => e.title)).toEqual(['晚的']);
    const onlyTo = await getJson(app, `/api/events?to=${mid}`);
    expect((onlyTo.body as EventDTO[]).map((e) => e.title)).toEqual(['早的']);
  });

  it('from/to 不是数字 → 400；to <= from → 400', async () => {
    const app = freshApp();
    expect((await getJson(app, '/api/events?from=abc&to=123')).status).toBe(400);
    expect((await getJson(app, '/api/events?from=2000&to=1000')).status).toBe(400);
  });

  it('排序：按排序时间升序；无时间的待办事件不进列表', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '晚的', start_at: shTime(today, '20:00') });
    addEvent({ title: '没时间的' }); // 待办 → 去 /api/todos
    addEvent({ title: '早的', start_at: shTime(today, '08:00') });

    const { body } = await getJson(app, '/api/events');
    expect((body as EventDTO[]).map((e) => e.title)).toEqual(['早的', '晚的']);
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

  it('手动设级：level+locked+version+history，记一条 level_feedback（ai_level=调整前的值）', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '大物实验报告' }); // 默认 level=2, unlocked

    const { status, body } = await patchJson(app, `/api/events/${id}`, { level: 4 });
    expect(status).toBe(200);
    const event = body as EventDetailDTO;
    expect(event.level).toBe(4);
    expect(event.level_locked).toBe(true);
    expect(event.version).toBe(2);
    const levelChange = event.history.at(-1)?.changed_fields['level'] as { from: number; to: number };
    expect(levelChange).toEqual({ from: 2, to: 4 });

    const fb = db
      .prepare('SELECT ai_level, user_level, title, group_name, type FROM level_feedback WHERE event_id = ?')
      .get(id) as Record<string, unknown>;
    expect(fb).toMatchObject({ ai_level: 2, user_level: 4, title: '大物实验报告', group_name: '高数(2)班', type: 'exam' });
  });

  it('设成原等级：只锁不升版本、不写 level history，但照样记 feedback', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '保持原级' });
    const { body } = await patchJson(app, `/api/events/${id}`, { level: 2 });
    const event = body as EventDetailDTO;
    expect(event.level).toBe(2);
    expect(event.level_locked).toBe(true);
    expect(event.version).toBe(1);
    expect((db.prepare('SELECT COUNT(*) n FROM level_feedback WHERE event_id = ?').get(id) as { n: number }).n).toBe(1);
  });

  it('已锁定再调级：feedback 的 ai_level 沿用上一条的（不是上一次用户值）', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '大物实验报告' }); // AI 原级 2
    await patchJson(app, `/api/events/${id}`, { level: 4 });
    await patchJson(app, `/api/events/${id}`, { level: 3 });
    const fb = db
      .prepare('SELECT ai_level, user_level FROM level_feedback WHERE event_id = ? ORDER BY id')
      .all(id) as { ai_level: number; user_level: number }[];
    expect(fb.map((f) => [f.ai_level, f.user_level])).toEqual([[2, 4], [2, 3]]);
  });

  it('level:null 解锁交还 AI：locked=0、level 不变、不再写 feedback', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '高数小测' });
    await patchJson(app, `/api/events/${id}`, { level: 4 });
    const { status, body } = await patchJson(app, `/api/events/${id}`, { level: null });
    expect(status).toBe(200);
    const event = body as EventDTO;
    expect(event.level).toBe(4); // 交还后保留当前值，等 AI 下次覆盖
    expect(event.level_locked).toBe(false);
    expect((db.prepare('SELECT COUNT(*) n FROM level_feedback WHERE event_id = ?').get(id) as { n: number }).n).toBe(1);
  });

  it('level 越界 / 非整数 / 非数字 → 400', async () => {
    const app = freshApp();
    const id = addEvent({ title: '高数小测' });
    for (const payload of [{ level: 0 }, { level: 5 }, { level: 2.5 }, { level: '高' }]) {
      expect((await patchJson(app, `/api/events/${id}`, payload)).status).toBe(400);
    }
    const row = db.prepare('SELECT level, level_locked FROM events WHERE id = ?').get(id) as {
      level: number;
      level_locked: number;
    };
    expect(row).toEqual({ level: 2, level_locked: 0 });
  });

  it('status + level 一起 PATCH 都生效', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '高数小测' });
    const { status, body } = await patchJson(app, `/api/events/${id}`, { status: 'done', level: 1 });
    expect(status).toBe(200);
    expect(body as EventDTO).toMatchObject({ status: 'done', level: 1, level_locked: true });
  });
});

// ===== 导出 .ics（B4）

describe('GET /api/export.ics', () => {
  it('返回 text/calendar + attachment 文件名，正文是合法日历', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '高数小测', start_at: shTime(today, '14:00'), location: 'A301' });

    const res = await app.request('/api/export.ics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="classrep.ics"');

    const text = await res.text();
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('TZID:Asia/Shanghai');
    expect(text).toContain('SUMMARY:[考试]高数小测');
    expect(text).toContain('LOCATION:A301');
  });

  it('from/to 过滤与 /api/events 一致', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '区间内', start_at: shTime(today, '14:00') });
    addEvent({ title: '区间外', start_at: shTime(today, '20:00') });

    const from = shTime(today, '00:00');
    const to = shTime(today, '18:00');
    const res = await app.request(`/api/export.ics?from=${from}&to=${to}`);
    const text = await res.text();
    expect(text).toContain('SUMMARY:[考试]区间内');
    expect(text).not.toContain('区间外');
  });

  it('cancelled 的不导出；区间里没有可导出的 → 200 空日历（不是 404）', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    addEvent({ title: '已取消', start_at: shTime(today, '14:00'), status: 'cancelled' });
    addEvent({ title: '没时间的' });

    const res = await app.request('/api/export.ics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).not.toContain('BEGIN:VEVENT');
  });

  it('from/to 不是数字 → 400', async () => {
    const app = freshApp();
    expect((await app.request('/api/export.ics?from=abc')).status).toBe(400);
  });
});

describe('GET /api/events/:id/export.ics', () => {
  it('只导出这一条', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '要导出的', start_at: shTime(today, '14:00') });
    addEvent({ title: '不要的', start_at: shTime(today, '15:00') });

    const res = await app.request(`/api/events/${id}/export.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const text = await res.text();
    expect(text).toContain('UID:classrep-' + id + '@local');
    expect(text).toContain('SUMMARY:[考试]要导出的');
    expect(text).not.toContain('不要的');
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('这条没有时间 → 404；id 不合法 → 400；不存在 → 404', async () => {
    const app = freshApp();
    addGroup('g1', '高数(2)班');
    const noTime = addEvent({ title: '没时间的' });
    const noTimeRes = await app.request(`/api/events/${noTime}/export.ics`);
    expect(noTimeRes.status).toBe(404);
    expect(await noTimeRes.json()).toHaveProperty('error');
    expect((await app.request('/api/events/abc/export.ics')).status).toBe(400);
    expect((await app.request('/api/events/9999/export.ics')).status).toBe(404);
  });

  it('这条没被 :id 详情路由抢走（路由顺序）', async () => {
    const app = freshApp();
    const today = shanghaiToday();
    addGroup('g1', '高数(2)班');
    const id = addEvent({ title: '高数小测', start_at: shTime(today, '14:00') });

    const ics = await app.request(`/api/events/${id}/export.ics`);
    expect(ics.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    // 详情接口仍是 JSON
    const detail = await app.request(`/api/events/${id}`);
    expect(detail.headers.get('content-type')).toContain('application/json');
  });
});
