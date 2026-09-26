// FR-12 验收：/api/settings/memory 开关、规则逐条删（对应调级记录标 ignored）、清空。
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../db/index.js';
import type { MemoryDTO } from '../types.js';
import { registerMemoryRoutes } from './memory.js';

function makeApp(): Hono {
  const app = new Hono();
  registerMemoryRoutes(app);
  return app;
}

const req = (app: Hono, method: string, path: string, payload?: unknown) =>
  app.request(path, {
    method,
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

function addFeedback(): number {
  const res = db
    .prepare(
      "INSERT INTO level_feedback (event_id, group_name, type, title, ai_level, user_level, ignored, created_at) VALUES (1, '软工A班', 'assignment', '大物实验报告', 2, 4, 0, ?)",
    )
    .run(Date.now());
  return Number(res.lastInsertRowid);
}

function addRule(feedbackIds: number[]): number {
  const res = db
    .prepare(
      "INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES ('实验报告一律紧急', 4, ?, ?)",
    )
    .run(JSON.stringify(feedbackIds), Date.now());
  return Number(res.lastInsertRowid);
}

beforeAll(() => openDb(':memory:'));
afterAll(() => db.close());
beforeEach(() => {
  db.exec("DELETE FROM level_feedback; DELETE FROM level_rules; INSERT OR REPLACE INTO kv (key, value) VALUES ('memory_enabled', '1');");
});

describe('GET /api/settings/memory', () => {
  it('返回 enabled + rules + feedback_count', async () => {
    const fid = addFeedback();
    addRule([fid]);
    const res = await req(makeApp(), 'GET', '/api/settings/memory');
    const body = (await res.json()) as MemoryDTO;
    expect(body.enabled).toBe(true);
    expect(body.feedback_count).toBe(1);
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]).toMatchObject({ text: '实验报告一律紧急', level: 4 });
  });
});

describe('PUT /api/settings/memory', () => {
  it('关 → enabled=false；再开还原；非布尔 → 400', async () => {
    const app = makeApp();
    const off = (await (await req(app, 'PUT', '/api/settings/memory', { enabled: false })).json()) as MemoryDTO;
    expect(off.enabled).toBe(false);
    const on = (await (await req(app, 'PUT', '/api/settings/memory', { enabled: true })).json()) as MemoryDTO;
    expect(on.enabled).toBe(true);
    expect((await req(app, 'PUT', '/api/settings/memory', { enabled: 'yes' })).status).toBe(400);
    expect((await req(app, 'PUT', '/api/settings/memory', {})).status).toBe(400);
  });
});

describe('DELETE /api/settings/memory/rules/:id', () => {
  it('删规则并把对应调级记录标 ignored=1', async () => {
    const fid = addFeedback();
    const rid = addRule([fid]);
    const res = await req(makeApp(), 'DELETE', `/api/settings/memory/rules/${rid}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemoryDTO;
    expect(body.rules).toHaveLength(0);
    const fb = db.prepare('SELECT ignored FROM level_feedback WHERE id = ?').get(fid) as { ignored: number };
    expect(fb.ignored).toBe(1);
  });

  it('规则不存在 → 404；id 不合法 → 400', async () => {
    const app = makeApp();
    expect((await req(app, 'DELETE', '/api/settings/memory/rules/999')).status).toBe(404);
    expect((await req(app, 'DELETE', '/api/settings/memory/rules/abc')).status).toBe(400);
  });
});

describe('DELETE /api/settings/memory', () => {
  it('规则与调级记录一起清空', async () => {
    const fid = addFeedback();
    addRule([fid]);
    const res = await req(makeApp(), 'DELETE', '/api/settings/memory');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MemoryDTO;
    expect(body.rules).toHaveLength(0);
    expect(body.feedback_count).toBe(0);
  });
});
