// D2 自测：页面时间一律按 Asia/Shanghai 显示，与运行环境时区无关。
import { describe, expect, it } from 'vitest';
import { dayLabel, eventTimeText, formatWhen, hhmm, shanghaiDayRange } from './time';

/** 上海时间 → 毫秒时间戳 */
const sh = (s: string) => Date.parse(`${s}+08:00`);

// 2026-09-30 是周三
const NOW = sh('2026-09-30T10:00:00');

describe('shanghaiDayRange', () => {
  it('今天 = 上海 0 点到次日 0 点', () => {
    expect(shanghaiDayRange(0, NOW)).toEqual({ from: sh('2026-09-30T00:00:00'), to: sh('2026-10-01T00:00:00') });
  });

  it('UTC 已是次日但上海仍是当天的边界（上海 23:30）', () => {
    const r = shanghaiDayRange(0, sh('2026-09-30T23:30:00'));
    expect(r.from).toBe(sh('2026-09-30T00:00:00'));
  });

  it('上海凌晨（UTC 仍是前一天）算新的一天', () => {
    const r = shanghaiDayRange(0, sh('2026-10-01T01:00:00'));
    expect(r.from).toBe(sh('2026-10-01T00:00:00'));
  });

  it('dayOffset 跨月', () => {
    expect(shanghaiDayRange(1, NOW).from).toBe(sh('2026-10-01T00:00:00'));
  });
});

describe('格式化', () => {
  it('hhmm 为上海时间 24 小时制', () => {
    expect(hhmm(sh('2026-09-30T14:05:00'))).toBe('14:05');
    expect(hhmm(sh('2026-09-30T00:00:00'))).toBe('00:00');
    expect(hhmm(sh('2026-09-30T23:59:00'))).toBe('23:59');
  });

  it('dayLabel：今天/明天/后天/昨天/周几/日期', () => {
    expect(dayLabel(sh('2026-09-30T23:59:00'), NOW)).toBe('今天');
    expect(dayLabel(sh('2026-10-01T00:00:00'), NOW)).toBe('明天');
    expect(dayLabel(sh('2026-10-02T08:00:00'), NOW)).toBe('后天');
    expect(dayLabel(sh('2026-09-29T08:00:00'), NOW)).toBe('昨天');
    expect(dayLabel(sh('2026-10-03T08:00:00'), NOW)).toBe('周六');
    expect(dayLabel(sh('2026-10-07T08:00:00'), NOW)).toBe('10/7');
  });

  it('formatWhen', () => {
    expect(formatWhen(sh('2026-10-02T14:00:00'), NOW)).toBe('后天 14:00');
  });
});

describe('eventTimeText', () => {
  const base = { start_at: null, end_at: null, deadline_at: null };

  it('今天的开始~结束省略日期', () => {
    const r = eventTimeText({ ...base, start_at: sh('2026-09-30T14:00:00'), end_at: sh('2026-09-30T14:45:00') }, NOW);
    expect(r).toEqual({ text: '14:00–14:45', isDeadline: false });
  });

  it('只有截止时间 → 「xx:xx 截止」且标红', () => {
    const r = eventTimeText({ ...base, deadline_at: sh('2026-09-30T23:59:00') }, NOW);
    expect(r).toEqual({ text: '23:59 截止', isDeadline: true });
  });

  it('有开始时间时以开始时间为准', () => {
    const r = eventTimeText({ ...base, start_at: sh('2026-09-30T09:00:00'), deadline_at: sh('2026-09-30T23:59:00') }, NOW);
    expect(r.isDeadline).toBe(false);
    expect(r.text).toBe('09:00');
  });

  it('不在今天的时间带日期', () => {
    const r = eventTimeText({ ...base, start_at: sh('2026-10-02T14:00:00') }, NOW);
    expect(r.text).toBe('后天 14:00');
  });

  it('没有任何时间', () => {
    expect(eventTimeText(base, NOW)).toEqual({ text: '时间待定', isDeadline: false });
  });
});
