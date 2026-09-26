// D3 自测：本周 7 天分组、DDL 识别、上海时区边界。
import { describe, expect, it } from 'vitest';
import type { EventDTO } from '../api/types';
import { weekdayDate } from './time';
import { groupByDay, weekRange } from './week';

const sh = (s: string) => Date.parse(`${s}+08:00`);
const NOW = sh('2026-09-30T10:00:00'); // 周三

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
    version: 1,
    created_at: 0,
    updated_at: 0,
    ...p,
  };
}

describe('weekRange / weekdayDate', () => {
  it('今天 0 点起 7 天', () => {
    expect(weekRange(NOW)).toEqual({ from: sh('2026-09-30T00:00:00'), to: sh('2026-10-07T00:00:00') });
  });

  it('列标题「周三 10/1」格式', () => {
    expect(weekdayDate(sh('2026-09-30T00:00:00'))).toBe('周三 9/30');
    expect(weekdayDate(sh('2026-10-01T00:00:00'))).toBe('周四 10/1');
  });
});

describe('groupByDay', () => {
  it('7 天，第一天是今天', () => {
    const days = groupByDay([], NOW);
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.isToday)).toEqual([true, false, false, false, false, false, false]);
    expect(days[6]!.from).toBe(sh('2026-10-06T00:00:00'));
  });

  it('按开始时间分到对应的天，天内按时间升序', () => {
    const late = ev({ start_at: sh('2026-10-01T19:00:00') });
    const early = ev({ start_at: sh('2026-10-01T08:00:00') });
    const days = groupByDay([late, early], NOW);
    expect(days[1]!.items.map((i) => i.event.id)).toEqual([early.id, late.id]);
  });

  it('只有截止时间 → DDL 条目，按截止时间分天', () => {
    const ddl = ev({ deadline_at: sh('2026-10-02T23:59:00') });
    const days = groupByDay([ddl], NOW);
    expect(days[2]!.items).toEqual([{ event: ddl, at: ddl.deadline_at, isDeadline: true }]);
  });

  it('开始时间不在本周但截止在本周 → 放在截止那天（仍不是 DDL 条目）', () => {
    const e = ev({ start_at: sh('2026-09-20T09:00:00'), deadline_at: sh('2026-10-03T12:00:00') });
    const days = groupByDay([e], NOW);
    expect(days[3]!.items[0]!.at).toBe(e.deadline_at);
    expect(days[3]!.items[0]!.isDeadline).toBe(false);
  });

  it('上海 23:59 与次日 00:00 分在两天', () => {
    const a = ev({ start_at: sh('2026-09-30T23:59:00') });
    const b = ev({ start_at: sh('2026-10-01T00:00:00') });
    const days = groupByDay([a, b], NOW);
    expect(days[0]!.items.map((i) => i.event.id)).toEqual([a.id]);
    expect(days[1]!.items.map((i) => i.event.id)).toEqual([b.id]);
  });

  it('不显示 cancelled、7 天外、没有时间的事件', () => {
    const days = groupByDay(
      [
        ev({ start_at: sh('2026-10-01T09:00:00'), status: 'cancelled' }),
        ev({ start_at: sh('2026-10-07T00:00:00') }),
        ev({ start_at: sh('2026-09-29T23:00:00') }),
        ev({}),
      ],
      NOW,
    );
    expect(days.flatMap((d) => d.items)).toHaveLength(0);
  });

  it('done / pending_confirm 照常显示', () => {
    const days = groupByDay(
      [ev({ start_at: sh('2026-10-01T09:00:00'), status: 'done' }), ev({ deadline_at: sh('2026-10-01T10:00:00'), status: 'pending_confirm' })],
      NOW,
    );
    expect(days[1]!.items).toHaveLength(2);
  });
});
