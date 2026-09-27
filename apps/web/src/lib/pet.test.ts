import { describe, expect, it } from 'vitest';
import type { EventDTO } from '../api/types';
import { clamp, deadlineHint, IDLE_LINES, nextStartHint, ongoingHint, petGreeting, petLine, pickRandom } from './pet';

const MIN = 60_000;
const H = 3_600_000;

const ev = (over: Partial<EventDTO> = {}): EventDTO => ({
  id: 1, group_id: 'g', group_name: 'g', type: 'other', title: '高数小测', description: '',
  start_at: null, end_at: null, deadline_at: null, location: null, action_required: null,
  status: 'active', confidence: 1, level: 2, level_locked: false, version: 1, created_at: 0, updated_at: 0, ...over,
});

describe('数值工具', () => {
  it('clamp 夹在区间内；min>max 时按 min 算，不抛错', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(5, 3, 2)).toBe(3);
  });

  it('pickRandom 用注入的 rng；越界时取最后一个', () => {
    expect(pickRandom(['a', 'b', 'c'], () => 0)).toBe('a');
    expect(pickRandom(['a', 'b', 'c'], () => 0.99)).toBe('c');
    expect(() => pickRandom([], () => 0.5)).toThrow();
  });
});

describe('桌宠台词', () => {
  it('petGreeting 按时段打招呼', () => {
    expect(petGreeting(4)).toBe('夜深了');
    expect(petGreeting(8)).toBe('早上好');
    expect(petGreeting(12)).toBe('中午好');
    expect(petGreeting(15)).toBe('下午好');
    expect(petGreeting(21)).toBe('晚上好');
  });

  it('10 分钟内要开始 → 提醒；更远或没有 → null', () => {
    const now = 1_000_000_000_000;
    expect(nextStartHint([ev({ start_at: now + 5 * MIN })], now)).toBe('距「高数小测」开始还有 5 分钟');
    expect(nextStartHint([ev({ start_at: now + MIN })], now)).toBe('马上要「高数小测」了，快准备！');
    expect(nextStartHint([ev({ start_at: now + 30 * MIN })], now)).toBeNull();
    expect(nextStartHint([], now)).toBeNull();
  });

  it('取消/已完成的事件不提醒', () => {
    expect(nextStartHint([ev({ start_at: 3 * MIN, status: 'cancelled' })], 0)).toBeNull();
    expect(ongoingHint([ev({ start_at: -MIN, end_at: 30 * MIN, status: 'done' })], 0)).toBeNull();
  });

  it('正在进行中的事', () => {
    expect(ongoingHint([ev({ start_at: -MIN, end_at: 30 * MIN })], 0)).toBe('「高数小测」正在进行中');
    expect(ongoingHint([ev({ start_at: 30 * MIN })], 0)).toBeNull();
    // 没写结束时间也算进行中
    expect(ongoingHint([ev({ start_at: -MIN, end_at: null })], 0)).toBe('「高数小测」正在进行中');
  });

  it('3 小时内截止的提醒', () => {
    expect(deadlineHint([ev({ deadline_at: 2 * H })], 0)).toBe('「高数小测」2 小时后截止，别忘了');
    expect(deadlineHint([ev({ deadline_at: 30 * MIN })], 0)).toBe('「高数小测」一小时内就要截止了！');
    expect(deadlineHint([ev({ deadline_at: 5 * H })], 0)).toBeNull();
    expect(deadlineHint([ev({ deadline_at: -MIN })], 0)).toBeNull(); // 已过期不再催
  });

  it('有急事且 rng<0.7 → 报事；否则从闲聊池挑（含后端摘要）', () => {
    const now = 0;
    expect(petLine([ev({ start_at: 5 * MIN })], now, undefined, () => 0.5))
      .toBe('距「高数小测」开始还有 5 分钟');
    // 摘要在闲聊池第 0 位：rng < 1/6 才会命中（池长 6）
    expect(petLine([], now, '今天 4 件事', () => 0.1)).toBe('今天 4 件事');
    const line = petLine([], now, undefined, () => 0.99);
    expect(IDLE_LINES).toContain(line);
  });
});
