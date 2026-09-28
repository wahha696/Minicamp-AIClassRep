// 今日页排序自测：按时间 / 按紧急。
import { describe, expect, it } from 'vitest';
import type { EventDTO } from '../api/types';
import { sortEvents, urgencyTier } from './sort';

const sh = (s: string) => Date.parse(`${s}+08:00`);
const NOW = sh('2026-09-30T10:00:00');

let nextId = 1;
function ev(p: Partial<EventDTO>): EventDTO {
  return {
    id: nextId++,
    group_id: 'g',
    group_name: '群',
    type: 'other',
    title: 't',
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
    manual_locked_fields: [],
    version: 1,
    created_at: 0,
    updated_at: 0,
    ...p,
  };
}

const titles = (es: EventDTO[]) => es.map((e) => e.title);

describe('按时间', () => {
  it('开始时间或截止时间升序，时间待定排最后', () => {
    const es = [
      ev({ title: '待定' }),
      ev({ title: '作业', deadline_at: sh('2026-09-30T23:59:00') }),
      ev({ title: '会议', start_at: sh('2026-09-30T14:00:00') }),
      ev({ title: '早课', start_at: sh('2026-09-30T08:00:00') }),
    ];
    expect(titles(sortEvents(es, 'time', NOW))).toEqual(['早课', '会议', '作业', '待定']);
  });

  it('不改原数组', () => {
    const es = [ev({ title: 'b', start_at: 2 }), ev({ title: 'a', start_at: 1 })];
    sortEvents(es, 'time', NOW);
    expect(titles(es)).toEqual(['b', 'a']);
  });
});

describe('按紧急', () => {
  it('档位：两小时内 < 今天稍晚 < 待定 < 已过 < 已完成', () => {
    expect(urgencyTier(ev({ start_at: sh('2026-09-30T11:30:00') }), NOW)).toBe(0);
    expect(urgencyTier(ev({ start_at: sh('2026-09-30T12:00:00') }), NOW)).toBe(0);
    expect(urgencyTier(ev({ start_at: sh('2026-09-30T12:01:00') }), NOW)).toBe(1);
    expect(urgencyTier(ev({}), NOW)).toBe(2);
    expect(urgencyTier(ev({ start_at: sh('2026-09-30T08:00:00') }), NOW)).toBe(3);
    expect(urgencyTier(ev({ start_at: sh('2026-09-30T11:00:00'), status: 'done' }), NOW)).toBe(4);
  });

  it('两小时内的排最前；同档按时间升序（不再有类型优先）', () => {
    const es = [
      ev({ title: '晚上聚餐', type: 'activity', start_at: sh('2026-09-30T18:00:00') }),
      ev({ title: '下午班会', type: 'meeting', start_at: sh('2026-09-30T15:00:00') }),
      ev({ title: '晚上考试', type: 'exam', start_at: sh('2026-09-30T19:00:00') }),
      ev({ title: '马上排练', type: 'activity', start_at: sh('2026-09-30T11:00:00') }),
      ev({ title: '作业截止', type: 'assignment', deadline_at: sh('2026-09-30T23:59:00') }),
    ];
    expect(titles(sortEvents(es, 'urgency', NOW))).toEqual([
      '马上排练',
      '下午班会',
      '晚上聚餐',
      '晚上考试',
      '作业截止',
    ]);
  });

  it('等级为主：高等级排在更急的同级前面，压在低等级两小时内的前面', () => {
    const es = [
      ev({ title: '两小时后的事', level: 2, start_at: sh('2026-09-30T11:30:00') }),
      ev({ title: '晚上小测', level: 4, start_at: sh('2026-09-30T19:00:00') }),
      ev({ title: '下午的事', level: 3, start_at: sh('2026-09-30T15:00:00') }),
      ev({ title: '晚上的事', level: 3, start_at: sh('2026-09-30T20:00:00') }),
    ];
    // level 4 最前；两个 level 3 按 urgencyTier+时间：15:00 < 20:00；level 2 沉底（哪怕两小时内）
    expect(titles(sortEvents(es, 'urgency', NOW))).toEqual([
      '晚上小测',
      '下午的事',
      '晚上的事',
      '两小时后的事',
    ]);
  });

  it('已经过了的和做完的沉到底部', () => {
    const es = [
      ev({ title: '已完成', type: 'exam', start_at: sh('2026-09-30T16:00:00'), status: 'done' }),
      ev({ title: '早上已过', type: 'exam', start_at: sh('2026-09-30T08:00:00') }),
      ev({ title: '时间待定', type: 'announcement' }),
      ev({ title: '下午', type: 'other', start_at: sh('2026-09-30T16:00:00') }),
    ];
    expect(titles(sortEvents(es, 'urgency', NOW))).toEqual(['下午', '时间待定', '早上已过', '已完成']);
  });
});
