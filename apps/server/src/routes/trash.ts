// 回收站（设置页「回收站」一栏）：从日历上消失、可以一键恢复的东西。
// 1. 被取消的事件：自己在详情里点「取消」的（history 里 source_message_id 为 NULL）+ 群消息取消的；
//    恢复 = 状态改回取消前的样子（没有记录就回 active）。
// 2. 群消息改期 / 改地点 / 改标题前的旧版本（event_history 里有来源消息、改了 RESTORABLE 字段的那条）；
//    恢复 = 把还在生效的字段改回 from。恢复过的、被之后的群消息又改掉的不再列出（见 pendingRevert）。
// 只列最近 30 天的（按取消 / 改动时间算），过期的只是不显示，库里的数据不删。
// 恢复都算「手动调整」：写一条 source_message_id 为 NULL 的 history，不升 version（同手动调级的约定）。
import type { Hono } from 'hono';
import { db } from '../db/index.js';
import { parseLockedFields } from '../event-proposals.js';
import type { EventDTO, EventStatus, EventType, Level, TrashItemDTO } from '../types.js';

export const TRASH_KEEP_MS = 30 * 86400_000;

/** 改动里这些字段变了，旧版本才算「从日历上消失」 */
const VANISH_FIELDS = ['start_at', 'end_at', 'deadline_at', 'location', 'title'] as const;
/** 恢复旧版本时会改回去的字段（同 reconcile.ts 的 UPDATABLE；level / status 不跟着回退） */
const RESTORABLE = [
  'title',
  'description',
  'start_at',
  'end_at',
  'deadline_at',
  'location',
  'action_required',
] as const;
type RestorableField = (typeof RESTORABLE)[number];

/** 取消前是这些状态才原样恢复，其余一律回 active */
const RESTORE_STATUSES: readonly EventStatus[] = ['active', 'pending_confirm', 'done'];

type Changes = Record<string, { from: unknown; to: unknown }>;

interface EventRow {
  id: number;
  group_id: string;
  group_name: string | null;
  type: string;
  title: string;
  description: string;
  start_at: number | null;
  end_at: number | null;
  deadline_at: number | null;
  location: string | null;
  action_required: string | null;
  status: string;
  confidence: number;
  level: number;
  level_locked: number;
  manual_locked_fields: string;
  version: number;
  created_at: number;
  updated_at: number;
}

const EVENT_COLUMNS = `
  e.id, e.group_id, g.name AS group_name, e.type, e.title, e.description,
  e.start_at, e.end_at, e.deadline_at, e.location, e.action_required,
  e.status, e.confidence, e.level, e.level_locked, e.manual_locked_fields,
  e.version, e.created_at, e.updated_at
`;
const EVENT_FROM = 'FROM events e LEFT JOIN groups g ON g.group_id = e.group_id';

function toEventDTO(row: EventRow): EventDTO {
  return {
    id: row.id,
    group_id: row.group_id,
    group_name: row.group_name ?? '',
    type: row.type as EventType,
    title: row.title,
    description: row.description,
    start_at: row.start_at,
    end_at: row.end_at,
    deadline_at: row.deadline_at,
    location: row.location,
    action_required: row.action_required,
    status: row.status as EventStatus,
    confidence: row.confidence,
    level: row.level as Level,
    level_locked: row.level_locked !== 0,
    manual_locked_fields: parseLockedFields(row.manual_locked_fields),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseChanges(raw: string): Changes {
  try {
    const v: unknown = JSON.parse(raw);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Changes;
  } catch {
    // 坏数据当没改动
  }
  return {};
}

interface HistoryRow {
  id: number;
  event_id: number;
  changed_fields: string;
  source_message_id: string | null;
  changed_at: number;
}

function sourceText(eventId: number, messageId: string | null): string | null {
  if (messageId === null) return null;
  const row = db
    .prepare('SELECT text FROM event_sources WHERE event_id = ? AND message_id = ?')
    .get(eventId, messageId) as { text: string } | undefined;
  return row?.text ?? null;
}

/** 最近一次「改成 cancelled」的 history（可能没有：老数据手动取消不写 history） */
function lastCancelRow(eventId: number): HistoryRow | undefined {
  return db
    .prepare(
      `SELECT id, event_id, changed_fields, source_message_id, changed_at FROM event_history
       WHERE event_id = ? AND json_extract(changed_fields, '$.status.to') = 'cancelled'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(eventId) as unknown as HistoryRow | undefined;
}

/**
 * 这次改动里「还在生效」的字段 → 要改回的旧值。
 * 还在生效 = 事件现在的值等于这次改成的 to。恢复过的、被之后的群消息又改掉的字段都不算，
 * 这样同一个字段只有最近那次改动在回收站里，恢复一次退一步（像撤销）。
 */
function pendingRevert(event: EventRow, changes: Changes): Partial<Record<RestorableField, unknown>> {
  const out: Partial<Record<RestorableField, unknown>> = {};
  for (const f of RESTORABLE) {
    const c = changes[f];
    if (c === undefined) continue;
    const from = c.from ?? null;
    const to = c.to ?? null;
    if (to === event[f] && from !== to) out[f] = from;
  }
  return out;
}

function cancelledItem(row: EventRow, now: number): TrashItemDTO | null {
  const h = lastCancelRow(row.id);
  // “拒绝低置信度新增”只是确认这件事本来就不该进入日历，不是用户误删，不能伪装成可恢复的取消项。
  const rejectedCreate = db.prepare(
    `SELECT resolved_at FROM event_proposals
      WHERE event_id = ? AND kind = 'create' AND status = 'rejected'
      ORDER BY resolved_at DESC, id DESC LIMIT 1`,
  ).get(row.id) as { resolved_at: number | null } | undefined;
  if (h !== undefined && rejectedCreate?.resolved_at === h.changed_at) return null;
  const at = h?.changed_at ?? row.updated_at;
  if (at < now - TRASH_KEEP_MS) return null;
  const from = h ? parseChanges(h.changed_fields)['status']?.from : undefined;
  return {
    id: `cancel-${row.id}`,
    kind: 'cancelled',
    by: h?.source_message_id ? 'group' : 'manual',
    event: toEventDTO(row),
    changes: { status: { from: from ?? 'active', to: 'cancelled' } },
    source_text: sourceText(row.id, h?.source_message_id ?? null),
    at,
    expires_at: at + TRASH_KEEP_MS,
  };
}

function changedItem(h: HistoryRow, row: EventRow, now: number): TrashItemDTO | null {
  if (row.status === 'cancelled' || h.source_message_id === null) return null;
  if (h.changed_at < now - TRASH_KEEP_MS) return null;
  const changes = parseChanges(h.changed_fields);
  const revert = pendingRevert(row, changes);
  if (!VANISH_FIELDS.some((f) => f in revert)) return null;
  const shown: Changes = {};
  for (const f of RESTORABLE) if (f in revert) shown[f] = changes[f]!;
  return {
    id: `change-${h.id}`,
    kind: 'changed',
    by: 'group',
    event: toEventDTO(row),
    changes: shown,
    source_text: sourceText(row.id, h.source_message_id),
    at: h.changed_at,
    expires_at: h.changed_at + TRASH_KEEP_MS,
  };
}

function getEventRow(id: number): EventRow | undefined {
  return db.prepare(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = ?`).get(id) as unknown as
    | EventRow
    | undefined;
}

/** 回收站列表：最近 30 天，按时间倒序（最新的在最上面） */
export function listTrash(now: number = Date.now()): TrashItemDTO[] {
  const items: TrashItemDTO[] = [];

  const cancelled = db
    .prepare(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.status = 'cancelled'`)
    .all() as unknown as EventRow[];
  for (const row of cancelled) {
    const item = cancelledItem(row, now);
    if (item) items.push(item);
  }

  const history = db
    .prepare(
      `SELECT id, event_id, changed_fields, source_message_id, changed_at FROM event_history
       WHERE source_message_id IS NOT NULL AND changed_at >= ?`,
    )
    .all(now - TRASH_KEEP_MS) as unknown as HistoryRow[];
  const rows = new Map<number, EventRow | undefined>();
  for (const h of history) {
    if (!rows.has(h.event_id)) rows.set(h.event_id, getEventRow(h.event_id));
    const row = rows.get(h.event_id);
    if (!row) continue;
    const item = changedItem(h, row, now);
    if (item) items.push(item);
  }

  return items.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}

class RestoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

function writeManualHistory(row: EventRow, changes: Changes, now: number): void {
  db.prepare(
    `INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(row.id, row.version, JSON.stringify(changes), now);
}

function restoreCancelled(eventId: number, now: number): void {
  const row = getEventRow(eventId);
  if (!row) throw new RestoreError('事件不存在', 404);
  const item = cancelledItem(row, now);
  if (row.status !== 'cancelled' || !item) throw new RestoreError('这条已经不在回收站里了', 409);
  const prev = item.changes['status']?.from;
  const to: EventStatus = RESTORE_STATUSES.includes(prev as EventStatus) ? (prev as EventStatus) : 'active';
  db.prepare('UPDATE events SET status = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(to, now, row.id);
  writeManualHistory(row, { status: { from: 'cancelled', to } }, now);
}

function restoreChanged(historyId: number, now: number): void {
  const h = db
    .prepare(
      'SELECT id, event_id, changed_fields, source_message_id, changed_at FROM event_history WHERE id = ?',
    )
    .get(historyId) as unknown as HistoryRow | undefined;
  const row = h ? getEventRow(h.event_id) : undefined;
  if (!h || !row) throw new RestoreError('记录不存在', 404);
  if (!changedItem(h, row, now)) throw new RestoreError('这条已经不在回收站里了', 409);

  const revert = pendingRevert(row, parseChanges(h.changed_fields));
  const fields = Object.keys(revert) as RestorableField[];
  const sets = fields.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE events SET ${sets}, updated_at = MAX(updated_at + 1, ?) WHERE id = ?`).run(
    ...fields.map((f) => revert[f] as string | number | null),
    now,
    row.id,
  );
  const changes: Changes = {};
  for (const f of fields) changes[f] = { from: row[f], to: revert[f] };
  writeManualHistory(row, changes, now);
}

/** 恢复一项。id 为 'cancel-<事件 id>' 或 'change-<history id>' */
export function restoreTrash(id: string, now: number = Date.now()): void {
  const m = /^(cancel|change)-([1-9]\d{0,15})$/.exec(id);
  if (!m) throw new RestoreError('回收站条目 id 不合法', 400);
  const n = Number(m[2]);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (m[1] === 'cancel') restoreCancelled(n, now);
    else restoreChanged(n, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function registerTrashRoutes(app: Hono): void {
  app.get('/api/trash', (c) => c.json(listTrash()));

  // 恢复后返回最新的回收站列表
  app.post('/api/trash/:id/restore', (c) => {
    try {
      restoreTrash(c.req.param('id'));
    } catch (err) {
      if (err instanceof RestoreError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    return c.json(listTrash());
  });
}
