import { db } from '../db/index.js';
import type { Message, SourceMessageDTO } from '../types.js';
import type { ExtractedEvent } from './extract.js';

export function messagePlatform(message: Message): NonNullable<SourceMessageDTO['platform']> {
  const source = db.prepare('SELECT source FROM messages WHERE group_id=? AND message_id=?').get(message.group_id, message.message_id)?.source;
  if (source === 'demo' || source === 'import') return source;
  if (source === 'wechat') return 'wechat';
  if (source === 'onebot' || source === 'history' || source === 'forward') return 'qq';
  if (source !== undefined) return 'unknown';
  return message.group_id.startsWith('wechat:') ? 'wechat' : /^\d+$/.test(message.group_id) ? 'qq' : 'unknown';
}

/** Only links a newly received create to an exact, unique opposite-platform
 * event. Does not merge two existing records or infer equivalence with AI.
 */
export function exactCrossPlatformTarget(groupId: string, event: ExtractedEvent, byId: Map<string, Message>): number | undefined {
  if (event.action !== 'create' || event.confidence < 0.6 || !event.title
    || (event.start_at === null && event.deadline_at === null)) return undefined;
  const messages = [...new Set(event.source_message_ids)].map(id => byId.get(id));
  if (!messages.length || messages.some(m => !m || m.group_id !== groupId || !m.text.trim())) return undefined;
  const incoming = messages as Message[];
  const platform = messagePlatform(incoming[0]!);
  if ((platform !== 'qq' && platform !== 'wechat') || incoming.some(m => messagePlatform(m) !== platform)) return undefined;
  const body = JSON.stringify([...incoming].sort((a, b) => a.sent_at - b.sent_at || a.message_id.localeCompare(b.message_id)).map(m => m.text));
  const fields = ['type', 'title', 'description', 'start_at', 'end_at', 'deadline_at', 'location', 'action_required'] as const;
  const candidates = db.prepare(`SELECT id FROM events e
    WHERE group_id <> ? AND status IN ('active','done','cancelled')
      AND ${fields.map(field => `${field} IS ?`).join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM event_proposals p WHERE p.event_id=e.id AND p.status='pending')`)
    .all(groupId, ...fields.map(field => event[field])) as { id: number }[];
  const matches: number[] = [];
  for (const candidate of candidates) {
    const sources = db.prepare('SELECT group_id, platform, message_id, text, sent_at FROM event_sources WHERE event_id=? ORDER BY sent_at,message_id')
      .all(candidate.id) as { group_id: string; platform: string; message_id: string; text: string; sent_at: number }[];
    // Unknown legacy provenance and multiple same-platform groups need a richer
    // matching decision. Fail closed instead of guessing or losing an ID collision.
    if (!sources.length || sources.some(source => !source.group_id
      || (source.platform !== 'qq' && source.platform !== 'wechat'))) continue;
    if (sources.some(source => source.platform === platform && source.group_id !== groupId)) continue;
    const opposite = sources.filter(source => source.platform !== platform);
    if (!opposite.length || new Set(opposite.map(source => source.group_id)).size !== 1) continue;
    if (incoming.some(message => sources.some(source => source.message_id === message.message_id && source.group_id !== groupId))) continue;
    if (JSON.stringify(opposite.map(source => source.text)) === body) matches.push(candidate.id);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
