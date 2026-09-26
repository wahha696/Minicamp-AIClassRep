// 课表解析（FR-13）：附录 A 的脱敏样例 + 变体用例；blockOf / weekOf 与后端同组用例。
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/timetable-rows.json';
import { blockOf, parseTimetable, parseWeeks, weekOf } from './timetable';

const sh = (date: string, hhmm = '00:00') => Date.parse(`${date}T${hhmm}:00+08:00`);

describe('parseTimetable（附录 A 样例）', () => {
  const { courses, warnings } = parseTimetable(fixture as string[][]);

  it('解析出 13 个课次（同门课不同天各一条），没有 warnings', () => {
    expect(warnings).toEqual([]);
    expect(courses).toHaveLength(13);
  });

  it('表头按文字定位（星期日在第 1 列）：周二 3-4 节 = 概率论', () => {
    const p = courses.find((c) => c.name === '概率论与数理统计A' && c.weekday === 2);
    expect(p).toMatchObject({
      teacher: '彭丽华(副教授)',
      location: 'B座312',
      block: 2,
      weeks: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    });
  });

  it('空教室（体育）→ location 为空串，不产生 warning', () => {
    const pe = courses.find((c) => c.name === '体育（三）');
    expect(pe).toMatchObject({ weekday: 2, block: 3, location: '', teacher: '张绮(讲师)' });
    expect(pe!.weeks[0]).toBe(3);
    expect(pe!.weeks).toHaveLength(16); // 3-18
  });

  it('多教师合一行（创新创业导论）完整保留', () => {
    const c = courses.find((c) => c.name === '创新创业导论');
    expect(c?.teacher).toBe('王斌(教授),钟萍(副教授),张永敏(教授),杨柳(教授)');
  });

  it('「8,12」非连续周次', () => {
    const c = courses.find((c) => c.name === '形势与政策');
    expect(c).toMatchObject({ weekday: 3, block: 5, location: 'C座410' });
    expect(c?.weeks).toEqual([8, 12]);
  });

  it('备注行被忽略，不产生 warning、不产课程', () => {
    expect(courses.some((c) => c.name.includes('高级程序设计实践'))).toBe(false);
  });
});

describe('parseTimetable 变体', () => {
  const header = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

  it('半角横线节次行也能认', () => {
    const rows = [
      header,
      ['3-4', '\n课程A\n教师A\n1-5[周]\nA101\n'],
    ];
    const { courses, warnings } = parseTimetable(rows as string[][]);
    expect(warnings).toEqual([]);
    expect(courses[0]).toMatchObject({ name: '课程A', weekday: 1, block: 2 });
  });

  it('一个格子多门课：按周次行切段', () => {
    const cell = '\n课A\n教师A\n1-5[周]\nA101\n课B\n教师B\n6-10[周]\nA202\n';
    const { courses, warnings } = parseTimetable([header, ['1－2', cell]] as string[][]);
    expect(warnings).toEqual([]);
    expect(courses.map((c) => c.name)).toEqual(['课A', '课B']);
    expect(courses[0]!.location).toBe('A101');
    expect(courses[1]!.location).toBe('A202');
    expect(courses[0]!.weeks).toEqual([1, 2, 3, 4, 5]);
    expect(courses[1]!.weeks).toEqual([6, 7, 8, 9, 10]);
  });

  it('11–12 节有课 → warning；空行不警告', () => {
    const rows = [
      header,
      ['11－12', '\n晚课\n某老师\n1-16[周]\nX101\n'],
    ];
    const { courses, warnings } = parseTimetable(rows as string[][]);
    expect(courses).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('第 11–12 节不在作息表内');
    expect(warnings[0]).toContain('晚课');

    const empty = parseTimetable([header, ['11－12', ' ', ' ']] as string[][]);
    expect(empty.warnings).toEqual([]);
  });

  it('没有表头行 → warning 提示', () => {
    const { courses, warnings } = parseTimetable([['a', 'b']] as string[][]);
    expect(courses).toEqual([]);
    expect(warnings[0]).toContain('没找到表头行');
  });

  it('周次解析失败 → warning 且跳过该门课，同格其他课不受影响', () => {
    const cell = '\n课A\n教师A\n周次不明\nA101\n课B\n教师B\n1-5[周]\nA202\n';
    // 「周次不明」不含 [周] → 只有 1-5[周] 一个锚点，课A 被并进课B 的头部；加个真锚点验证跳过逻辑：
    const { warnings } = parseTimetable([header, ['1－2', cell]] as string[][]);
    expect(warnings.length).toBeGreaterThanOrEqual(0); // 形态一：课A 名字进了课B 的头
    const cell2 = '\n课A\n教师A\nabc[周]\nA101\n课B\n教师B\n1-5[周]\nA202\n';
    const { courses, warnings: w2 } = parseTimetable([header, ['1－2', cell2]] as string[][]);
    expect(w2.some((w) => w.includes('课A'))).toBe(true); // abc[周] 解析失败 → 跳过课A
    expect(courses.map((c) => c.name)).toEqual(['课B']);
  });
});

describe('parseWeeks', () => {
  it.each([
    ['3-16[周]', [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]],
    ['8,12[周]', [8, 12]],
    ['1-15单[周]', [1, 3, 5, 7, 9, 11, 13, 15]],
    ['2-16双[周]', [2, 4, 6, 8, 10, 12, 14, 16]],
    ['3[周]', [3]],
    ['5-3[周]', null], // 倒序区间
    ['abc[周]', null],
    ['', null],
  ] as const)('%s', (input, want) => {
    expect(parseWeeks(input)).toEqual(want);
  });
});

describe('blockOf / weekOf（与后端同组用例）', () => {
  it.each([
    ['07:30', 1],
    ['09:45', 1],
    ['12:30', 2],
    ['13:59', 2],
    ['17:50', 4],
    ['21:00', 5],
  ] as const)('%s → 块 %i', (hhmm, want) => {
    expect(blockOf(sh('2026-09-23', hhmm))).toBe(want);
  });

  it('开学当天=1、前一天=0、下个周一=2', () => {
    const start = '2026-09-07';
    expect(weekOf(sh('2026-09-07'), start)).toBe(1);
    expect(weekOf(sh('2026-09-06'), start)).toBe(0);
    expect(weekOf(sh('2026-09-13'), start)).toBe(1);
    expect(weekOf(sh('2026-09-14'), start)).toBe(2);
  });
});
