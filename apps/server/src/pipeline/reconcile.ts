// 事件合并（FR-6）：把 extract 的结果写进 events / event_sources / event_history。
// 一批在一个事务里完成；改期只覆盖真正变了的字段，每次变化都留一条 history，来源存快照。
import { db } from '../db/index.js';
import {
  createEventProposal,
  EDITABLE_EVENT_FIELDS,
  hasAnyEventProposalForSource,
  hasEventProposalForSource,
  hasGroupCreateProposalForEventSource,
  hasGroupCreateProposalForSparseSource,
  hasGroupCreateProposalForSource,
  hasPendingEventProposals,
  parseLockedFields,
  proposalBaseStatus,
  supersedePendingProposals,
  supersedePendingProposalFields,
  type CreateProposalFingerprint,
  type ProposedChanges,
} from '../event-proposals.js';
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
  manual_locked_fields: string;
  version: number;
}

/** 还能被改期 / 取消的状态。pending_confirm 也算，否则低置信度事件的后续改动会变成新事件。 */
export const LIVE_STATUSES: readonly EventStatus[] = ['active', 'pending_confirm'];
const LIVE_SQL = `status IN (${LIVE_STATUSES.map((s) => `'${s}'`).join(',')})`;

/** update 时允许覆盖的字段。type 不改（LLM 对同一件事偶尔换分类），confidence 保持首次的值。 */
const UPDATABLE = EDITABLE_EVENT_FIELDS;

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

/** create 走模糊匹配、且新消息比目标事件的来源还早（历史补齐）时，两边的关键时间要在这个范围内才算同一件事 */
const FUZZY_CREATE_TIME_TOLERANCE = 86400_000;

const keyTime = (e: { start_at: number | null; deadline_at: number | null }) => e.start_at ?? e.deadline_at;

function findTarget(groupId: string, ev: ExtractedEvent, byId: Map<string, Message>): EventRow | undefined {
  if (ev.update_of != null) {
    const row = q.byId().get(ev.update_of, groupId) as EventRow | undefined;
    if (row) return row;
  }
  if (!ev.title) return undefined;
  // update_of 没给或无效：同群、同 type、还活着、标题足够像 → 视为同一件事。
  // 例外：补拉回来的旧消息说「create」，而同名事件是更晚的消息建的、时间差超过 1 天 → 是另一件事
  // （比如旧消息「周三开会」与新消息「周四开会」），不能合并，否则会把新事件的时间改回旧的。
  const evTime = keyTime(ev);
  let best: EventRow | undefined;
  let bestScore = FUZZY_THRESHOLD;
  for (const row of q.sameType().all(groupId, ev.type) as unknown as EventRow[]) {
    if (ev.action === 'create') {
      const rowTime = keyTime(row);
      if (
        evTime !== null &&
        rowTime !== null &&
        Math.abs(evTime - rowTime) > FUZZY_CREATE_TIME_TOLERANCE &&
        isStale(row.id, ev.source_message_ids, byId)
      ) {
        continue;
      }
    }
    const s = titleSimilarity(row.title, ev.title);
    if (s > bestScore) [best, bestScore] = [row, s];
  }
  return best;
}

function isStale(eventId: number, ids: string[], byId: Map<string, Message>): boolean {
  const times = ids.map((id) => byId.get(id)?.sent_at).filter((t): t is number => t !== undefined);
  if (times.length === 0) return false;
  const row = db.prepare('SELECT MAX(sent_at) AS latest FROM event_sources WHERE event_id = ?').get(eventId) as
    | { latest: number | null }
    | undefined;
  const latest = row?.latest ?? null;
  return latest !== null && Math.max(...times) < latest;
}

function addSources(eventId: number, ids: string[], byId: Map<string, Message>): void {
  const stmt = q.source();
  for (const id of ids) {
    const m = byId.get(id);
    if (m) stmt.run(eventId, m.message_id, m.sender_name, m.text, m.sent_at);
  }
}

/** 同一事件已经完整消费过这组来源时，动作分类即使重跑成 update/cancel 也必须幂等。 */
function hasAppliedSources(eventId: number, ids: string[]): boolean {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return false;
  const row = db.prepare(
    `SELECT COUNT(DISTINCT message_id) AS n FROM event_sources
      WHERE event_id = ? AND message_id IN (SELECT value FROM json_each(?))`,
  ).get(eventId, JSON.stringify(unique)) as { n: number };
  return row.n === unique.length || hasAnyEventProposalForSource(eventId, unique);
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
  db.prepare(`UPDATE events SET ${sets}, version = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?`).run(
    ...fields.map((f) => changes[f]!.to as string | number | null),
    version,
    now,
    row.id,
  );
  q.history().run(row.id, version, JSON.stringify(changes), sourceId, now);
}

function sparseCreateFingerprintConstraints(ev: ExtractedEvent): Partial<CreateProposalFingerprint> {
  const constraints: Partial<CreateProposalFingerprint> = {};
  // type 是 ExtractedEvent 的必填非空字段；其余字段遵循 update/cancel 的稀疏合约。
  if (ev.type) constraints.type = ev.type;
  if (ev.title) constraints.title = ev.title;
  if (ev.description) constraints.description = ev.description;
  if (ev.start_at !== null) constraints.start_at = ev.start_at;
  if (ev.end_at !== null) constraints.end_at = ev.end_at;
  if (ev.deadline_at !== null) constraints.deadline_at = ev.deadline_at;
  if (ev.location !== null && ev.location !== '') constraints.location = ev.location;
  if (ev.action_required !== null && ev.action_required !== '') {
    constraints.action_required = ev.action_required;
  }
  if (ev.level !== null) constraints.level = ev.level;
  return constraints;
}

function applyOne(groupId: string, ev: ExtractedEvent, byId: Map<string, Message>, now: number): void {
  const sourceId = ev.source_message_ids[0] ?? null;
  // update_of 即使指向已拒绝（cancelled）或已被人工改名的 create，也要先于模糊匹配判重；
  // 否则可能错误命中同名的另一个 LIVE 事件并将它改写。
  if (
    ev.update_of !== null &&
    hasGroupCreateProposalForEventSource(groupId, ev.update_of, ev.source_message_ids)
  ) return;

  const target = findTarget(groupId, ev, byId);
  const createFingerprint = {
    type: ev.type,
    title: ev.title,
    description: ev.description,
    start_at: ev.start_at,
    end_at: ev.end_at,
    deadline_at: ev.deadline_at,
    location: ev.location,
    action_required: ev.action_required,
    level: ev.level ?? 2,
  };

  // 低置信 create 被接受/拒绝后，事件可能已取消或被人工改得无法再匹配。create 用完整
  // 指纹；update/cancel 则按 extract 的稀疏字段约束匹配，不把 null/空串误当原始值。
  if (!target) {
    const replayedCreate = ev.action === 'create'
      ? hasGroupCreateProposalForSource(groupId, ev.source_message_ids, createFingerprint)
      : hasGroupCreateProposalForSparseSource(
          groupId,
          ev.source_message_ids,
          sparseCreateFingerprintConstraints(ev),
        );
    if (replayedCreate) return;
  }

  if (target && hasAppliedSources(target.id, ev.source_message_ids)) {
    addSources(target.id, ev.source_message_ids, byId);
    return;
  }

  // 历史补齐进来的旧消息比已经处理过的新消息晚进流水线：
  // 如果本条的来源消息全都早于目标事件已有的最新来源，只追加来源、不改字段（避免把新信息改回旧的）
  if (target && isStale(target.id, ev.source_message_ids, byId)) {
    addSources(target.id, ev.source_message_ids, byId);
    return;
  }

  if (ev.action === 'cancel') {
    if (!target) {
      console.warn('[reconcile] 取消找不到对应事件，已忽略');
      return;
    }
    addSources(target.id, ev.source_message_ids, byId);
    if (ev.confidence < PENDING_BELOW) {
      // 同一消息可能在事件已落库、processed 尚未落库时进程退出而重放。已见过的提案不能再次挂起事件。
      if (hasEventProposalForSource(target.id, 'cancel', ev.source_message_ids)) return;
      let baseVersion = target.version;
      const baseStatus = proposalBaseStatus(target.id, target.status);
      if (target.status !== 'pending_confirm') {
        writeChange(target, { status: { from: target.status, to: 'pending_confirm' } }, sourceId, now);
        baseVersion++;
      }
      createEventProposal({
        eventId: target.id,
        kind: 'cancel',
        reason: 'low_confidence',
        changes: { status: { from: target.status, to: 'cancelled' } },
        sourceMessageIds: ev.source_message_ids,
        confidence: ev.confidence,
        baseVersion,
        baseStatus,
        now,
      });
      return;
    }
    supersedePendingProposals(target.id, now);
    if (target.status !== 'cancelled') {
      writeChange(target, { status: { from: target.status, to: 'cancelled' } }, sourceId, now);
    }
    return;
  }

  if (target) {
    const changes: ProposedChanges = {};
    const lockedChanges: ProposedChanges = {};
    const locked = new Set(parseLockedFields(target.manual_locked_fields));
    for (const f of UPDATABLE) {
      const to = ev[f];
      if (to == null || to === '' || to === target[f]) continue;
      const change = { from: target[f], to };
      if (locked.has(f)) lockedChanges[f] = change;
      else changes[f] = change;
    }
    // 用户手动锁过的等级，AI 更新不覆盖（FR-12：手动调级锁定）
    if (ev.level !== null && target.level_locked === 0 && ev.level !== target.level) {
      changes.level = { from: target.level, to: ev.level };
    }
    const proposed = { ...changes, ...lockedChanges };
    // 低置信度的任何实际变化都保存成结构化提案；现值保持不动，等用户接受、拒绝或手动修正。
    if (ev.confidence < PENDING_BELOW && Object.keys(proposed).length > 0) {
      if (hasEventProposalForSource(target.id, 'update', ev.source_message_ids)) {
        addSources(target.id, ev.source_message_ids, byId);
        return;
      }
      let baseVersion = target.version;
      const baseStatus = proposalBaseStatus(target.id, target.status);
      if (target.status === 'active') {
        writeChange(target, { status: { from: 'active', to: 'pending_confirm' } }, sourceId, now);
        baseVersion++;
      }
      addSources(target.id, ev.source_message_ids, byId);
      createEventProposal({
        eventId: target.id,
        kind: 'update',
        reason: 'low_confidence',
        changes: proposed,
        sourceMessageIds: ev.source_message_ids,
        confidence: ev.confidence,
        baseVersion,
        baseStatus,
        now,
      });
      return;
    }

    // 用户锁过的字段，即使 AI 很确定也不覆盖；把差异交给用户比较。未锁字段仍可正常更新。
    if (Object.keys(lockedChanges).length > 0) {
      if (hasEventProposalForSource(target.id, 'update', ev.source_message_ids)) {
        addSources(target.id, ev.source_message_ids, byId);
        return;
      }
      let baseVersion = target.version;
      const baseStatus = proposalBaseStatus(target.id, target.status);
      if (target.status === 'active') changes.status = { from: 'active', to: 'pending_confirm' };
      if (Object.keys(changes).length > 0) {
        writeChange(target, changes, sourceId, now);
        baseVersion++;
      }
      addSources(target.id, ev.source_message_ids, byId);
      createEventProposal({
        eventId: target.id,
        kind: 'update',
        reason: 'manual_lock_conflict',
        changes: lockedChanges,
        sourceMessageIds: ev.source_message_ids,
        confidence: ev.confidence,
        baseVersion,
        baseStatus,
        now,
      });
      return;
    }

    if (ev.confidence >= PENDING_BELOW && Object.keys(changes).length > 0) {
      supersedePendingProposalFields(
        target.id,
        Object.keys(changes) as Array<keyof typeof changes>,
        now,
        'update',
      );
      if (target.status === 'pending_confirm' && !hasPendingEventProposals(target.id)) {
        changes.status = { from: 'pending_confirm', to: 'active' };
      }
    }
    if (Object.keys(changes).length) writeChange(target, changes, sourceId, now);
    addSources(target.id, ev.source_message_ids, byId);
    return;
  }

  if (!ev.title) {
    console.warn(`[reconcile] ${ev.action} 找不到对应事件且没有标题，已忽略`);
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
  const eventId = Number(lastInsertRowid);
  addSources(eventId, ev.source_message_ids, byId);
  if (status === 'pending_confirm') {
    createEventProposal({
      eventId,
      kind: 'create',
      reason: 'low_confidence',
      changes: { status: { from: 'pending_confirm', to: 'active' } },
      sourceMessageIds: ev.source_message_ids,
      confidence: ev.confidence,
      eventFingerprint: createFingerprint,
      baseVersion: 1,
      baseStatus: 'pending_confirm',
      now,
    });
  }
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
