import { beginTx, commitTx, db, rollbackTx } from './db/index.js';
import type {
  EventProposalDTO,
  EventProposalKind,
  EventProposalReason,
  EventStatus,
} from './types.js';

export const EDITABLE_EVENT_FIELDS = [
  'title',
  'description',
  'start_at',
  'end_at',
  'deadline_at',
  'location',
  'action_required',
] as const;

export type EditableEventField = (typeof EDITABLE_EVENT_FIELDS)[number];
export type ProposedField = EditableEventField | 'level' | 'status';
export type ProposedChanges = Partial<Record<ProposedField, { from: unknown; to: unknown }>>;

const PROPOSABLE = new Set<string>([...EDITABLE_EVENT_FIELDS, 'level', 'status']);

export function parseLockedFields(raw: unknown): EditableEventField[] {
  try {
    const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((field): field is EditableEventField =>
      typeof field === 'string' && (EDITABLE_EVENT_FIELDS as readonly string[]).includes(field),
    ))];
  } catch {
    return [];
  }
}

function parseChanges(raw: string): ProposedChanges {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const changes: ProposedChanges = {};
    for (const [field, change] of Object.entries(value)) {
      if (!PROPOSABLE.has(field) || change === null || typeof change !== 'object' || Array.isArray(change)) continue;
      if (!('from' in change) || !('to' in change)) continue;
      changes[field as ProposedField] = {
        from: (change as { from: unknown }).from,
        to: (change as { to: unknown }).to,
      };
    }
    return changes;
  } catch {
    return {};
  }
}

function parseMessageIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function supersedePendingProposals(eventId: number, now: number, kind?: EventProposalKind): void {
  const whereKind = kind === undefined ? '' : ' AND kind = ?';
  db.prepare(
    `UPDATE event_proposals SET status = 'superseded', resolved_at = ?
     WHERE event_id = ? AND status = 'pending'${whereKind}`,
  ).run(...(kind === undefined ? [now, eventId] : [now, eventId, kind]));
}

/**
 * 只解决与本次实际修改字段重叠的提案部分。
 *
 * 一条提案可能同时包含时间和地点。用户只修正时间、或一条高置信通知只更新地点时，
 * 不能把另一半尚未确认的差异一起丢掉；因此有剩余字段时保留同一提案并缩小 changes，
 * 只有全部字段都被取代时才标 superseded。
 */
export function supersedePendingProposalFields(
  eventId: number,
  fields: readonly ProposedField[],
  now: number,
  kind: EventProposalKind = 'update',
): void {
  if (fields.length === 0) return;
  const replaced = new Set<string>(fields);
  const rows = db.prepare(
    `SELECT id, proposed_changes FROM event_proposals
      WHERE event_id = ? AND kind = ? AND status = 'pending'`,
  ).all(eventId, kind) as unknown as Array<{ id: number; proposed_changes: string }>;
  const keep = db.prepare('UPDATE event_proposals SET proposed_changes = ? WHERE id = ?');
  const close = db.prepare(
    "UPDATE event_proposals SET status = 'superseded', resolved_at = ? WHERE id = ?",
  );
  for (const row of rows) {
    const changes = parseChanges(row.proposed_changes);
    let touched = false;
    for (const field of Object.keys(changes) as ProposedField[]) {
      if (!replaced.has(field)) continue;
      delete changes[field];
      touched = true;
    }
    if (!touched) continue;
    if (Object.keys(changes).length === 0) close.run(now, row.id);
    else keep.run(JSON.stringify(changes), row.id);
  }
}

export function hasPendingEventProposals(eventId: number): boolean {
  return db.prepare(
    "SELECT 1 AS ok FROM event_proposals WHERE event_id = ? AND status = 'pending' LIMIT 1",
  ).get(eventId) !== undefined;
}

/**
 * 新的二级提案继承当前待确认流真正应恢复到的状态。
 * pending_confirm 可能来自两处：
 * - v5 前无结构提案的遗留记录：拒绝后仍应 pending_confirm；
 * - 本轮 create/update/cancel 提案门：全部非终止提案处理完后应回 active。
 */
export function proposalBaseStatus(eventId: number, currentStatus: EventStatus): EventStatus {
  if (currentStatus !== 'pending_confirm') return currentStatus;
  const rows = db.prepare(
    `SELECT kind, base_status FROM event_proposals
      WHERE event_id = ? AND status = 'pending' ORDER BY id`,
  ).all(eventId) as unknown as Array<{ kind: EventProposalKind; base_status: EventStatus }>;
  if (rows.length === 0) return 'pending_confirm';
  if (rows.some((row) => row.kind === 'create')) return 'active';
  return rows.find((row) => row.base_status !== 'pending_confirm')?.base_status ?? 'pending_confirm';
}

function normalizedSourceMessageIds(sourceMessageIds: string[]): string {
  return JSON.stringify([...new Set(sourceMessageIds)].sort());
}

/** applyEvents 可能在进程于“落事件”和“标消息 processed”之间退出后重放；先查重再改状态。 */
export function hasEventProposalForSource(
  eventId: number,
  kind: EventProposalKind,
  sourceMessageIds: string[],
): boolean {
  return db.prepare(
    'SELECT 1 AS ok FROM event_proposals WHERE event_id = ? AND kind = ? AND source_message_ids = ? LIMIT 1',
  ).get(eventId, kind, normalizedSourceMessageIds(sourceMessageIds)) !== undefined;
}

export function hasAnyEventProposalForSource(eventId: number, sourceMessageIds: string[]): boolean {
  if (sourceMessageIds.length === 0) return false;
  return db.prepare(
    'SELECT 1 AS ok FROM event_proposals WHERE event_id = ? AND source_message_ids = ? LIMIT 1',
  ).get(eventId, normalizedSourceMessageIds(sourceMessageIds)) !== undefined;
}

export interface CreateProposalFingerprint {
  type: string;
  title: string;
  description: string;
  start_at: number | null;
  end_at: number | null;
  deadline_at: number | null;
  location: string | null;
  action_required: string | null;
  level: number;
}

function serializeCreateProposalFingerprint(fingerprint: CreateProposalFingerprint): string {
  // 固定字段和顺序，避免调用方对象属性顺序或未来 ExtractedEvent 扩展影响幂等键。
  return JSON.stringify({
    type: fingerprint.type,
    title: fingerprint.title,
    description: fingerprint.description,
    start_at: fingerprint.start_at,
    end_at: fingerprint.end_at,
    deadline_at: fingerprint.deadline_at,
    location: fingerprint.location,
    action_required: fingerprint.action_required,
    level: fingerprint.level,
  });
}

function parseCreateProposalFingerprint(raw: string | null): CreateProposalFingerprint | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CreateProposalFingerprint> | null;
    if (value === null || typeof value !== 'object') return null;
    if (
      typeof value.type !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.description !== 'string' ||
      typeof value.level !== 'number'
    ) return null;
    return {
      type: value.type,
      title: value.title,
      description: value.description,
      start_at: typeof value.start_at === 'number' ? value.start_at : null,
      end_at: typeof value.end_at === 'number' ? value.end_at : null,
      deadline_at: typeof value.deadline_at === 'number' ? value.deadline_at : null,
      location: typeof value.location === 'string' ? value.location : null,
      action_required: typeof value.action_required === 'string' ? value.action_required : null,
      level: value.level,
    };
  } catch {
    return null;
  }
}

type CreateProposalFingerprintRow = CreateProposalFingerprint & { event_fingerprint: string | null };

function createProposalFingerprintsForSource(
  groupId: string,
  sourceMessageIds: string[],
): CreateProposalFingerprint[] {
  if (sourceMessageIds.length === 0) return [];
  const rows = db.prepare(
    `SELECT p.event_fingerprint, e.type, e.title, e.description, e.start_at, e.end_at, e.deadline_at,
            e.location, e.action_required, e.level
       FROM event_proposals p JOIN events e ON e.id = p.event_id
      WHERE e.group_id = ? AND p.kind = 'create' AND p.source_message_ids = ?`,
  ).all(groupId, normalizedSourceMessageIds(sourceMessageIds)) as unknown as CreateProposalFingerprintRow[];
  return rows.map((row) => {
    // 兼容极旧或损坏的 v5 行；v6 迁移会正常把这些行一次性回填。
    return parseCreateProposalFingerprint(row.event_fingerprint) ?? row;
  });
}

/**
 * update_of 是最强标识。原 create 已取消或人工改名后也可能不在 LIVE 匹配集合中，
 * 但同组、同事件、同来源的 create 提案足以证明这次是同一条输入的重放。
 */
export function hasGroupCreateProposalForEventSource(
  groupId: string,
  eventId: number,
  sourceMessageIds: string[],
): boolean {
  if (sourceMessageIds.length === 0) return false;
  return db.prepare(
    `SELECT 1 AS ok
       FROM event_proposals p JOIN events e ON e.id = p.event_id
      WHERE e.group_id = ? AND p.event_id = ? AND p.kind = 'create'
        AND p.source_message_ids = ? LIMIT 1`,
  ).get(groupId, eventId, normalizedSourceMessageIds(sourceMessageIds)) !== undefined;
}

/**
 * 被拒绝的新建事件已不在 LIVE 集合；用“群 + 来源 + 完整事件指纹”识别重放。
 * 不能只看 source ids：一条群消息完全可能同时宣布考试和作业两件事。
 */
export function hasGroupCreateProposalForSource(
  groupId: string,
  sourceMessageIds: string[],
  fingerprint: CreateProposalFingerprint,
): boolean {
  const expected = serializeCreateProposalFingerprint(fingerprint);
  return createProposalFingerprintsForSource(groupId, sourceMessageIds)
    .some((stored) => serializeCreateProposalFingerprint(stored) === expected);
}

/**
 * update/cancel 按 extract 合约只携带变化字段：空串和 null 都表示“未提供”，不能拿它们
 * 与完整 create 快照逐字段比较。仅当稀疏约束唯一指向一个原始快照时才判定为重放；
 * 同一消息包含多个同类事件且约束不足时保持未匹配，避免吞掉另一件事。
 */
export function hasGroupCreateProposalForSparseSource(
  groupId: string,
  sourceMessageIds: string[],
  constraints: Partial<CreateProposalFingerprint>,
): boolean {
  const entries = Object.entries(constraints) as Array<
    [keyof CreateProposalFingerprint, CreateProposalFingerprint[keyof CreateProposalFingerprint]]
  >;
  if (entries.length === 0) return false;
  const matching = createProposalFingerprintsForSource(groupId, sourceMessageIds).filter((stored) =>
    entries.every(([field, expected]) => stored[field] === expected),
  );
  return new Set(matching.map(serializeCreateProposalFingerprint)).size === 1;
}

export function createEventProposal(input: {
  eventId: number;
  kind: EventProposalKind;
  reason: EventProposalReason;
  changes: ProposedChanges;
  sourceMessageIds: string[];
  confidence: number;
  eventFingerprint?: CreateProposalFingerprint;
  baseVersion: number;
  baseStatus: EventStatus;
  now: number;
}): number {
  const sourceMessageIds = normalizedSourceMessageIds(input.sourceMessageIds);
  const existing = db.prepare(
    'SELECT id FROM event_proposals WHERE event_id = ? AND kind = ? AND source_message_ids = ?',
  ).get(input.eventId, input.kind, sourceMessageIds) as { id: number } | undefined;
  if (existing) return existing.id;
  // 只取代同类提案里字段重叠的部分；不相交差异必须继续等待用户处理。
  supersedePendingProposalFields(
    input.eventId,
    Object.keys(input.changes) as ProposedField[],
    input.now,
    input.kind,
  );
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO event_proposals
       (event_id, kind, reason, proposed_changes, source_message_ids, confidence, event_fingerprint,
        base_version, base_status, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  ).run(
    input.eventId,
    input.kind,
    input.reason,
    JSON.stringify(input.changes),
    sourceMessageIds,
    input.confidence,
    input.eventFingerprint === undefined
      ? null
      : serializeCreateProposalFingerprint(input.eventFingerprint),
    input.baseVersion,
    input.baseStatus,
    input.now,
  );
  // updated_at 同时充当 UI 写入的单调并发令牌；新增待确认项也是详情状态变化。
  db.prepare('UPDATE events SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(input.now, input.eventId);
  return Number(lastInsertRowid);
}

export function listPendingEventProposals(eventId: number): EventProposalDTO[] {
  const rows = db.prepare(
    `SELECT id, kind, reason, proposed_changes, source_message_ids, confidence, base_version, created_at
       FROM event_proposals WHERE event_id = ? AND status = 'pending' ORDER BY id DESC`,
  ).all(eventId) as unknown as Array<{
    id: number;
    kind: EventProposalKind;
    reason: EventProposalReason;
    proposed_changes: string;
    source_message_ids: string;
    confidence: number;
    base_version: number;
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    reason: row.reason,
    changes: parseChanges(row.proposed_changes),
    source_message_ids: parseMessageIds(row.source_message_ids),
    confidence: row.confidence,
    base_version: row.base_version,
    created_at: row.created_at,
  }));
}

interface ResolveEventRow extends Record<string, unknown> {
  id: number;
  status: EventStatus;
  version: number;
  updated_at: number;
}

interface ResolveProposalRow {
  id: number;
  event_id: number;
  kind: EventProposalKind;
  proposed_changes: string;
  source_message_ids: string;
  base_status: EventStatus;
  status: string;
}

export type ResolveProposalResult = 'ok' | 'not_found' | 'already_resolved' | 'conflict' | 'invalid_time';

/** 接受/拒绝一条待确认提案；非终止决定只处理这一条，其余提案继续等待。 */
export function resolveEventProposal(
  eventId: number,
  proposalId: number,
  decision: 'accept' | 'reject',
  expectedVersion?: number,
  expectedUpdatedAt?: number,
  now = Date.now(),
): ResolveProposalResult {
  beginTx();
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as ResolveEventRow | undefined;
    const proposal = db.prepare('SELECT * FROM event_proposals WHERE id = ? AND event_id = ?').get(
      proposalId,
      eventId,
    ) as unknown as ResolveProposalRow | undefined;
    if (!event || !proposal) {
      rollbackTx();
      return 'not_found';
    }
    const resolvedAs = decision === 'accept' ? 'accepted' : 'rejected';
    if (proposal.status === resolvedAs) {
      commitTx();
      return 'ok'; // 浏览器重试同一决定时幂等
    }
    if (proposal.status !== 'pending') {
      rollbackTx();
      return 'already_resolved';
    }
    if (expectedVersion !== undefined && event.version !== expectedVersion) {
      rollbackTx();
      return 'conflict';
    }
    if (expectedUpdatedAt !== undefined && event.updated_at !== expectedUpdatedAt) {
      rollbackTx();
      return 'conflict';
    }
    if (event.status !== 'pending_confirm') {
      rollbackTx();
      return 'conflict';
    }

    const proposed = parseChanges(proposal.proposed_changes);
    const changes: ProposedChanges = {};
    if (decision === 'accept' && proposal.kind === 'update') {
      for (const [field, change] of Object.entries(proposed) as Array<[ProposedField, { from: unknown; to: unknown }]>) {
        if (field === 'status') continue;
        if (event[field] !== change.from) {
          rollbackTx();
          return 'conflict';
        }
        if (event[field] !== change.to) changes[field] = { from: event[field], to: change.to };
      }
      const nextStart = ('start_at' in changes ? changes.start_at?.to : event.start_at) as number | null;
      const nextEnd = ('end_at' in changes ? changes.end_at?.to : event.end_at) as number | null;
      if (nextStart !== null && nextEnd !== null && nextEnd <= nextStart) {
        rollbackTx();
        return 'invalid_time';
      }
    }

    const terminalCancel =
      (decision === 'accept' && proposal.kind === 'cancel') ||
      (decision === 'reject' && proposal.kind === 'create');
    if (terminalCancel) supersedePendingProposals(eventId, now);
    const otherPending = terminalCancel
      ? 0
      : (db.prepare(
          "SELECT COUNT(*) AS n FROM event_proposals WHERE event_id = ? AND status = 'pending' AND id <> ?",
        ).get(eventId, proposalId) as { n: number }).n;
    const finalStatus: EventStatus = terminalCancel
      ? 'cancelled'
      : otherPending > 0
        ? 'pending_confirm'
        : proposal.kind === 'create'
          ? 'active'
          : proposal.base_status;
    if (event.status !== finalStatus) {
      const historicalFrom = terminalCancel && proposal.kind === 'cancel'
        ? proposed.status?.from ?? event.status
        : event.status;
      changes.status = { from: historicalFrom, to: finalStatus };
    }

    const fields = Object.keys(changes) as ProposedField[];
    const version = event.version + (fields.length > 0 ? 1 : 0);
    if (fields.length > 0) {
      db.prepare(
        `UPDATE events SET ${fields.map((field) => `${field} = ?`).join(', ')}, version = ?,
           updated_at = MAX(updated_at + 1, ?) WHERE id = ?`,
      ).run(...fields.map((field) => changes[field]!.to as string | number | null), version, now, eventId);
      const sourceIds = parseMessageIds(proposal.source_message_ids);
      db.prepare(
        `INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(eventId, version, JSON.stringify(changes), decision === 'accept' ? sourceIds[0] ?? null : null, now);
    } else {
      // 即使事件字段没变，接受/拒绝也改变了详情中的提案集合，必须使旧页面并发令牌失效。
      db.prepare('UPDATE events SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(now, eventId);
    }
    db.prepare(
      'UPDATE event_proposals SET status = ?, resolved_at = ? WHERE id = ?',
    ).run(resolvedAs, now, proposalId);
    commitTx();
    return 'ok';
  } catch (error) {
    rollbackTx();
    throw error;
  }
}
