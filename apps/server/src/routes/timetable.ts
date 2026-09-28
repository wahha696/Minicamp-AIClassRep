// 课表接口（FR-13）：导入（整表替换）/ 查看 / 清空。解析在浏览器端做（见 web/lib/timetable.ts），
// 后端只存结果。另有 csujwc 直连导入：服务端模拟登录教务网拉课表（见 csujwc.ts）。
import type { Hono } from 'hono';
import { z } from 'zod';
import { csuBeginImport, csuFetchCourses, CsuError } from '../csujwc.js';
import { clearTimetable, getTimetable, saveTimetable, timetableVersions } from '../timetable.js';
import {
  dateStamp,
  minutes,
  periods,
  ruleTimes,
  normalizeCourses,
  reconcileCourses,
  DEFAULT_BELLS,
  DAY,
  TZ as LOCAL_TZ,
  type TimetableSaveRequest,
} from '../../../../shared/timetable.js';

const TZ = 8 * 3600_000;

const courseSchema = z.object({
  id: z.string().min(1).max(160).optional(),
  course_id: z.string().min(1).max(160).optional(),
  name: z.string().trim().min(1).max(300),
  teacher: z.string().trim().max(100).default(''),
  location: z.string().trim().max(300).default(''),
  campus: z.string().max(100).optional(),
  class_name: z.string().max(100).optional(),
  weekday: z.number().int().min(1).max(7),
  block: z.number().int().min(1).max(12),
  start_period: z.number().int().min(1).max(24).optional(),
  end_period: z.number().int().min(1).max(24).optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  weeks: z.array(z.number().int().min(1).max(60)).min(1).max(60),
  source: z
    .object({
      sheet: z.string().max(200),
      row: z.number().int().min(1),
      column: z.number().int().min(1),
      raw: z.string().max(30000),
      item_id: z.string().max(160),
    })
    .optional(),
  user_modified: z.boolean().optional(),
});

const timetableSchema = z.object({
  semester_start: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
    .refine((s) => {
      const t = dateStamp(s);
      // 必须是周一（上海时间）
      return Number.isFinite(t) && new Date(t + TZ).getUTCDay() === 1;
    }, '第一周必须是周一'),
  courses: z.array(courseSchema).max(2000),
  term_name: z.string().max(100).optional(),
  school: z.string().max(100).optional(),
  campus: z.string().max(100).optional(),
  term_weeks: z.number().int().min(1).max(60).default(30),
  bells: z
    .array(z.object({ period: z.number().int().min(1).max(24), start: z.string(), end: z.string() }))
    .min(1)
    .max(24)
    .default(DEFAULT_BELLS),
  exceptions: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        rule_id: z.string().min(1).max(160),
        kind: z.enum(['cancel', 'move', 'add', 'keep']),
        original_date: z.string(),
        date: z.string().optional(),
        start_time: z.string().optional(),
        end_time: z.string().optional(),
        location: z.string().max(300).optional(),
        note: z.string().max(500).optional(),
      }),
    )
    .max(2000)
    .default([]),
  import_items: z
    .array(
      z.object({
        id: z.string().max(160),
        sheet: z.string().max(200),
        row: z.number().int().min(1),
        column: z.number().int().min(1),
        raw: z.string().max(30000),
        status: z.enum(['parsed', 'pending', 'ignored']),
        course_ids: z.array(z.string()).max(2000),
        message: z.string().max(1000).optional(),
      }),
    )
    .max(5000)
    .optional(),
  mode: z.enum(['merge', 'replace']).default('replace'),
  expected_revision: z.number().int().min(0).optional(),
  confirm_loss: z.boolean().default(false),
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
    const t = parsed.data as TimetableSaveRequest;
    const previous = getTimetable();
    if (t.mode === 'merge' && previous.courses.length > 0 && t.semester_start !== previous.semester_start)
      return c.json({ error: '不同学期起点不能直接合并，请核对校历并选择整表替换（保留恢复版本）' }, 409);
    if (t.expected_revision !== undefined && t.expected_revision !== previous.revision)
      return c.json({ error: '课表已更新，请重新载入后核对差异' }, 409);
    if (!t.courses.length) return c.json({ error: '空课表不能覆盖已有数据，请使用明确的清空操作' }, 400);
    if (t.import_items?.some((i) => i.status === 'pending'))
      return c.json({ error: '仍有待确认的原始内容，请逐项修正或明确忽略' }, 400);
    const courses = normalizeCourses(t.courses);
    const effective = reconcileCourses(previous.courses, courses, t.mode ?? 'replace').courses;
    const ids = new Set(courses.map((x) => x.id));
    if (ids.size !== courses.length) return c.json({ error: '课程规则 ID 重复' }, 400);
    if (
      t.import_items?.some(
        (i) =>
          i.course_ids.some((id) => !ids.has(id)) ||
          (i.status === 'parsed' && !i.course_ids.length) ||
          (i.status === 'ignored' && !i.message?.trim()),
      )
    )
      return c.json({ error: '导入对账不完整：课程身份或忽略理由缺失' }, 400);
    const bells = t.bells!;
    const sorted = [...bells].sort((a, b) => a.period - b.period);
    if (
      new Set(bells.map((b) => b.period)).size !== bells.length ||
      sorted.some(
        (b, i) =>
          !Number.isFinite(minutes(b.start)) ||
          !(minutes(b.end) > minutes(b.start)) ||
          (i > 0 && minutes(b.start) < minutes(sorted[i - 1]!.end)),
      )
    )
      return c.json({ error: '作息表节次重复、时间无效或相互重叠' }, 400);
    for (const course of effective) {
      const [a, b] = periods(course),
        [start, end] = ruleTimes(course, bells);
      if (
        a > b ||
        !bells.some((x) => x.period === a) ||
        !bells.some((x) => x.period === b) ||
        !Number.isFinite(minutes(start)) ||
        !(minutes(end) > minutes(start)) ||
        course.weeks.some((w) => w > (t.term_weeks ?? 30))
      )
        return c.json({ error: `「${course.name}」节次、实际时间或周次不在本学期配置内` }, 400);
    }
    const exceptionKeys = new Set<string>();
    for (const e of t.exceptions ?? []) {
      const rule = effective.find((x) => x.id === e.rule_id) ?? courses.find((x) => x.id === e.rule_id);
      const key = `${e.rule_id}:${e.original_date}`;
      const times = rule ? ruleTimes(rule, bells) : ['', ''];
      const start = e.start_time || times[0]!,
        end = e.end_time || times[1]!;
      if (
        !rule ||
        !Number.isFinite(dateStamp(e.original_date)) ||
        ((e.kind === 'move' || e.kind === 'add') && !Number.isFinite(dateStamp(e.date ?? ''))) ||
        !Number.isFinite(minutes(start)) ||
        !(minutes(end) > minutes(start)) ||
        exceptionKeys.has(key)
      )
        return c.json({ error: '调课/停课例外日期、时间或课程无效，或同一课次有重复例外' }, 400);
      const original = dateStamp(e.original_date),
        week = Math.floor((original - dateStamp(t.semester_start)) / (7 * DAY)) + 1;
      const wd = ((new Date(original + LOCAL_TZ).getUTCDay() + 6) % 7) + 1;
      if (e.kind !== 'add' && (rule.weekday !== wd || !rule.weeks.includes(week)))
        return c.json({ error: '例外的原日期没有这门课，不能取消或移动不存在的课次' }, 400);
      exceptionKeys.add(key);
    }
    const loss =
      previous.courses.length > 0 &&
      t.mode === 'replace' &&
      (t.courses.length < previous.courses.length * 0.8 || previous.courses.some((x) => x.user_modified));
    if (loss && !t.confirm_loss)
      return c.json({ error: '替换将大量减少课程或覆盖人工修改，请核对差异并明确确认' }, 409);
    try {
      saveTimetable(t);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : '保存失败' }, 409);
    }
    return c.json(getTimetable());
  });

  app.delete('/api/timetable', async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as { expected_revision?: number };
    try {
      clearTimetable(raw?.expected_revision);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : '清空失败' }, 409);
    }
    return c.json({ ok: true });
  });
  app.get('/api/timetable/versions', (c) => c.json(timetableVersions()));
  app.post('/api/timetable/restore/:id', async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { expected_revision?: number } | null;
    if (!raw || raw.expected_revision !== getTimetable().revision)
      return c.json({ error: '课表已更新，请重新载入版本列表' }, 409);
    const version = timetableVersions().find((v) => v.id === Number(c.req.param('id')));
    if (!version) return c.json({ error: '版本不存在或已超出最近 20 个版本' }, 404);
    saveTimetable({ ...version.timetable, expected_revision: raw.expected_revision }, '恢复历史版本');
    return c.json(getTimetable());
  });

  // ── 中南教务系统(csujwc)直连导入 ──
  // 两步:① start(学号+密码)→ 返回验证码图片;② fetch(验证码)→ 课次列表(不落库,走预览确认)。
  // 学号/密码只在服务端内存里存活到本次导入完成;写接口本来就仅限 loopback(lan-guard)。
  const csuStartSchema = z.object({
    user: z
      .string()
      .trim()
      .regex(/^\d{4,20}$/, '学号应为数字'),
    password: z.string().min(1).max(64),
  });
  const csuFetchSchema = z.object({
    session_id: z.string().trim().min(8).max(64),
    // CAS 连续失败后才要求验证码(最长 10 位);不需要时前端传空串
    captcha: z
      .string()
      .trim()
      .regex(/^[0-9a-zA-Z]{0,10}$/, '验证码格式不对')
      .default(''),
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
      return c.json(await csuFetchCourses(parsed.data.session_id, parsed.data.captcha));
    } catch (e) {
      const status = e instanceof CsuError ? 502 : 500;
      const message = e instanceof Error ? e.message : '教务系统导入失败';
      console.warn(`[csujwc] fetch 失败:${message}`);
      return c.json({ error: message }, status);
    }
  });
}
