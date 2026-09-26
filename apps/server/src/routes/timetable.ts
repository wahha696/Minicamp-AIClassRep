// 课表接口（FR-13）：导入（整表替换）/ 查看 / 清空。解析在浏览器端做（见 web/lib/timetable.ts），
// 后端只存结果。
import type { Hono } from 'hono';
import { z } from 'zod';
import { clearTimetable, getTimetable, saveTimetable } from '../timetable.js';
import type { TimetableDTO } from '../types.js';

const TZ = 8 * 3600_000;

const courseSchema = z.object({
  name: z.string().trim().min(1).max(60),
  teacher: z.string().trim().max(100).default(''),
  location: z.string().trim().max(60).default(''),
  weekday: z.number().int().min(1).max(7),
  block: z.number().int().min(1).max(5),
  weeks: z.array(z.number().int().min(1).max(30)).min(1).max(30),
});

const timetableSchema = z.object({
  semester_start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
    .refine((s) => {
      const t = Date.parse(`${s}T00:00:00+08:00`);
      // 必须是周一（上海时间）
      return Number.isFinite(t) && new Date(t + TZ).getUTCDay() === 1;
    }, '第一周必须是周一'),
  courses: z.array(courseSchema).max(200),
});

export function registerTimetableRoutes(app: Hono): void {
  // 未导入时 courses: []（semester_start 仍是默认/上次值）
  app.get('/api/timetable', (c) => c.json(getTimetable()));

  app.put('/api/timetable', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = timetableSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: `课表数据不合法：${parsed.error.issues[0]?.message ?? ''}` }, 400);
    }
    saveTimetable(parsed.data as TimetableDTO);
    return c.json(getTimetable());
  });

  app.delete('/api/timetable', (c) => {
    clearTimetable();
    return c.json({ ok: true });
  });
}
