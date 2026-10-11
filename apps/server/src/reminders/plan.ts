import { createHash } from 'node:crypto';
import { validReminderRules, type ReminderRules } from '../../../../shared/reminders.js';
import type { EventDTO } from '../types.js';

export interface ReminderNode {
  space_id: string;
  target_id: string;
  key: string;
  event_id: number;
  event_version: number;
  deadline_at: number;
  remind_at: number;
  before_minutes: number | null;
  kind: 'deadline' | 'catchup';
  /** Mark these original nodes settled after a successful/uncertain send. */
  covered_keys: string[];
}
export interface ReminderPreview {
  nodes: ReminderNode[];
  unresolved: { event_id: number; reason: 'time_unconfirmed' | 'invalid_time' }[];
}

/** Pure local planning, never sends. Missed unsettled nodes collapse into one
 * catch-up per event while its deadline is still in the future. Rebuilding removes obsolete
 * versions, completed/cancelled items and old deadlines from the returned plan.
 */
export function planDeadlineReminders(input: {
  spaceId: string; targetId: string; rules: ReminderRules;
  events: Pick<EventDTO, 'id' | 'version' | 'deadline_at' | 'status'>[]; now: number;
  settledKeys?: ReadonlySet<string>;
}): ReminderPreview {
  const { rules, events, now } = input;
  if (!validReminderRules(rules) || !Number.isSafeInteger(now) || !input.spaceId || !input.targetId) throw new Error('REMINDER_PLAN_INVALID');
  const result: ReminderPreview = { nodes: [], unresolved: [] };
  if (!rules.enabled) return result;
  const keys = new Set<string>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.id) || event.id <= 0 || !Number.isSafeInteger(event.version) || event.version <= 0) throw new Error('REMINDER_EVENT_INVALID');
    if (event.status === 'done' || event.status === 'cancelled' || event.deadline_at === null) continue;
    if (!Number.isSafeInteger(event.deadline_at) || event.deadline_at < 0) {
      result.unresolved.push({ event_id: event.id, reason: 'invalid_time' }); continue;
    }
    if (event.status !== 'active') {
      result.unresolved.push({ event_id: event.id, reason: 'time_unconfirmed' }); continue;
    }
    if (event.deadline_at <= now) continue;
    const due: ReminderNode[] = [];
    for (const before of rules.before_minutes) {
      const remindAt = event.deadline_at - before * 60_000;
      if (!Number.isSafeInteger(remindAt)) throw new Error('REMINDER_PLAN_INVALID');
      const key = createHash('sha256').update(JSON.stringify([
        input.spaceId, input.targetId, event.id, event.version, event.deadline_at, before,
      ])).digest('hex');
      if (keys.has(key) || input.settledKeys?.has(key)) continue;
      keys.add(key);
      const node: ReminderNode = { key, space_id: input.spaceId, target_id: input.targetId, event_id: event.id, event_version: event.version,
        deadline_at: event.deadline_at, remind_at: remindAt, before_minutes: before, kind: 'deadline', covered_keys: [key] };
      if (remindAt <= now) due.push(node);
      else result.nodes.push(node);
    }
    if (due.length === 1 && due[0]!.remind_at === now) result.nodes.push(due[0]!);
    else if (due.length) {
      const covered = due.map(node => node.key).sort();
      result.nodes.push({ ...due[0]!, remind_at: now, before_minutes: null, kind: 'catchup', covered_keys: covered,
        key: createHash('sha256').update(JSON.stringify(['catchup', covered])).digest('hex') });
    }
  }
  result.nodes.sort((a, b) => a.remind_at - b.remind_at || a.event_id - b.event_id);
  return result;
}

/** No time rounding, delay or cross-user/space aggregation, even with mixed input. */
export function groupReminderNodes(nodes: ReminderNode[]): { space_id: string; target_id: string; remind_at: number; nodes: ReminderNode[] }[] {
  const byTime = new Map<string, ReminderNode[]>();
  for (const node of nodes) {
    const bucket = JSON.stringify([node.space_id, node.target_id, node.remind_at]);
    const group = byTime.get(bucket) ?? [];
    if (!group.some(previous => previous.key === node.key)) group.push(node);
    byTime.set(bucket, group);
  }
  return [...byTime.values()].map(group => ({ space_id: group[0]!.space_id, target_id: group[0]!.target_id,
    remind_at: group[0]!.remind_at, nodes: group })).sort((a, b) => a.remind_at - b.remind_at);
}
