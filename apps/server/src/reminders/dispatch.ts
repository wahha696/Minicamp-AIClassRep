import { db, dbGeneration } from '../db/index.js';
import type { ReminderRules } from '../../../../shared/reminders.js';
import { validReminderRules } from '../../../../shared/reminders.js';
import { groupReminderNodes, planDeadlineReminders } from './plan.js';
import { ReminderOutbox } from './outbox.js';

export interface ReminderCard {
  title: string;
  items: { event_id: number; title: string; deadline_at: number; group_names: string[]; summary: string }[];
}
type ChannelResult = { state: 'accepted'; receipt: string } | { state: 'failed' } | { state: 'unknown' };
interface Options {
  spaceId: string;
  targetId: string;
  /** Must prove current space, receiver binding and user-enabled preference. */
  current(): boolean;
  rules(): ReminderRules;
  /** Injected server-side only; never a browser/global developer token. */
  send(card: ReminderCard): Promise<ChannelResult>;
}
interface Result { attempted: number; blocked: 'disabled' | 'not_current' | 'quota' | 'in_flight' | null }
const clip = (value: string, maximum: number) => {
  const characters = Array.from(value); return characters.length <= maximum ? value : characters.slice(0, maximum - 1).join('') + '…';
};

/** Channel-independent, explicit single pass. No timer, network implementation,
 * constructor I/O or production route. The binding/channel owner supplies send.
 */
export class ReminderDispatcher {
  private running = false;
  constructor(private readonly options: Options) {}
  async run(input: { now: number; budgetDay: string }): Promise<Result> {
    if (this.running) return { attempted: 0, blocked: 'in_flight' };
    this.running = true;
    let attempted = 0;
    try {
      const target = db; const generation = dbGeneration();
      const current = () => db === target && dbGeneration() === generation && target?.isOpen && this.options.current();
      if (!current()) return { attempted, blocked: 'not_current' };
      const rules = this.options.rules();
      if (!validReminderRules(rules)) throw new Error('REMINDER_SETTINGS_INVALID');
      if (!rules.enabled) return { attempted, blocked: 'disabled' };
      const outbox = new ReminderOutbox(this.options.spaceId, this.options.targetId);
      const events = target.prepare('SELECT id,version,status,deadline_at FROM events WHERE deadline_at IS NOT NULL').all() as {
        id: number; version: number; status: 'active' | 'pending_confirm' | 'done' | 'cancelled'; deadline_at: number;
      }[];
      const plan = planDeadlineReminders({ ...this.options, now: input.now, rules, events, settledKeys: outbox.settledKeys() });
      for (const group of groupReminderNodes(plan.nodes.filter(node => node.remind_at <= input.now))) {
        if (!current()) return { attempted, blocked: 'not_current' };
        const liveRules = this.options.rules();
        if (!validReminderRules(liveRules)) throw new Error('REMINDER_SETTINGS_INVALID');
        if (!liveRules.enabled) return { attempted, blocked: 'disabled' };
        // A setting changed during a previous asynchronous send: rebuild next
        // pass rather than send a node the user just removed from their rules.
        if (JSON.stringify([...liveRules.before_minutes].sort((a, b) => a - b)) !== JSON.stringify([...rules.before_minutes].sort((a, b) => a - b))) return { attempted, blocked: null };
        const card: ReminderCard = { title: group.nodes.length === 1 ? '截止提醒' : `${group.nodes.length} 件事项截止提醒`, items: [] };
        for (const node of group.nodes) {
          const event = target.prepare('SELECT title,description,group_id FROM events WHERE id=?').get(node.event_id);
          if (!event) continue; // reserve() below rejects missing/stale events.
          const names = target.prepare(`SELECT name FROM groups WHERE group_id=? UNION
            SELECT group_name AS name FROM event_sources WHERE event_id=? AND group_name<>''`).all(event.group_id!, node.event_id);
          card.items.push({ event_id: node.event_id, title: clip(String(event.title), 120), deadline_at: node.deadline_at,
            group_names: names.map(row => clip(String(row.name), 100)), summary: clip(String(event.description), 240) });
        }
        const reservation = outbox.reserve(group.nodes, { ...input, dailyLimit: liveRules.daily_limit });
        if (reservation.status === 'quota') return { attempted, blocked: 'quota' };
        if (reservation.status !== 'reserved') continue;
        // No awaits between fresh user/binding check, atomic reservation and
        // invoking the transport. A request already in flight cannot be recalled.
        attempted++;
        let result: ChannelResult;
        try { result = await this.options.send(card); }
        catch { result = { state: 'unknown' }; }
        if (!current()) return { attempted, blocked: 'not_current' };
        if (result?.state === 'accepted' && typeof result.receipt === 'string' && result.receipt.length > 0 && result.receipt.length <= 512) {
          outbox.recordOutcome(reservation.attempt.id, 'accepted', result.receipt);
        } else outbox.recordOutcome(reservation.attempt.id, result?.state === 'failed' ? 'failed' : 'unknown', null);
      }
      return { attempted, blocked: null };
    } finally { this.running = false; }
  }
}

/** Escape synthetic or AI-derived text before using a channel HTML template. */
export function reminderCardHtml(card: ReminderCard, formatTime: (timestamp: number) => string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return card.items.map(item => `<h3>${escape(item.title)}</h3><p>截止：${escape(formatTime(item.deadline_at))}</p>`
    + `<p>来源群：${item.group_names.map(escape).join('、')}</p><p>${escape(item.summary)}</p>`).join('<hr>');
}
