// groupBySlot（FR-14）：同一天 + 同一节次块合成一组；代表 = 最急的；组的位置 = 代表在原列表的位置。
import { describe, expect, it } from 'vitest';
import { groupBySlot, slotKey } from './slots';

const sh = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+08:00`);

let seq = 0;
const ev = (over: { id?: number; level?: 1 | 2 | 3 | 4; start_at?: number | null; deadline_at?: number | null } = {}) => ({
  id: over.id ?? ++seq,
  level: over.level ?? 2,
  start_at: over.start_at ?? null,
  deadline_at: over.deadline_at ?? null,
});

describe('slotKey', () => {
  it('同一天同一块 → 同 key；不同块/不同天 → 不同 key；没时间 → null', () => {
    const a = ev({ start_at: sh('2026-09-23', '08:30') });
    const b = ev({ start_at: sh('2026-09-23', '09:35') }); // 同块 1
    const c = ev({ start_at: sh('2026-09-23', '10:05') }); // 块 2
    const d = ev({ start_at: sh('2026-09-24', '08:30') }); // 次日块 1
    const e = ev(); // 没时间
    expect(slotKey(a)).toBe(slotKey(b));
    expect(slotKey(a)).not.toBe(slotKey(c));
    expect(slotKey(a)).not.toBe(slotKey(d));
    expect(slotKey(e)).toBeNull();
  });

  it('没有 start_at 时用 deadline_at 落位', () => {
    const a = ev({ deadline_at: sh('2026-09-23', '08:30') });
    const b = ev({ start_at: sh('2026-09-23', '09:00') });
    expect(slotKey(a)).toBe(slotKey(b));
  });

  it('atOf 覆盖落位（本周页 DDL 条目按截止时刻）', () => {
    const a = ev({ start_at: sh('2026-09-28', '08:30'), deadline_at: sh('2026-09-23', '10:00') });
    // 默认落位用 start_at（块 1、9/28）；atOf 给 deadline → 9/23 块 2
    expect(slotKey(a)).not.toBe(slotKey(a, (i) => i.deadline_at));
    expect(slotKey(a, (i) => i.deadline_at)).toBe(slotKey(ev({ start_at: sh('2026-09-23', '10:30') })));
  });
});

describe('groupBySlot', () => {
  it('同组事件合成一组，组内保持原序；没时间的事件各自一组', () => {
    const a = ev({ start_at: sh('2026-09-23', '08:10') });
    const b = ev({ start_at: sh('2026-09-23', '09:30') });
    const c = ev({ start_at: sh('2026-09-24', '10:00') });
    const noTime = ev();
    const groups = groupBySlot([a, b, c, noTime]);
    expect(groups).toHaveLength(3);
    const big = groups.find((g) => g.items.length === 2)!;
    expect(big.items).toEqual([a, b]);
    expect(groups.find((g) => g.key === null)!.items).toEqual([noTime]);
  });

  it('代表 = level 最高；同级比落位时间早的；再平手比 id 小', () => {
    const later = ev({ id: 1, level: 2, start_at: sh('2026-09-23', '09:30') });
    const earlier = ev({ id: 2, level: 2, start_at: sh('2026-09-23', '08:10') });
    const urgent = ev({ id: 3, level: 4, start_at: sh('2026-09-23', '09:00') });
    expect(groupBySlot([later, earlier, urgent])[0]!.rep).toBe(urgent);
    expect(groupBySlot([later, earlier])[0]!.rep).toBe(earlier);
  });

  it('已完成的事件不当代表：同格还有没做完的，就让没做完的露在外面', () => {
    const doneUrgent = { ...ev({ id: 1, level: 4, start_at: sh('2026-09-23', '08:10') }), status: 'done' as const };
    const todo = { ...ev({ id: 2, level: 1, start_at: sh('2026-09-23', '09:00') }), status: 'active' as const };
    expect(groupBySlot([doneUrgent, todo])[0]!.rep).toBe(todo);
    // 全都完成了，照常按 level 选
    const doneLow = { ...todo, status: 'done' as const };
    expect(groupBySlot([doneUrgent, doneLow])[0]!.rep).toBe(doneUrgent);
  });

  it('组的位置 = 代表在原列表里的位置（按紧急排序时组跟着最急那条走）', () => {
    // 紧急排序：urgent(块1) 在最前，morn(块1) 在最后 → 组应出现在最前
    const urgent = ev({ level: 4, start_at: sh('2026-09-23', '09:30') });
    const otherDay = ev({ start_at: sh('2026-09-24', '10:00') });
    const morn = ev({ level: 1, start_at: sh('2026-09-23', '08:10') });
    const groups = groupBySlot([urgent, otherDay, morn]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.rep).toBe(urgent);
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[1]!.rep).toBe(otherDay);
  });

  it('按时间排序时：代表是最早那条，组位置同样正确', () => {
    const early = ev({ level: 2, start_at: sh('2026-09-23', '08:10') });
    const late = ev({ level: 2, start_at: sh('2026-09-23', '09:30') });
    const nextDay = ev({ start_at: sh('2026-09-24', '08:00') });
    const groups = groupBySlot([early, late, nextDay]);
    expect(groups[0]!.rep).toBe(early);
    expect(groups[1]!.rep).toBe(nextDay);
  });
});
