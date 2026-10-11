import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from './db/index.js';
import { ASSISTANT_EVENT_TYPES, type AssistantMemoryRule, type AssistantMemoryState,
  type AssistantSuppressionDetail } from '../../../shared/assistant-memory.js';
import type { ExtractedEvent } from './pipeline/extract.js';
import type { Message } from './types.js';

export const assistantMemorySchema = z.object({
  text: z.string().trim().min(1).max(500),
  action: z.enum(['exclude_calendar', 'note']),
  course: z.string().trim().max(100).default(''),
  event_types: z.array(z.enum(ASSISTANT_EVENT_TYPES)).max(6).default([]),
  enabled: z.boolean().default(true),
}).strict().superRefine((v, ctx) => {
  if (v.action === 'exclude_calendar' && (!v.course || !v.event_types.length)) {
    ctx.addIssue({ code: 'custom', message: '排除日程规则必须指定课程和事项类型，不能排除全部通知' });
  }
});
type Row = Omit<AssistantMemoryRule, 'enabled' | 'event_types'> & { enabled: number; event_types: string };
const fromRow = (row: Row): AssistantMemoryRule => ({ ...row, enabled: !!row.enabled, event_types: JSON.parse(row.event_types) });
export function listAssistantMemories(): AssistantMemoryRule[] {
  return (db.prepare('SELECT * FROM assistant_memories ORDER BY id').all() as unknown as Row[]).map(fromRow);
}
export function saveAssistantMemory(raw: unknown, id?: number): AssistantMemoryRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('偏好格式不正确');
  const old = id === undefined ? undefined : listAssistantMemories().find(r => r.id === id);
  if (id !== undefined && !old) throw new Error('偏好不存在');
  const { id: _id, created_at: _created, updated_at: _updated, ...previous } = old ?? {};
  const value = assistantMemorySchema.parse(id === undefined ? raw : { ...previous, ...(raw as object) });
  const now = Date.now();
  if (id === undefined) {
    if (listAssistantMemories().length >= 100) throw new Error('最多保存 100 条偏好，请先整理已有规则');
    id = Number(db.prepare('INSERT INTO assistant_memories(text,action,course,event_types,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(value.text, value.action, value.course, JSON.stringify([...new Set(value.event_types)]), +value.enabled, now, now).lastInsertRowid);
  } else {
    db.prepare('UPDATE assistant_memories SET text=?,action=?,course=?,event_types=?,enabled=?,updated_at=? WHERE id=?')
      .run(value.text, value.action, value.course, JSON.stringify([...new Set(value.event_types)]), +value.enabled, now, id);
  }
  return listAssistantMemories().find(r => r.id === id)!;
}
export function deleteAssistantMemory(id: number): boolean {
  return Number(db.prepare('DELETE FROM assistant_memories WHERE id=?').run(id).changes) > 0;
}
type SuppressionRow = { id: number; rule_id: number; title: string; course: string; sources: string; created_at: number };
function suppression(row: SuppressionRow): AssistantSuppressionDetail {
  const sources = JSON.parse(row.sources) as AssistantSuppressionDetail['sources'];
  return { id: row.id, rule_id: row.rule_id, title: row.title, course: row.course, source_count: sources.length, created_at: row.created_at, sources };
}
export function assistantMemoryState(): AssistantMemoryState {
  const records = db.prepare('SELECT id,rule_id,title,course,sources,created_at FROM assistant_suppressions ORDER BY id DESC LIMIT 50').all() as unknown as SuppressionRow[];
  return { scope: 'current_space', rules: listAssistantMemories(), recent_suppressions: records.map(row => {
    const { sources: _, ...summary } = suppression(row); return summary;
  }) };
}
export function assistantSuppression(id: number): AssistantSuppressionDetail | null {
  const row = db.prepare('SELECT id,rule_id,title,course,sources,created_at FROM assistant_suppressions WHERE id=?').get(id) as SuppressionRow | undefined;
  return row ? suppression(row) : null;
}
const normalized = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, '');
/** Only explicit enabled rules affect new calendar candidates. Existing events,
 * their updates/cancellations, unrelated types and source messages are untouched. */
export function applyAssistantMemoryRules(groupId: string, events: ExtractedEvent[], messages: Message[]): ExtractedEvent[] {
  const rules = listAssistantMemories().filter(r => r.enabled && r.action === 'exclude_calendar');
  if (!rules.length) return events;
  const group = db.prepare('SELECT course_name FROM groups WHERE group_id=?').get(groupId) as { course_name: string | null } | undefined;
  const boundCourse = group?.course_name?.trim();
  return events.filter(event => {
    if (event.action !== 'create') return true;
    // A title is not reliable course identity (e.g. physics vs physical chemistry).
    const rule = rules.find(r => r.event_types.includes(event.type) && boundCourse
      && normalized(boundCourse) === normalized(r.course));
    if (!rule) return true;
    const sourceIds = new Set(event.source_message_ids);
    const sources = messages.filter(m => m.group_id === groupId && sourceIds.has(m.message_id));
    // An unverifiable candidate must not disappear under a preference rule.
    if (!sources.length || sources.length !== sourceIds.size) return true;
    const key = createHash('sha256').update(JSON.stringify([groupId, rule.id, event.type, event.title, [...sourceIds].sort()])).digest('hex');
    db.prepare('INSERT OR IGNORE INTO assistant_suppressions(dedupe_key,rule_id,group_id,title,course,sources,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(key, rule.id, groupId, event.title, boundCourse || rule.course, JSON.stringify(sources), Date.now());
    return false;
  });
}
