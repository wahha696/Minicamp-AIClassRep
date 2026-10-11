import { db } from './db/index.js';
import { hasPendingEventProposals, proposalBaseStatus } from './event-proposals.js';
import type { EventStatus } from './types.js';

/** Caller owns the transaction. Remove only this group's provenance; an event
 * shared with another group keeps its ID, user state and remaining evidence.
 */
export function clearGroupEventData(groupId: string, markSeen: boolean): void {
  if (!db.isTransaction) throw new Error('GROUP_CLEAR_TRANSACTION_REQUIRED');
  const events = db.prepare(`SELECT id,group_id,status FROM events e WHERE group_id=? OR EXISTS
    (SELECT 1 FROM event_sources s WHERE s.event_id=e.id AND s.group_id=?)`).all(groupId, groupId) as {
      id: number; group_id: string; status: EventStatus;
    }[];
  for (const event of events) {
    const removed = db.prepare(`SELECT message_id,sent_at FROM event_sources
      WHERE event_id=? AND (group_id=? OR (group_id='' AND ?=?))`).all(event.id, groupId, event.group_id, groupId) as {
      message_id: string; sent_at: number;
    }[];
    const baseStatus = proposalBaseStatus(event.id, event.status);
    if (markSeen) {
      const seen = db.prepare('INSERT OR IGNORE INTO message_seen(group_id,message_id,sent_at) VALUES(?,?,?)');
      for (const source of removed) seen.run(groupId, source.message_id, source.sent_at);
    }
    const ids = JSON.stringify(removed.map(source => source.message_id));
    db.prepare(`DELETE FROM event_proposals WHERE event_id=? AND EXISTS
      (SELECT 1 FROM json_each(source_message_ids) p WHERE p.value IN (SELECT value FROM json_each(?)))`).run(event.id, ids);
    db.prepare('DELETE FROM event_history WHERE event_id=? AND source_message_id IN (SELECT value FROM json_each(?))').run(event.id, ids);
    db.prepare(`DELETE FROM event_sources WHERE event_id=? AND (group_id=? OR (group_id='' AND ?=?))`)
      .run(event.id, groupId, event.group_id, groupId);
    const remaining = db.prepare('SELECT group_id FROM event_sources WHERE event_id=? ORDER BY sent_at,message_id LIMIT 1').get(event.id) as { group_id: string } | undefined;
    if (!remaining) {
      db.prepare('DELETE FROM level_feedback WHERE event_id=?').run(event.id);
      db.prepare('DELETE FROM event_proposals WHERE event_id=?').run(event.id);
      db.prepare('DELETE FROM event_history WHERE event_id=?').run(event.id);
      db.prepare('DELETE FROM events WHERE id=?').run(event.id);
    } else {
      const owner = event.group_id === groupId ? remaining.group_id : event.group_id;
      if (!owner || owner === groupId) throw new Error('GROUP_CLEAR_PROVENANCE_INVALID');
      const status = event.status === 'pending_confirm' && !hasPendingEventProposals(event.id) ? baseStatus : event.status;
      db.prepare('UPDATE events SET group_id=?,status=?,updated_at=MAX(updated_at+1,?) WHERE id=?')
        .run(owner, status, Date.now(), event.id);
    }
  }
}
