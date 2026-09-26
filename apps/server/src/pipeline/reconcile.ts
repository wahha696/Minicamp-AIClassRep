// 事件合并（FR-6）：把 extract 的结果写进 events / event_sources / event_history。
// 一批在一个事务里完成；改期只覆盖真正变了的字段，每次变化都留一条 history，来源存快照。
import { db } from '../db/index.js';
import type { EventStatus, EventType, Message } from '../types.js';
import type { ActiveEventBrief, ExtractedEvent } from './extract.js';

interface EventRow {
  id: number;
  group_id: string;
  type: EventType;
  title: string;
  description: string;
  start_at: number | null;
  end_at: number | null;
  deadline_at: number | null;
  location: string | null;
  action_required: string | null;
  status: EventStatus;
  confidence: number;
  level: number;
  level_locked: number;
  version: number;
}

/** 还能被改期 / 取消的状态。pending_confirm 也算，否则低置信度事件的后续改动会变成新事件。 */
export const LIVE_STATUSES: readonly EventStatus[] = ['active', 'pending_confirm'];
const LIVE_SQL = `status IN (${LIVE_STATUSES.map((s) => `'${s}'`).join(',')})`;

/** update 时允许覆盖的字段。type 不改（LLM 对同一件事偶尔换分类），confidence 保持首次的值。 */
const UPDATABLE = [
  'title',
  'description',
  'start_at',
  'end_at',
  'deadline_at',
  'location',
  'action_required',
] as const;

const FUZZY_THRESHOLD = 0.6;
const PENDING_BELOW = 0.6;
const ACTIVE_WINDOW = 14 * 86400_000;

// ---------- 标题相似度（FR-6.1 兜底） ----------

function bigrams(title: string): Set<string> {
  const chars = [...title.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')];
  if (chars.length < 2) return new Set(chars);
  const out = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

/** 标题字符二元组的 Jaccard 相似度，0~1 */
export function titleSimilarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

// ---------- SQL ----------

const q = {
  byId: () => db.prepare(`SELECT * FROM events WHERE id = ? AND group_id = ? AND ${LIVE_SQL}`),
  sameType: () => db.prepare(`SELECT * FROM events WHERE group_id = ? AND type = ? AND ${LIVE_SQL}`),
  insert: () =>
    db.prepare(
      `INSERT INTO events (group_id, type, title, description, start_at, end_at, deadline_at,
         location, action_required, status, confidence, level, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ),
  source: () =>
    db.prepare(
      `INSERT OR IGNORE INTO event_sources (event_id, message_id, sender_name, text, sent_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
  history: () =>
    db.prepare(
      `INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
};

function findTarget(groupId: string, ev: ExtractedEvent): EventRow | undefined {
  if (ev.update_of != null) {
    const row = q.byId().get(ev.update_of, groupId) as EventRow | undefined;
    if (row) return row;
  }
  if (!ev.title) return undefined;
  // update_of 没给或无效：同群、同 type、还活着、标题足够像 → 视为同一件事
  let best: EventRow | undefined;
  let bestScore = FUZZY_THRESHOLD;
  for (const row of q.sameType().all(groupId, ev.type) as unknown as EventRow[]) {
    const s = titleSimilarity(row.title, ev.title);
    if (s > bestScore) [best, bestScore] = [row, s];
  }
  return best;
}

function addSources(eventId: number, ids: string[], byId: Map<string, Message>): void {
  const stmt = q.source();
  for (const id of ids) {
    const m = byId.get(id);
    if (m) stmt.run(eventId, m.message_id, m.sender_name, m.text, m.sent_at);
  }
}

function writeChange(
  row: EventRow,
  changes: Record<string, { from: unknown; to: unknown }>,
  sourceId: string | null,
  now: number,
): void {
  const fields = Object.keys(changes);
  const version = row.version + 1;
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE events SET ${sets}, version = ?, updated_at = ? WHERE id = ?`).run(
    ...fields.map((f) => changes[f]!.to as string | number | null),
    version,
    now,
    row.id,
  );
  q.history().run(row.id, version, JSON.stringify(changes), sourceId, now);
}

function applyOne(groupId: string, ev: ExtractedEvent, byId: Map<string, Message>, now: number): void {
  const target = findTarget(groupId, ev);
  const sourceId = ev.source_message_ids[0] ?? null;

  if (ev.action === 'cancel') {
    if (!target) {
      console.warn(`[reconcile] 取消找不到对应事件，忽略：${ev.title || `#${ev.update_of}`}`);
      return;
    }
    writeChange(target, { status: { from: target.status, to: 'cancelled' } }, sourceId, now);
    addSources(target.id, ev.source_message_ids, byId);
    return;
  }

  if (target) {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const f of UPDATABLE) {
      const to = ev[f];
      if (to == null || to === '' || to === target[f]) continue;
      changes[f] = { from: target[f], to };
    }
    // 用户手动锁过的等级，AI 更新不覆盖（FR-12：手动调级锁定）
    if (ev.level !== null && target.level_locked === 0 && ev.level !== target.level) {
      changes.level = { from: target.level, to: ev.level };
    }
    if (Object.keys(changes).length) writeChange(target, changes, sourceId, now);
    addSources(target.id, ev.source_message_ids, byId);
    return;
  }

  if (!ev.title) {
    console.warn(`[reconcile] ${ev.action} 找不到对应事件且没有标题，忽略：#${ev.update_of}`);
    return;
  }
  const status: EventStatus = ev.confidence < PENDING_BELOW ? 'pending_confirm' : 'active';
  const { lastInsertRowid } = q.insert().run(
    groupId,
    ev.type,
    ev.title,
    ev.description,
    ev.start_at,
    ev.end_at,
    ev.deadline_at,
    ev.location,
    ev.action_required,
    status,
    ev.confidence,
    ev.level ?? 2,
    now,
    now,
  );
  addSources(Number(lastInsertRowid), ev.source_message_ids, byId);
}

/**
 * 给 LLM 看的已有事件：该群还活着的、时间在 14 天内或之后的（没有时间的按最后更新时间算）。
 */
export function listActiveEvents(groupId: string, now = Date.now()): ActiveEventBrief[] {
  return db
    .prepare(
      `SELECT id, type, title, start_at, end_at, deadline_at, location, action_required, level FROM events
       WHERE group_id = ? AND ${LIVE_SQL}
         AND COALESCE(end_at, start_at, deadline_at, updated_at) >= ?
       ORDER BY id`,
    )
    .all(groupId, now - ACTIVE_WINDOW) as unknown as ActiveEventBrief[];
}

/**
 * 在一个事务里应用一批提取结果。
 * sourceMsgs：本批的候选消息，用来给 event_sources 存快照（source_message_ids 已在 extract 里过滤过）。
 */
export function applyEvents(groupId: string, extracted: ExtractedEvent[], sourceMsgs: Message[]): void {
  if (extracted.length === 0) return;
  const byId = new Map(sourceMsgs.map((m) => [m.message_id, m]));
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const ev of extracted) applyOne(groupId, ev, byId, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
