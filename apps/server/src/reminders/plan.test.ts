import { expect, it } from 'vitest';
import { defaultReminderRules } from '../../../../shared/reminders.js';
import { groupReminderNodes, planDeadlineReminders } from './plan.js';
const now = Date.parse('2026-10-10T08:00:00Z');
const deadline = now + 48 * 3600_000;
const event = { id: 1, version: 1, status: 'active' as const, deadline_at: deadline };
const input = { spaceId: 'synthetic-space', targetId: 'synthetic-target', now, events: [event], rules: defaultReminderRules() };
it('默认关闭，主动开启后按精确 24 和 2 小时规划，不按日历日期计算', () => {
  expect(planDeadlineReminders(input).nodes).toHaveLength(0);
  const plan = planDeadlineReminders({ ...input, rules: { ...input.rules, enabled: true } });
  expect(plan.nodes.map(node => deadline - node.remind_at)).toEqual([86400_000, 7200_000]);
  expect(plan.nodes).toEqual(planDeadlineReminders({ ...input, rules: { ...input.rules, enabled: true }, events: [event, event] }).nodes);
});
it('同目标同一时间合并，多一个毫秒不延迟；目标及空间进入幂等标识', () => {
  const setup = { ...input, rules: { ...input.rules, enabled: true, before_minutes: [120] }, events: [event, { ...event, id: 2 }, { ...event, id: 3, deadline_at: deadline + 1 }] };
  const result = planDeadlineReminders(setup);
  expect(groupReminderNodes(result.nodes).map(group => group.nodes.length)).toEqual([2, 1]);
  expect(planDeadlineReminders({ ...setup, targetId: 'other' }).nodes[0]?.key).not.toBe(result.nodes[0]?.key);
  expect(planDeadlineReminders({ ...setup, spaceId: 'other' }).nodes[0]?.key).not.toBe(result.nodes[0]?.key);
  const other = planDeadlineReminders({ ...setup, targetId: 'other' });
  expect(groupReminderNodes([...result.nodes, ...other.nodes])).toHaveLength(4);
});
it('完成/取消不规划，改期替换旧节点；未确认时间不提醒', () => {
  const rules = { ...input.rules, enabled: true };
  expect(planDeadlineReminders({ ...input, rules, events: [{ ...event, status: 'done' }, { ...event, status: 'cancelled' }] }).nodes).toHaveLength(0);
  const old = planDeadlineReminders({ ...input, rules }).nodes;
  const changed = planDeadlineReminders({ ...input, rules, events: [{ ...event, version: 2, deadline_at: deadline + 3600_000 }] }).nodes;
  expect(changed.every(node => !old.some(previous => previous.key === node.key))).toBe(true);
  const partial = planDeadlineReminders({ ...input, rules, events: [{ ...event, deadline_at: now + 3 * 3600_000 }, { ...event, id: 2, status: 'pending_confirm' }] });
  expect(partial.nodes).toHaveLength(2);
  expect(partial.nodes[0]).toMatchObject({ kind: 'catchup', remind_at: now });
  expect(partial.unresolved).toEqual([{ event_id: 2, reason: 'time_unconfirmed' }]);
});
it('离线错过两个节点只补一次，持久确认覆盖原节点，重启不再补发；已截止不发', () => {
  const setup = { ...input, rules: { ...input.rules, enabled: true }, events: [{ ...event, deadline_at: now + 3600_000 }] };
  const first = planDeadlineReminders(setup);
  expect(first.nodes).toHaveLength(1);
  expect(first.nodes[0]).toMatchObject({ kind: 'catchup', covered_keys: expect.any(Array) });
  expect(first.nodes[0]!.covered_keys).toHaveLength(2);
  expect(planDeadlineReminders({ ...setup, now: now + 1000 }).nodes[0]!.key).toBe(first.nodes[0]!.key);
  expect(planDeadlineReminders({ ...setup, now: now + 1000, settledKeys: new Set(first.nodes[0]!.covered_keys) }).nodes).toHaveLength(0);
  expect(planDeadlineReminders({ ...setup, events: [{ ...event, deadline_at: now }] }).nodes).toHaveLength(0);
});
it('已正常发过的节点不补发，补发24小时节点后仍保留未来2小时节点', () => {
  const rules = { ...input.rules, enabled: true };
  const original = planDeadlineReminders({ ...input, rules });
  const later = { ...input, rules, now: deadline - 3 * 3600_000 };
  const withCatchup = planDeadlineReminders(later);
  expect(withCatchup.nodes.map(node => node.kind)).toEqual(['catchup', 'deadline']);
  expect(planDeadlineReminders({ ...later, settledKeys: new Set([original.nodes[0]!.key]) }).nodes.map(node => node.kind)).toEqual(['deadline']);
});
