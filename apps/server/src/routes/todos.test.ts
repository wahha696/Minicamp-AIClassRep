// FR-15 验收：/api/todos 群待办 + 手动待办合并返回；POST/PATCH 手动待办；
// 补了截止的作业离开待办列表；取消/完成的自动消失。
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../db/index.js';
import type { TodoDTO, TodosDTO } from '../types.js';
import { registerTodoRoutes } from './todos.js';

const T = Date.parse('2026-09-27T14:00+08:00');

function makeApp(): Hono {
  const app = new Hono();
  registerTodoRoutes(app);
  return app;
}

function addEvent(over: {
  group_id?: string;
  type?: string;
  title?: string;
  start_at?: number | null;
  end_at?: number | null;
  deadline_at?: number | null;
  location?: string | null;
  status?: string;
  level?: number;
} = {}): number {
  const now = Date.now();
  const res = db
    .prepare(
      `INSERT INTO events (group_id, type, title, description, start_at, end_at, deadline_at, location, status, confidence, level, level_locked, version, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 0.9, ?, 0, 1, ?, ?)`,
    )
    .run(
      over.group_id ?? 'g1',
      over.type ?? 'exam',
      over.title ?? '事件',
      over.start_at ?? null,
      over.end_at ?? null,
      over.deadline_at ?? null,
      over.location ?? null,
      over.status ?? 'active',
      over.level ?? 2,
      now,
      now,
    );
  return Number(res.lastInsertRowid);
}

const req = (app: Hono, method: string, path: string, payload?: unknown) =>
  app.request(path, {
    method,
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

beforeAll(() => openDb(':memory:'));
afterAll(() => db.close());
beforeEach(() => {
  db.exec('DELETE FROM events; DELETE FROM todos;');
});

describe('GET /api/todos', () => {
  it('群待办（没时间 / 作业无截止）+ 未完成手动待办；按 level 降序', async () => {
    const app = makeApp();
    const noTime = addEvent({ title: '没时间的通知', type: 'announcement', level: 1 });
    const homework = addEvent({ title: '只有开始的作业', type: 'assignment', start_at: T, level: 4 });
    addEvent({ title: '有截止的作业', type: 'assignment', deadline_at: T }); // 不是待办
    addEvent({ title: '取消了的没时间事件', status: 'cancelled' }); // 不是待办
    db.prepare("INSERT INTO todos (title, note, level, done_at, created_at) VALUES ('手动1', '', 2, NULL, ?)").run(Date.now());
    db.prepare("INSERT INTO todos (title, note, level, done_at, created_at) VALUES ('已完成的', '', 2, ?, ?)").run(Date.now(), Date.now());

    const res = await req(app, 'GET', '/api/todos');
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodosDTO;
    expect(body.events.map((e) => e.id)).toEqual([homework, noTime]); // level 4 在前
    expect(body.manual.map((t) => t.title)).toEqual(['手动1']);
  });
});

describe('POST /api/todos', () => {
  it('建一条手动待办并回读', async () => {
    const app = makeApp();
    const res = await req(app, 'POST', '/api/todos', { title: '打印材料', note: 'A4 双面', level: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TodoDTO;
    expect(body).toMatchObject({ title: '打印材料', note: 'A4 双面', level: 3, done_at: null });

    const list = ((await (await req(app, 'GET', '/api/todos')).json()) as TodosDTO).manual;
    expect(list.map((t) => t.title)).toEqual(['打印材料']);
  });

  it('缺省 level=2；空标题 / 超长 / 非法等级 → 400', async () => {
    const app = makeApp();
    const ok = await req(app, 'POST', '/api/todos', { title: '默认值' });
    expect((await ok.json() as TodoDTO).level).toBe(2);
    for (const bad of [{ title: '' }, { title: 'x'.repeat(101) }, { title: 't', level: 0 }, { title: 't', level: 5 }]) {
      expect((await req(app, 'POST', '/api/todos', bad)).status).toBe(400);
    }
    expect((await req(app, 'POST', '/api/todos')).status).toBe(400); // 非 JSON 体
  });
});

describe('PATCH /api/todos/:id', () => {
  async function addManual(): Promise<number> {
    const res = db
      .prepare("INSERT INTO todos (title, note, level, done_at, created_at) VALUES ('待办', '', 2, NULL, ?)")
      .run(Date.now());
    return Number(res.lastInsertRowid);
  }

  it('done:true → 从待办列表消失；改标题/等级生效', async () => {
    const app = makeApp();
    const id = await addManual();
    const done = await req(app, 'PATCH', `/api/todos/${id}`, { done: true });
    expect((await done.json() as TodoDTO).done_at).not.toBeNull();
    const list = ((await (await req(app, 'GET', '/api/todos')).json()) as TodosDTO).manual;
    expect(list).toHaveLength(0);

    const id2 = await addManual();
    const upd = await req(app, 'PATCH', `/api/todos/${id2}`, { title: '改名', level: 4 });
    expect((await upd.json() as TodoDTO)).toMatchObject({ title: '改名', level: 4 });
  });

  it('空 PATCH / 全 undefined → 400；不存在 → 404；非法 id → 400', async () => {
    const app = makeApp();
    const id = await addManual();
    expect((await req(app, 'PATCH', `/api/todos/${id}`, {})).status).toBe(400);
    expect((await req(app, 'PATCH', '/api/todos/9999', { done: true })).status).toBe(404);
    expect((await req(app, 'PATCH', '/api/todos/abc', { done: true })).status).toBe(400);
  });
});
