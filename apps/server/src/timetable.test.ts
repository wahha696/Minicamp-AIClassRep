// 课表：blockOf / weekOf / occurrences / 存取 / groupCourseName（FR-13）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from './db/index.js';
import {
  blockOf,
  getTimetable,
  groupCourseName,
  occurrences,
  saveTimetable,
  clearTimetable,
  weekOf,
  weekdayOf,
} from './timetable.js';
import type { CourseDTO } from './types.js';

/** 上海时间某天某刻 → 毫秒 */
const sh = (date: string, hhmm = '00:00') => Date.parse(`${date}T${hhmm}:00+08:00`);

const course = (over: Partial<CourseDTO> = {}): CourseDTO => ({
  name: '概率论与数理统计A',
  teacher: '彭丽华(副教授)',
  location: 'B座312',
  weekday: 2, // 周二
  block: 2, // PR 模型里 block 仅是显示提示
  start_period: 3, // 3–4 节 10:00–11:40
  end_period: 4,
  weeks: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  ...over,
});

beforeAll(() => openDb(':memory:'));
afterAll(() => db.close());
beforeEach(() => {
  db.exec('DELETE FROM courses; DELETE FROM groups;');
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('semester_start', '2026-09-07')").run();
});

describe('blockOf', () => {
  it.each([
    ['07:30', 1], // 比第 1 块早 → 第 1 块
    ['09:45', 1], // 课间（1 块刚结束）→ 归 1 块
    ['12:30', 2], // 午休 → 归上一块
    ['13:59', 2], // 第 3 块开始前一分钟
    ['17:50', 4], // 晚饭后 → 归上一块
    ['20:50', 6], // 晚课块开始（11–12 节 20:50–22:30）
    ['21:00', 6], // 11–12 节块
    ['23:30', 6], // 晚自习结束还归最后一块
  ] as const)('%s → 块 %i', (hhmm, want) => {
    expect(blockOf(sh('2026-09-23', hhmm))).toBe(want);
  });
});

describe('weekOf', () => {
  it('开学当天（周一）= 第 1 周，前一天 = 0', () => {
    expect(weekOf(sh('2026-09-07'))).toBe(1);
    expect(weekOf(sh('2026-09-06'))).toBe(0);
  });

  it('周日仍算本周（第 1 周），下个周一 = 第 2 周', () => {
    expect(weekOf(sh('2026-09-13'))).toBe(1);
    expect(weekOf(sh('2026-09-14'))).toBe(2);
  });
});

describe('weekdayOf', () => {
  it('周一=1 … 周日=7', () => {
    expect(weekdayOf(sh('2026-09-07'))).toBe(1); // 周一
    expect(weekdayOf(sh('2026-09-13'))).toBe(7); // 周日
  });
});

describe('存取', () => {
  it('save → get 回读；再 save 整表替换；clear 清空', () => {
    saveTimetable({ semester_start: '2026-09-07', courses: [course()] });
    let t = getTimetable();
    expect(t.semester_start).toBe('2026-09-07');
    expect(t.courses).toHaveLength(1);
    expect(t.courses[0]).toMatchObject({ name: '概率论与数理统计A', weekday: 2, start_period: 3, end_period: 4 });

    saveTimetable({ semester_start: '2027-02-23', courses: [course({ name: '体育' })] });
    t = getTimetable();
    expect(t.semester_start).toBe('2027-02-23');
    expect(t.courses.map((c) => c.name)).toEqual(['体育']);

    clearTimetable();
    expect(getTimetable().courses).toHaveLength(0);
  });

  it('weeks 是坏 JSON 时给空数组不炸', () => {
    db.prepare(
      'INSERT INTO courses (name, teacher, location, weekday, block, weeks) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('坏数据课', '', '', 1, 1, 'not-json');
    expect(getTimetable().courses[0]!.weeks).toEqual([]);
  });
});

describe('occurrences', () => {
  it('按 weekday/weeks 展开成具体课次并按开始排序', () => {
    // 周二块2（10:00–11:40）、周五块2；第 1 周只有周二这门的周数里没有（3–16 不含 1）
    saveTimetable({
      semester_start: '2026-09-07',
      courses: [course(), course({ weekday: 5, name: '人工智能', location: 'B座505' })],
    });
    // 第 3 周：9/21(一) ~ 9/27(日)
    const occ = occurrences(sh('2026-09-21'), sh('2026-09-28'));
    expect(occ).toHaveLength(2);
    expect(occ[0]!.start).toBe(sh('2026-09-22', '10:00'));
    expect(occ[0]!.end).toBe(sh('2026-09-22', '11:40'));
    expect(occ[1]!.start).toBe(sh('2026-09-25', '10:00'));
  });

  it('单双周：单周课在双周不出现', () => {
    saveTimetable({
      semester_start: '2026-09-07',
      courses: [course({ name: '单周课', weeks: [1, 3, 5] })],
    });
    expect(occurrences(sh('2026-09-07'), sh('2026-09-14'))).toHaveLength(1); // 第 1 周
    expect(occurrences(sh('2026-09-14'), sh('2026-09-21'))).toHaveLength(0); // 第 2 周
    expect(occurrences(sh('2026-09-21'), sh('2026-09-28'))).toHaveLength(1); // 第 3 周
  });

  it('跨块连排（1–4 节）与晚课（11–12 节）按节次范围展开', () => {
    saveTimetable({
      semester_start: '2026-09-07',
      courses: [
        course({ name: '上午连排', block: 2, start_period: 1, end_period: 4 }),
        course({ name: '晚课', block: 6, start_period: 11, end_period: 12 }),
      ],
    });
    const occ = occurrences(sh('2026-09-21'), sh('2026-09-23'));
    expect(occ).toHaveLength(2);
    expect(occ[0]).toMatchObject({ course: { name: '上午连排' }, start: sh('2026-09-22', '08:00'), end: sh('2026-09-22', '11:40') });
    expect(occ[1]).toMatchObject({ course: { name: '晚课' }, start: sh('2026-09-22', '20:50'), end: sh('2026-09-22', '22:30') }); // PR 作息表 11–12 节 = 20:50–22:30
  });

  it('开学前（week ≤ 0）不产课次；没课表返回 []', () => {
    saveTimetable({ semester_start: '2026-09-07', courses: [course({ weeks: [1] })] });
    expect(occurrences(sh('2026-08-31'), sh('2026-09-07'))).toHaveLength(0);
    clearTimetable();
    expect(occurrences(sh('2026-09-21'), sh('2026-09-28'))).toHaveLength(0);
  });
});

describe('groupCourseName', () => {
  it('绑定了就返回，没绑定/群不存在返回 null', () => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO groups (group_id, name, enabled, adapter, course_name, created_at) VALUES ('g1', '计科1班', 1, 'onebot', '概率论与数理统计A', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('g2', '年级群', 1, 'onebot', ?)",
    ).run(now);
    expect(groupCourseName('g1')).toBe('概率论与数理统计A');
    expect(groupCourseName('g2')).toBeNull();
    expect(groupCourseName('ghost')).toBeNull();
  });
});
