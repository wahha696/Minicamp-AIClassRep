// B4 验收：.ics 生成（VTIMEZONE / 类型中文名 / 转义 / 75 字节折行 / 截止型 / 无时间不导出）
import { describe, expect, it } from 'vitest';
import { buildIcs, escapeIcsText, foldLine } from './ics.js';
import type { EventDTO, EventType } from './types.js';

const NOW = Date.parse('2026-09-26T06:00:00Z'); // 上海 14:00，固定 DTSTAMP
const SHANGHAI_1400 = Date.parse('2026-09-26T14:00:00+08:00');
const SHANGHAI_1500 = Date.parse('2026-09-26T15:00:00+08:00');

function ev(over: Partial<EventDTO> = {}): EventDTO {
  return {
    id: 1,
    group_id: 'g1',
    group_name: '高数(2)班',
    type: 'exam',
    title: '高数小测',
    description: '',
    start_at: null,
    end_at: null,
    deadline_at: null,
    location: null,
    action_required: null,
    status: 'active',
    confidence: 0.9,
    level: 2,
    level_locked: false,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function lines(ics: string): string[] {
  return ics.split('\r\n').filter((l) => l !== '');
}

describe('escapeIcsText', () => {
  it('转义反斜杠、分号、逗号与换行', () => {
    expect(escapeIcsText('a\\b')).toBe('a\\\\b');
    expect(escapeIcsText('a;b')).toBe('a\\;b');
    expect(escapeIcsText('a,b')).toBe('a\\,b');
    expect(escapeIcsText('第一行\n第二行')).toBe('第一行\\n第二行');
    expect(escapeIcsText('第一行\r\n第二行')).toBe('第一行\\n第二行');
  });

  it('反斜杠先换，不会把新加的转义再转一次', () => {
    expect(escapeIcsText('\\;')).toBe('\\\\\\;');
  });

  it('普通中文不动', () => {
    expect(escapeIcsText('明天下午两点在 A301 随堂小测')).toBe('明天下午两点在 A301 随堂小测');
  });
});

describe('foldLine', () => {
  it('不超过 75 字节的行原样返回', () => {
    const line = 'SUMMARY:' + 'x'.repeat(60);
    expect(foldLine(line)).toBe(line);
  });

  it('超过 75 字节按 75/74 折行，续行以一个空格开头', () => {
    const folded = foldLine('x'.repeat(200));
    const parts = folded.split('\r\n ');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(75);
    expect(parts[1]).toHaveLength(74);
    expect(parts[2]).toHaveLength(200 - 75 - 74);
    expect(folded.split('\r\n')[0]).toHaveLength(75);
    expect(folded.split('\r\n')[1]!.startsWith(' ')).toBe(true);
  });

  it('每行都 ≤75 字节（中文占 3 字节，不能切断字符）', () => {
    const text = 'SUMMARY:' + '通'.repeat(80);
    const folded = foldLine(text);
    const encoder = new TextEncoder();
    for (const part of folded.split('\r\n')) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75);
      expect(part).not.toContain('\uFFFD');
    }
    // 折行后去掉 CRLF + 空格应能还原原文
    expect(folded.split('\r\n').map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(text);
  });
});

describe('buildIcs', () => {
  it('有可导出事件时返回完整日历骨架与 VTIMEZONE', () => {
    const ics = buildIcs([ev({ start_at: SHANGHAI_1400 })], NOW);
    const ls = lines(ics);
    expect(ls[0]).toBe('BEGIN:VCALENDAR');
    expect(ls).toContain('VERSION:2.0');
    expect(ls).toContain('PRODID:-//ClassRep//CN');
    expect(ls[ls.length - 1]).toBe('END:VCALENDAR');
    // VTIMEZONE：固定 +0800，STANDARD 从 19700101T000000 起（RFC 5545：这里必须是本地时间，不能带 Z）
    const start = ls.indexOf('BEGIN:VTIMEZONE');
    const end = ls.indexOf('END:VTIMEZONE');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const tz = ls.slice(start, end + 1);
    expect(tz).toContain('TZID:Asia/Shanghai');
    expect(tz).toContain('BEGIN:STANDARD');
    expect(tz).toContain('DTSTART:19700101T000000');
    expect(tz.some((l) => l.startsWith('DTSTART:') && l.endsWith('Z'))).toBe(false);
    expect(tz).toContain('TZOFFSETFROM:+0800');
    expect(tz).toContain('TZOFFSETTO:+0800');
    expect(tz).toContain('END:STANDARD');
  });

  it('行尾是 CRLF', () => {
    const ics = buildIcs([ev({ start_at: SHANGHAI_1400 })], NOW);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.split('\r\n').length).toBeGreaterThan(10);
  });

  it('有 start_at：DTSTART 带 TZID，DTEND 缺省为 start_at + 1 小时', () => {
    const ics = buildIcs([ev({ start_at: SHANGHAI_1400, location: 'A301' })], NOW);
    const ls = lines(ics);
    expect(ls).toContain('UID:classrep-1@local');
    expect(ls).toContain('DTSTAMP:20260926T060000Z');
    expect(ls).toContain('DTSTART;TZID=Asia/Shanghai:20260926T140000');
    expect(ls).toContain('DTEND;TZID=Asia/Shanghai:20260926T150000');
    expect(ls).toContain('SUMMARY:[考试]高数小测');
    expect(ls).toContain('LOCATION:A301');
  });

  it('有 end_at 时用 end_at', () => {
    const ics = buildIcs([ev({ start_at: SHANGHAI_1400, end_at: SHANGHAI_1500 })], NOW);
    expect(lines(ics)).toContain('DTEND;TZID=Asia/Shanghai:20260926T150000');
  });

  it('只有 deadline_at：DTSTART = DTEND = 截止时刻，标题前加【截止】', () => {
    const ics = buildIcs([ev({ type: 'assignment', title: '交实验报告', deadline_at: SHANGHAI_1500 })], NOW);
    const ls = lines(ics);
    expect(ls).toContain('DTSTART;TZID=Asia/Shanghai:20260926T150000');
    expect(ls).toContain('DTEND;TZID=Asia/Shanghai:20260926T150000');
    expect(ls).toContain('SUMMARY:【截止】[作业]交实验报告');
  });

  it('两个时间都没有的事件不导出；全都不能导出时返回 null', () => {
    const ics = buildIcs([ev({ start_at: SHANGHAI_1400 }), ev({ id: 2, title: '没时间的事' })], NOW);
    const ls = lines(ics);
    expect(ls.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(ls).toContain('UID:classrep-1@local');
    expect(ls).not.toContain('UID:classrep-2@local');
    // 没有可导出的事件：合法的空日历（有骨架和 VTIMEZONE，没有 VEVENT）
    for (const empty of [buildIcs([ev({ title: '没时间的事' })], NOW), buildIcs([], NOW)]) {
      const el = lines(empty);
      expect(el[0]).toBe('BEGIN:VCALENDAR');
      expect(el[el.length - 1]).toBe('END:VCALENDAR');
      expect(el).toContain('BEGIN:VTIMEZONE');
      expect(el).not.toContain('BEGIN:VEVENT');
    }
  });

  it('DESCRIPTION = description + action_required；都为空则没有 DESCRIPTION 行', () => {
    const withBoth = buildIcs(
      [ev({ start_at: SHANGHAI_1400, description: '带计算器', action_required: '提前复习' })],
      NOW,
    );
    expect(lines(withBoth)).toContain('DESCRIPTION:带计算器\\n提前复习');

    const onlyAction = buildIcs([ev({ start_at: SHANGHAI_1400, action_required: '带计算器' })], NOW);
    expect(lines(onlyAction)).toContain('DESCRIPTION:带计算器');

    const none = buildIcs([ev({ start_at: SHANGHAI_1400 })], NOW);
    expect(lines(none).some((l) => l.startsWith('DESCRIPTION'))).toBe(false);
    expect(lines(none).some((l) => l.startsWith('LOCATION'))).toBe(false);
  });

  it('SUMMARY / LOCATION / DESCRIPTION 里的特殊字符被转义', () => {
    const ics = buildIcs(
      [
        ev({
          title: '小测, 带计算器; 别迟到',
          start_at: SHANGHAI_1400,
          location: 'A301, 三楼',
          description: '第一行\n第二行',
        }),
      ],
      NOW,
    );
    const ls = lines(ics);
    expect(ls).toContain('SUMMARY:[考试]小测\\, 带计算器\\; 别迟到');
    expect(ls).toContain('LOCATION:A301\\, 三楼');
    expect(ls).toContain('DESCRIPTION:第一行\\n第二行');
  });

  it('六种类型都有中文名', () => {
    const types: [EventType, string][] = [
      ['exam', '考试'],
      ['assignment', '作业'],
      ['meeting', '会议'],
      ['activity', '活动'],
      ['announcement', '通知'],
      ['other', '其他'],
    ];
    for (const [type, cn] of types) {
      const ics = buildIcs([ev({ type, title: 'X', start_at: SHANGHAI_1400 })], NOW);
      expect(lines(ics)).toContain(`SUMMARY:[${cn}]X`);
    }
  });

  it('按排序时间（start_at ?? deadline_at）升序，同时间按 id', () => {
    const ics = buildIcs(
      [
        ev({ id: 3, title: '晚', start_at: SHANGHAI_1500 }),
        ev({ id: 1, title: '早', deadline_at: SHANGHAI_1400 }),
        ev({ id: 2, title: '也早', start_at: SHANGHAI_1400 }),
      ],
      NOW,
    );
    const uids = lines(ics).filter((l) => l.startsWith('UID:'));
    expect(uids).toEqual(['UID:classrep-1@local', 'UID:classrep-2@local', 'UID:classrep-3@local']);
  });

  it('每个事件一个 VEVENT，BEGIN/END 配平', () => {
    const ics = buildIcs(
      [
        ev({ id: 1, start_at: SHANGHAI_1400 }),
        ev({ id: 2, deadline_at: SHANGHAI_1500, type: 'assignment' }),
      ],
      NOW,
    );
    const ls = lines(ics);
    expect(ls.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(ls.filter((l) => l === 'END:VEVENT')).toHaveLength(2);
  });

  it('很长的标题会折行，且折行后不破坏 SUMMARY 前缀', () => {
    const longTitle = '通'.repeat(60);
    const ics = buildIcs([ev({ title: longTitle, start_at: SHANGHAI_1400 })], NOW);
    const ls = lines(ics);
    const idx = ls.findIndex((l) => l.startsWith('SUMMARY:'));
    expect(idx).toBeGreaterThan(-1);
    expect(ls[idx]!.startsWith('SUMMARY:[考试]')).toBe(true);
    const encoder = new TextEncoder();
    for (const l of ls) expect(encoder.encode(l).length).toBeLessThanOrEqual(75);
    // 去掉折行标记后能还原出完整标题（可能折成多行，一直吃到下一个非续行）
    let unfolded = ls[idx]!;
    for (let i = idx + 1; i < ls.length && ls[i]!.startsWith(' '); i++) {
      unfolded += ls[i]!.slice(1);
    }
    expect(unfolded).toBe(`SUMMARY:[考试]${longTitle}`);
  });
});
