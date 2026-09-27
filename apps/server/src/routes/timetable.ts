// 课表接口（FR-13）：导入（整表替换）/ 查看 / 清空。解析在浏览器端做（见 web/lib/timetable.ts），
// 后端只存结果。另有 csujwc 直连导入：服务端模拟登录教务网拉课表（见 csujwc.ts）。
import type { Hono } from 'hono';
import { z } from 'zod';
import { csuBeginImport, csuFetchCourses, CsuError } from '../csujwc.js';
import { clearTimetable, getTimetable, saveTimetable } from '../timetable.js';
import type { TimetableDTO } from '../types.js';

const TZ = 8 * 3600_000;

const courseSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    teacher: z.string().trim().max(100).default(''),
    location: z.string().trim().max(60).default(''),
    weekday: z.number().int().min(1).max(7),
    start: z.number().int().min(1).max(12),
    end: z.number().int().min(1).max(12),
    weeks: z.array(z.number().int().min(1).max(30)).min(1).max(30),
  })
  .refine((c) => c.end >= c.start, { message: '结束节次不能小于开始节次' });

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

  // ── 中南教务系统(csujwc)直连导入 ──
  // 两步:① start(学号+密码)→ 返回验证码图片;② fetch(验证码)→ 课次列表(不落库,走预览确认)。
  // 学号/密码只在服务端内存里存活到本次导入完成;写接口本来就仅限 loopback(lan-guard)。
  const csuStartSchema = z.object({
    user: z.string().trim().regex(/^\d{4,20}$/, '学号应为数字'),
    password: z.string().min(1).max(64),
  });
  const csuFetchSchema = z.object({
    session_id: z.string().trim().min(8).max(64),
    // CAS 连续失败后才要求验证码(最长 10 位);不需要时前端传空串
    captcha: z.string().trim().regex(/^[0-9a-zA-Z]{0,10}$/, '验证码格式不对').default(''),
  });

  app.post('/api/timetable/csu/start', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = csuStartSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? '参数不合法' }, 400);
    }
    try {
      return c.json(await csuBeginImport(parsed.data.user, parsed.data.password));
    } catch (e) {
      const message = e instanceof Error ? e.message : '连接教务系统失败';
      return c.json({ error: message }, 502);
    }
  });

  app.post('/api/timetable/csu/fetch', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = csuFetchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? '参数不合法' }, 400);
    }
    try {
      const { courses, warnings } = await csuFetchCourses(parsed.data.session_id, parsed.data.captcha);
      return c.json({ courses, warnings });
    } catch (e) {
      const status = e instanceof CsuError ? 502 : 500;
      const message = e instanceof Error ? e.message : '教务系统导入失败';
      return c.json({ error: message }, status);
    }
  });
}
