// FR-13 验收：GET / PUT / DELETE /api/timetable。semester_start 必须是周一。
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../db/index.js';
import type { TimetableDTO } from '../types.js';
import { registerTimetableRoutes } from './timetable.js';

const COURSE = {
  name: '概率论与数理统计A',
  teacher: '彭丽华(副教授)',
  location: 'B座312',
  weekday: 2,
  block: 2,
  weeks: [3, 4, 5, 6],
};

function makeApp(): Hono {
  const app = new Hono();
  registerTimetableRoutes(app);
  return app;
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
  db.exec('DELETE FROM courses;');
  db.exec("DELETE FROM timetable_versions; DELETE FROM kv WHERE key='timetable_config'");
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('semester_start', '2026-09-07')").run();
});

describe('GET /api/timetable', () => {
  it('未导入时 courses 是空数组，semester_start 有默认值', async () => {
    const res = await req(makeApp(), 'GET', '/api/timetable');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ semester_start: '2026-09-07', courses: [], revision:0 });
  });
});

describe('PUT /api/timetable', () => {
  it('保存后 GET 回读一致；再 PUT 整表替换', async () => {
    const app = makeApp();
    const res = await req(app, 'PUT', '/api/timetable', {
      semester_start: '2026-09-07',
      courses: [COURSE],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimetableDTO;
    expect(body.courses).toHaveLength(1);
    expect(body.courses[0]).toMatchObject({ name: '概率论与数理统计A', weekday: 2, block: 2, weeks: [3, 4, 5, 6] });

    const res2 = await req(app, 'PUT', '/api/timetable', {
      semester_start: '2027-02-22', // 周一
      courses: [{ ...COURSE, name: '体育' }],
    });
    const body2 = (await res2.json()) as TimetableDTO;
    expect(body2.semester_start).toBe('2027-02-22');
    expect(body2.courses.map((c) => c.name)).toEqual(['体育']);
  });

  it('semester_start 不是周一 / 格式不对 → 400；课程字段非法 → 400', async () => {
    const app = makeApp();
    const cases = [
      { semester_start: '2026-09-08', courses: [] }, // 周二
      { semester_start: '2026/09/07', courses: [] },
      { semester_start: '2026-09-07', courses: [{ ...COURSE, weekday: 8 }] },
      { semester_start: '2026-09-07', courses: [{ ...COURSE, block: 0 }] },
      { semester_start: '2026-09-07', courses: [{ ...COURSE, weeks: [] }] },
      { semester_start: '2026-09-07', courses: [{ ...COURSE, name: '' }] },
    ];
    for (const bad of cases) {
      expect((await req(app, 'PUT', '/api/timetable', bad)).status).toBe(400);
    }
    expect((await req(app, 'PUT', '/api/timetable')).status).toBe(400);
    // 校验失败不动已有数据
    expect((await (await req(app, 'GET', '/api/timetable')).json() as TimetableDTO).courses).toHaveLength(0);
  });
});

describe('DELETE /api/timetable', () => {
  it('清空课程，semester_start 保留', async () => {
    const app = makeApp();
    await req(app, 'PUT', '/api/timetable', { semester_start: '2026-09-07', courses: [COURSE] });
    const res = await req(app, 'DELETE', '/api/timetable');
    expect(res.status).toBe(200);
    const body = (await (await req(app, 'GET', '/api/timetable')).json()) as TimetableDTO;
    expect(body.courses).toEqual([]);
    expect(body.semester_start).toBe('2026-09-07');
  });
});
