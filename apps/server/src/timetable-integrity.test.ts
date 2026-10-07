import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { db, openDb } from './db/index.js';
import { registerTimetableRoutes } from './routes/timetable.js';
import { getTimetable, occurrences, saveTimetable, timetableVersions } from './timetable.js';
import { parseTimetable, parseWeeks } from '../../../shared/timetable-import.js';
import {
  courseKey,
  dateStamp,
  DEFAULT_BELLS,
  expandTimetable,
  findConflicts,
  normalizeCourses,
  reconcileCourses,
  type CourseDTO,
} from '../../../shared/timetable.js';
import { parseTimetableHtml } from './timetable-html.js';

const header = ['节次', '周一', '周二', '周三', '周四', '周五'];
const cell = (name: string, weeks = '1-2', teacher = '教师', location = 'A101') =>
  `${name}\n${teacher}\n${weeks}[周]\n${location}`;
const rule: CourseDTO = {
  id: 'a',
  name: '课程',
  teacher: '张老师',
  location: 'A101',
  weekday: 1,
  block: 1,
  start_period: 1,
  end_period: 4,
  weeks: [1, 2],
};
const start = dateStamp('2026-09-07'),
  day = 86400000;
const app = new Hono();
registerTimetableRoutes(app);
const request = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
beforeEach(() => openDb(':memory:'));
afterAll(() => db.close());

describe('源片段 → 规则 → 保存 → 具体日期 守恒', () => {
  it('工作日表头、同格两门、1–4 / 3–5 / 9–12 / 11–12 不丢失、不按名称去重', async () => {
    const parsed = parseTimetable(
      [
        header,
        ['1-4', `${cell('同名')}\n${cell('同名', '1-2', '另一教师', 'B202')}`],
        ['3-5', '', cell('连堂')],
        ['9-12', '', '', cell('夜课')],
        ['11-12', '', '', '', cell('晚课')],
      ],
      { sheet: '学期课表' },
    );
    expect(parsed.courses).toHaveLength(5);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items?.flatMap((i) => i.course_ids).sort()).toEqual(parsed.courses.map((c) => c.id).sort());
    expect(parsed.courses.map((c) => [c.start_period, c.end_period])).toEqual([
      [1, 4],
      [1, 4],
      [3, 5],
      [9, 12],
      [11, 12],
    ]);
    const response = await request('PUT', '/api/timetable', {
      semester_start: '2026-09-07',
      courses: parsed.courses,
      import_items: parsed.items,
      expected_revision: 0,
    });
    expect(response.status).toBe(200);
    const saved = getTimetable();
    expect(saved.courses.map(courseKey).sort()).toEqual(parsed.courses.map(courseKey).sort());
    expect(saved.import_items?.flatMap((i) => i.course_ids).sort()).toEqual(
      saved.courses.map((c) => c.id).sort(),
    );
    expect(occurrences(start, start + 14 * day)).toHaveLength(10);
    expect(new Set(occurrences(start, start + 14 * day).map((o) => o.course.id)).size).toBe(5);
    expect(occurrences(start, start + day)[0]!.end).toBe(dateStamp('2026-09-07') + (11 * 60 + 40) * 60000);
  });
  it('不明表头、坏周次、缺失星期都保留原文与定位；不允许带待确认项保存', async () => {
    for (const rows of [
      [['这是不支持的课表']],
      [header, ['1-2', '课程A\n教师\n不明周次\nA101']],
      [header, ['未知节次', cell('课')]],
    ]) {
      const parsed = parseTimetable(rows);
      expect(parsed.items?.some((i) => i.status === 'pending' && i.raw.length > 0)).toBe(true);
    }
    const parsed = parseTimetable([header, ['1-2', cell('好课')], ['3-4', '坏课\n未知']]);
    const res = await request('PUT', '/api/timetable', {
      semester_start: '2026-09-07',
      courses: parsed.courses,
      import_items: parsed.items,
    });
    expect(res.status).toBe(400);
    expect(getTimetable().courses).toEqual([]);
  });
  it('HTML 跨行连堂、嵌套表不重复，且可从原文一路保存并按周展开', async () => {
    const html =
      '<table><tr><td><table><tr><th>节次</th><th>周一</th><th>周二</th></tr><tr><td>1-2</td><td rowspan="2">课A<br>老师<br>1-2[周]<br>A101</td><td></td></tr><tr><td>3-4</td><td>课B<br><br>1[周]<br></td></tr></table></td></tr></table>';
    const p = parseTimetableHtml(html)!;
    expect(p.courses).toHaveLength(2);
    expect(p.courses[0]).toMatchObject({ start_period: 1, end_period: 4 });
    expect(p.courses[1]).toMatchObject({ teacher: '', location: '' });
    expect(p.items?.flatMap((item) => item.course_ids).sort()).toEqual(
      p.courses.map((course) => course.id).sort(),
    );
    const saved = await request('PUT', '/api/timetable', {
      semester_start: '2026-09-07',
      courses: p.courses,
      import_items: p.items,
      expected_revision: 0,
    });
    expect(saved.status).toBe(200);
    // 课 A 在 1–2 周，课 B 只在第 1 周：展开后共 3 个真实课次。
    expect(occurrences(start, start + 14 * day)).toHaveLength(3);
    const merged = parseTimetable([header, ['1-2', cell('不确定')]], {
      merges: [{ s: { r: 1, c: 1 }, e: { r: 1, c: 2 } }],
    });
    expect(merged.courses).toHaveLength(0);
    expect(merged.items![0]!.status).toBe('pending');
  });
  it('周次不能静默裁剪，也不能对超大范围循环', () => {
    expect(parseWeeks('1-999999999')).toBeNull();
    expect(parseWeeks('0-5')).toBeNull();
    expect(parseWeeks('1,99')).toBeNull();
    expect(parseWeeks('31-34双')).toEqual([32, 34]);
    expect(parseWeeks('1-4周(单周)')).toEqual([1, 3]);
  });
});
describe('日期、实际时间与例外', () => {
  it('同格同周两门冲突；单双周不冲突；邻接不冲突；DDL 不占课时', () => {
    const table = { semester_start: '2026-09-07', courses: [rule, { ...rule, id: 'b', name: '另一门' }] };
    const all = expandTimetable(table, start, start + day);
    expect(findConflicts(all)).toHaveLength(1);
    const split = expandTimetable(
      {
        ...table,
        courses: [
          { ...rule, weeks: [1] },
          { ...rule, id: 'b', weeks: [2] },
        ],
      },
      start,
      start + 14 * day,
    );
    expect(findConflicts(split)).toHaveLength(0);
    const first = all.slice(0, 1);
    expect(
      findConflicts(first, [{ id: 'ddl', start: first[0]!.start, end: first[0]!.end, deadline: true }]),
    ).toEqual([]);
    expect(findConflicts(first, [{ id: 'exam', start: first[0]!.end, end: first[0]!.end + 60000 }])).toEqual(
      [],
    );
    expect(
      findConflicts(first, [{ id: 'exam', start: first[0]!.start + 60000, end: first[0]!.end - 60000 }])[0],
    ).toMatchObject({ kind: 'event', start: first[0]!.start + 60000 });
  });
  it('开学前、第一周、短学期末周与跨年；取消、调课、补课不改周期规则', () => {
    const t = {
      semester_start: '2026-12-28',
      term_weeks: 2,
      courses: [{ ...rule, weekday: 6 as const, weeks: [1, 2, 3] }],
    };
    const from = dateStamp('2026-12-20'),
      to = dateStamp('2027-02-01');
    expect(expandTimetable(t, from, to).map((o) => o.date)).toEqual(['2027-01-02', '2027-01-09']);
    const adjusted = expandTimetable(
      {
        ...t,
        exceptions: [
          {
            id: 'move',
            rule_id: 'a',
            kind: 'move',
            original_date: '2027-01-02',
            date: '2027-01-03',
            start_time: '12:10',
            end_time: '13:00',
          },
          { id: 'cancel', rule_id: 'a', kind: 'cancel', original_date: '2027-01-09' },
          { id: 'add', rule_id: 'a', kind: 'add', original_date: '2027-01-10', date: '2027-01-10' },
        ],
      },
      from,
      to,
    );
    expect(adjusted.map((o) => o.date)).toEqual(['2027-01-03', '2027-01-10']);
    expect(t.courses[0]!.weeks).toEqual([1, 2, 3]);
  });
  it('自定义作息及课程实际时间优先；校区字段保留', () => {
    const t = {
      semester_start: '2026-09-07',
      courses: [{ ...rule, campus: '新校区', start_period: 11, end_period: 12 }],
      bells: DEFAULT_BELLS.map((b) => (b.period === 12 ? { ...b, end: '22:50' } : b)),
    };
    expect(expandTimetable(t, start, start + day)[0]!.end).toBe(start + (22 * 60 + 50) * 60000);
    const o = expandTimetable(
      { ...t, courses: [{ ...t.courses[0]!, start_time: '12:00', end_time: '13:15' }] },
      start,
      start + day,
    )[0]!;
    expect(o.start).toBe(start + 12 * 3600000);
    expect(o.course.campus).toBe('新校区');
  });
});
describe('重复导入、覆盖保护、恢复与旧库兼容', () => {
  it('不同学期不能直接合并，陈旧版本也不能清空新课表', async () => {
    saveTimetable({ semester_start: '2026-09-07', courses: [rule] });
    const before = getTimetable();
    expect(
      (await request('PUT', '/api/timetable', { ...before, semester_start: '2027-02-22', mode: 'merge' }))
        .status,
    ).toBe(409);
    expect((await request('DELETE', '/api/timetable', { expected_revision: 0 })).status).toBe(409);
    expect(getTimetable()).toEqual(before);
  });
  it('同格缺教师/教室的显式空行不使课程名、字段错位', () => {
    const parsed = parseTimetable([header, ['1-2', '课程甲\n\n1[周]\nA101\n课程乙\n张老师\n1[周]\n']]);
    expect(parsed.courses).toMatchObject([
      { name: '课程甲', teacher: '', location: 'A101' },
      { name: '课程乙', teacher: '张老师', location: '' },
    ]);
    expect(parsed.items![0]!.status).toBe('parsed');
    const transposed = parseTimetable([
      ['', '1-2', '3-4'],
      ['周一', '甲\n1周\nA101\n乙\n2周\nB202', ''],
    ]);
    expect(transposed.courses).toMatchObject([
      { name: '甲', location: 'A101', class_name: '' },
      { name: '乙', location: 'B202', class_name: '' },
    ]);
  });
  it('同名不同教师/地点和完全重复的两条原始项均有独立身份', () => {
    const rules = normalizeCourses([
      rule,
      { ...rule, id: undefined, teacher: '李老师' },
      { ...rule, id: undefined, location: 'B202' },
      { ...rule, id: undefined },
    ]);
    expect(new Set(rules.map((c) => c.id)).size).toBe(4);
    expect(reconcileCourses([], rules, 'merge').courses).toHaveLength(4);
  });
  it('合并保留人工修改，整表替换保留可恢复版本，版本号防止并发覆盖', async () => {
    saveTimetable({
      semester_start: '2026-09-07',
      courses: [{ ...rule, location: '手动地点', user_modified: true }],
    });
    const initial = getTimetable();
    const merge = await request('PUT', '/api/timetable', {
      ...initial,
      courses: [rule],
      mode: 'merge',
      expected_revision: initial.revision,
    });
    expect(merge.status).toBe(200);
    expect(getTimetable().courses[0]!.location).toBe('手动地点');
    const stale = await request('PUT', '/api/timetable', {
      ...initial,
      expected_revision: initial.revision,
      confirm_loss: true,
    });
    expect(stale.status).toBe(409);
    const noAck = await request('PUT', '/api/timetable', {
      ...getTimetable(),
      courses: [rule],
      mode: 'replace',
    });
    expect(noAck.status).toBe(409);
    const replace = await request('PUT', '/api/timetable', {
      ...getTimetable(),
      courses: [rule],
      mode: 'replace',
      confirm_loss: true,
    });
    expect(replace.status).toBe(200);
    const v = timetableVersions()[0]!;
    const restored = await request('POST', `/api/timetable/restore/${v.id}`, {
      expected_revision: getTimetable().revision,
    });
    expect(restored.status).toBe(200);
    expect(getTimetable().courses[0]!.location).toBe('手动地点');
    expect(timetableVersions().length).toBe(3);
  });
  it('拦截空导入、显著减少、无效日期/作息/例外/对账', async () => {
    saveTimetable({
      semester_start: '2026-09-07',
      courses: [rule, { ...rule, id: 'b' }, { ...rule, id: 'c' }],
    });
    const base = getTimetable();
    for (const patch of [
      { courses: [] },
      { courses: [rule] },
      { semester_start: '2026-02-30' },
      { bells: [{ period: 1, start: '18:00', end: '08:00' }] },
      { exceptions: [{ id: 'x', kind: 'cancel', rule_id: 'a', original_date: '2026-09-08' }] },
      {
        import_items: [
          { id: 'bad', sheet: 's', row: 1, column: 1, raw: 'x', status: 'parsed', course_ids: ['missing'] },
        ],
      },
    ]) {
      const response = await request('PUT', '/api/timetable', { ...base, ...patch });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(getTimetable().revision).toBe(base.revision);
    }
  });
  it('旧 block 记录兼容读取；清空和恢复都可撤销，最多保留 20 个版本', async () => {
    db.prepare('INSERT INTO courses(name,teacher,location,weekday,block,weeks) VALUES (?,?,?,?,?,?)').run(
      '旧课',
      '',
      '',
      1,
      5,
      '[1]',
    );
    const old = getTimetable().courses[0]!;
    expect(old).toMatchObject({ start_period: 9, end_period: 10 });
    expect(old.id).toMatch(/^legacy-/);
    for (let i = 0; i < 22; i++) saveTimetable({ semester_start: '2026-09-07', courses: [old] });
    expect(timetableVersions()).toHaveLength(20);
    await request('DELETE', '/api/timetable');
    expect(getTimetable().courses).toEqual([]);
    expect(timetableVersions()[0]!.timetable.courses).toHaveLength(1);
  });
});
