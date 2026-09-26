// D3 自测：本周页以「某周周一」为基准分 7 天、DDL 识别、上海时区边界、翻周。
import { describe, expect, it } from 'vitest';
import type { EventDTO } from '../api/types';
import { weekdayDate } from './time';
import { groupByDay, thisMonday, weekRange } from './week';

const sh = (s: string) => Date.parse(`${s}+08:00`);
const NOW = sh('2026-09-30T10:00:00'); // 周三
const MON = sh('2026-09-28T00:00:00'); // 这周的周一

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
    version: 1,
    created_at: 0,
    updated_at: 0,
    ...p,
  };
}

describe('weekRange / thisMonday / weekdayDate', () => {
  it('从周一起 7 天', () => {
    expect(weekRange(MON)).toEqual({ from: MON, to: sh('2026-10-05T00:00:00') });
  });

  it('thisMonday：周内任意时刻都归到同一个周一', () => {
    expect(thisMonday(NOW)).toBe(MON);
    expect(thisMonday(MON)).toBe(MON);
    expect(thisMonday(sh('2026-10-04T23:59:00'))).toBe(MON); // 周日也算这周
    expect(thisMonday(sh('2026-10-05T00:00:00'))).toBe(sh('2026-10-05T00:00:00')); // 下周一归下周
  });

  it('列标题「周三 10/1」格式', () => {
    expect(weekdayDate(sh('2026-09-30T00:00:00'))).toBe('周三 9/30');
    expect(weekdayDate(sh('2026-10-01T00:00:00'))).toBe('周四 10/1');
  });
});

describe('groupByDay', () => {
  it('7 天，第一天是周一，今天有 isToday', () => {
    const days = groupByDay([], MON, NOW);
    expect(days).toHaveLength(7);
    expect(days[0]!.from).toBe(MON);
    expect(days.map((d) => d.isToday)).toEqual([false, false, true, false, false, false, false]);
    expect(days[6]!.from).toBe(sh('2026-10-04T00:00:00'));
  });

  it('按开始时间分到对应的天，天内按时间升序', () => {
    const late = ev({ start_at: sh('2026-10-01T19:00:00') });
    const early = ev({ start_at: sh('2026-10-01T08:00:00') });
    const days = groupByDay([late, early], MON, NOW);
    expect(days[3]!.items.map((i) => i.event.id)).toEqual([early.id, late.id]);
  });

  it('只有截止时间 → DDL 条目，按截止时间分天', () => {
    const ddl = ev({ deadline_at: sh('2026-10-02T23:59:00') });
    const days = groupByDay([ddl], MON, NOW);
    expect(days[4]!.items).toEqual([{ event: ddl, at: ddl.deadline_at, isDeadline: true }]);
  });

  it('开始时间不在本周但截止在本周 → 放在截止那天，标 DDL（落位用的是 deadline）', () => {
    const e = ev({ start_at: sh('2026-09-20T09:00:00'), deadline_at: sh('2026-10-03T12:00:00') });
    const days = groupByDay([e], MON, NOW);
    expect(days[5]!.items[0]!.at).toBe(e.deadline_at);
    expect(days[5]!.items[0]!.isDeadline).toBe(true);
  });

  it('上海 23:59 与次日 00:00 分在两天', () => {
    const a = ev({ start_at: sh('2026-09-30T23:59:00') });
    const b = ev({ start_at: sh('2026-10-01T00:00:00') });
    const days = groupByDay([a, b], MON, NOW);
    expect(days[2]!.items.map((i) => i.event.id)).toEqual([a.id]);
    expect(days[3]!.items.map((i) => i.event.id)).toEqual([b.id]);
  });

  it('不显示 cancelled、本周外、没有时间的事件', () => {
    const days = groupByDay(
      [
        ev({ start_at: sh('2026-10-01T09:00:00'), status: 'cancelled' }),
        ev({ start_at: sh('2026-10-05T00:00:00') }), // 下周一 0 点 = 下周
        ev({ start_at: sh('2026-09-27T23:00:00') }), // 上周日
        ev({}),
      ],
      MON,
      NOW,
    );
    expect(days.flatMap((d) => d.items)).toHaveLength(0);
  });

  it('done / pending_confirm 照常显示', () => {
    const days = groupByDay(
      [ev({ start_at: sh('2026-10-01T09:00:00'), status: 'done' }), ev({ deadline_at: sh('2026-10-01T10:00:00'), status: 'pending_confirm' })],
      MON,
      NOW,
    );
    expect(days[3]!.items).toHaveLength(2);
  });
});
