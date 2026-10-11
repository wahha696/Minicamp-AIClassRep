// 业务路由：今日 / 事件查询 / 事件详情 / 改状态 / 导出 .ics / 群管理 / 演示。主人是 B。
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { currentDataSpace } from '../accounts.js';
import { beginTx, commitTx, db, rollbackTx } from '../db/index.js';
import { clearGroupEventData } from '../event-group-data.js';
import {
  EDITABLE_EVENT_FIELDS,
  listPendingEventProposals,
  parseLockedFields,
  proposalBaseStatus,
  resolveEventProposal,
  hasPendingEventProposals,
  supersedePendingProposalFields,
  type EditableEventField,
  type ProposedChanges,
  type ProposedField,
} from '../event-proposals.js';
import { env } from '../env.js';
import { buildIcs } from '../ics.js';
import { buildDemoMessages, listScenarios, parseImportedText, scenarioGroupId } from '../ingest/demo.js';
import { ingestMessages } from '../ingest/index.js';
import { runPipelineNow } from '../pipeline/index.js';
import { runPipelineGroupNow } from '../pipeline/scheduler.js';
import { getGroupFailure, clearGroupFailure } from '../pipeline/failures.js';
import { desktopPipelinePaused } from '../pipeline/activity.js';
import { TODO_SQL } from './todos.js';
import { schedulePreferenceSummary } from '../pipeline/preferences.js';
import type {
  EventDTO,
  EventDetailDTO,
  EventStatus,
  GroupDTO,
  HistoryDTO,
  Level,
  SourceMessageDTO,
  TodayDTO,
} from '../types.js';

// ===== Asia/Shanghai（架构约定：只有「给 LLM 的 prompt」「.ics」「页面显示」才转文本，
// ===== 这里属于「页面显示」，所以 /api/today 的日期与摘要要按上海时间算）

/** 今天（Asia/Shanghai）的 'YYYY-MM-DD' */
function shanghaiDate(now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
}

/** 上海时区某天的 0 点（毫秒时间戳） */
function shanghaiDayStart(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

/** 上海时区某天 24 点（= 次日 0 点） */
function shanghaiDayEnd(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  // Date.UTC 会自动进位（如 9 月 31 日 → 10 月 1 日），不写日期换算
  return Date.UTC(y!, m! - 1, d! + 1) - 8 * 3600_000;
}

/** 展示用 HH:mm（上海时间） */
function shanghaiHHmm(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

/** 排序时间 = start_at ?? deadline_at */
function sortTime(e: EventDTO, now: number): number | null {
  const next = [e.start_at, e.deadline_at].filter((t): t is number => t !== null && t >= now);
  return next.length ? Math.min(...next) : e.deadline_at ?? e.start_at;
}

// ===== 数据库 → DTO

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

// 排序时间（COALESCE）与 id 兜底：无时间的事件排在最后，且顺序稳定
const EVENT_COLUMNS = `
  e.id, e.group_id, g.name AS group_name, e.type, e.title, e.description,
  e.start_at, e.end_at, e.deadline_at, e.location, e.action_required,
  e.status, e.confidence, e.level, e.level_locked, e.manual_locked_fields,
  e.version, e.created_at, e.updated_at
`;
const EVENT_FROM = 'FROM events e LEFT JOIN groups g ON g.group_id = e.group_id';
const EVENT_ORDER = 'ORDER BY COALESCE(e.start_at, e.deadline_at) IS NULL, COALESCE(e.start_at, e.deadline_at), e.id';

function toEventDTO(row: EventRow): EventDTO {
  return {
    id: row.id,
    group_id: row.group_id,
    group_name: row.group_name ?? '',
    type: row.type as EventDTO['type'],
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

function selectEvents(where: string, params: unknown[]): EventDTO[] {
  const rows = db
    .prepare(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} ${where} ${EVENT_ORDER}`)
    .all(...(params as never[])) as unknown as EventRow[];
  return rows.map(toEventDTO);
}

// 待办类事件（todo.ts 的 isTodo 的 SQL 等价条件）不进 today / events / ics 导出（FR-15）
const NOT_TODO_SQL = `NOT (e.status IN ('active', 'pending_confirm') AND e.deadline_at IS NULL
    AND ((e.start_at IS NULL AND e.end_at IS NULL) OR e.type = 'assignment'))`;

/** 状态不是 cancelled、不是待办，且 start_at 或 deadline_at 落在 [from, to) 内 */
function selectEventsInRange(from: number, to: number): EventDTO[] {
  return selectEvents(
    `WHERE e.status <> 'cancelled' AND ${NOT_TODO_SQL}
       AND ((e.start_at IS NOT NULL AND e.start_at >= ? AND e.start_at < ?)
         OR (e.deadline_at IS NOT NULL AND e.deadline_at >= ? AND e.deadline_at < ?)
         OR (e.start_at < ? AND e.end_at > ? AND e.end_at > e.start_at))`,
    [from, to, from, to, to, from],
  );
}

/** 全部非 cancelled、非待办（含两个时间都为空的非待办事件——比如已完成的活动记录） */
function selectAllEvents(): EventDTO[] {
  return selectEvents(`WHERE e.status <> 'cancelled' AND ${NOT_TODO_SQL}`, []);
}

function getEventById(id: number): EventDTO | null {
  const row = db.prepare(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = ?`).get(id) as
    | unknown as EventRow
    | undefined;
  return row === undefined ? null : toEventDTO(row);
}

/** 详情 = 事件 + sources（时间升序）+ history（version、id 升序）；GET 详情与 PATCH 共用 */
function getEventDetail(id: number): EventDetailDTO | null {
  const event = getEventById(id);
  if (event === null) return null;

  const sources = db
    .prepare(
      'SELECT message_id, sender_name, text, sent_at, group_id, group_name, platform FROM event_sources WHERE event_id = ? ORDER BY sent_at, message_id',
    )
    .all(id) as unknown as SourceMessageDTO[];

  const historyRows = db
    .prepare(
      'SELECT version, changed_fields, source_message_id, changed_at FROM event_history WHERE event_id = ? ORDER BY version, id',
    )
    .all(id) as unknown as {
    version: number;
    changed_fields: string;
    source_message_id: string | null;
    changed_at: number;
  }[];
  const history: HistoryDTO[] = historyRows.map((h) => ({
    version: h.version,
    changed_fields: parseChangedFields(h.changed_fields),
    source_message_id: h.source_message_id,
    changed_at: h.changed_at,
  }));

  return { ...event, sources, history, pending_proposals: listPendingEventProposals(id) };
}

/** 手动调级 / 交还 AI（level === null）。调级记 level_feedback 并防抖触发偏好总结（FR-12）。 */
function applyManualLevel(row: EventRow, level: number | null, now: number): void {
  if (level === null) {
    db.prepare('UPDATE events SET level_locked = 0, updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(now, row.id);
    return;
  }
  // AI 原级：取上一条 feedback 的 ai_level——除非那之后 AI 又按群消息改过等级（交还 AI 后才可能），
  // 那时当前 level 就是 AI 给的。没记过 feedback 时当前 level 就是 AI 原级。
  const lastFeedback = db
    .prepare('SELECT ai_level, created_at FROM level_feedback WHERE event_id = ? ORDER BY id DESC LIMIT 1')
    .get(row.id) as { ai_level: number; created_at: number } | undefined;
  const aiChangedSince =
    lastFeedback !== undefined &&
    db
      .prepare(
        `SELECT 1 AS ok FROM event_history
         WHERE event_id = ? AND source_message_id IS NOT NULL AND changed_at >= ?
           AND json_extract(changed_fields, '$.level') IS NOT NULL LIMIT 1`,
      )
      .get(row.id, lastFeedback.created_at) !== undefined;
  const aiLevel = lastFeedback !== undefined && !aiChangedSince ? lastFeedback.ai_level : row.level;

  if (level !== row.level) {
    // 实际内容变更递增版本，供并发检查和日历 SEQUENCE 使用。
    db.prepare(
      'UPDATE events SET level = ?, level_locked = 1, version = version + 1, updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
    ).run(level, now, row.id);
    db.prepare(
      `INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(row.id, row.version + 1, JSON.stringify({ level: { from: row.level, to: level } }), now);
  } else {
    db.prepare('UPDATE events SET level_locked = 1, updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(now, row.id);
  }

  db.prepare(
    `INSERT INTO level_feedback (event_id, group_name, type, title, ai_level, user_level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.group_name ?? '', row.type, row.title, aiLevel, level, now);
  schedulePreferenceSummary();
}

// ===== 摘要文案

/** 「今天 N 件事，最急的是 HH:mm 标题」；无事件时「今天没有待办，轻松一天」 */
function buildSummary(events: EventDTO[], now: number, overdue: EventDTO[] = []): string {
  const pending = events.filter((e) => e.status !== 'done' && e.status !== 'cancelled');
  const todoCount = Number((db.prepare(`SELECT COUNT(*) AS n FROM events e WHERE ${TODO_SQL}`).get() as { n: number }).n)
    + Number((db.prepare('SELECT COUNT(*) AS n FROM todos WHERE done_at IS NULL').get() as { n: number }).n);
  const tail = (overdue.length ? `；${overdue.length} 件作业已逾期` : '') + (todoCount ? `；另有 ${todoCount} 件待办` : '');
  const todayPending = pending.filter(e => !overdue.some(old => old.id === e.id));
  if (!todayPending.length) return `今天暂无未完成的日程${tail}`;
  const next = todayPending.filter((e) => (sortTime(e, now) ?? -1) >= now)
    .sort((a, b) => sortTime(a, now)! - sortTime(b, now)! || a.id - b.id)[0];
  const head = `今天 ${todayPending.length} 件未完成安排`;
  return next ? `${head}，接下来 ${shanghaiHHmm(sortTime(next, now)!)} ${next.title}${tail}` : `${head}，请核对处理状态${tail}`;
}

// ===== 校验

const EVENT_STATUSES = ['active', 'cancelled', 'done', 'pending_confirm'] as const;
// 日历导出采用四位年份，拒绝 Date 无法表示或超出该格式的时间。
const MAX_EVENT_TIMESTAMP = Date.parse('9999-12-31T23:59:59.999+08:00');
const timestamp = z.number().int().nonnegative().max(MAX_EVENT_TIMESTAMP).nullable();
const patchEventSchema = z
  .object({
    status: z.enum(EVENT_STATUSES).optional(),
    // 1~4 手动设级；null = 解除锁定交还 AI
    level: z.number().int().min(1).max(4).nullable().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    start_at: timestamp.optional(),
    end_at: timestamp.optional(),
    deadline_at: timestamp.optional(),
    location: z.string().trim().max(300).nullable().optional(),
    action_required: z.string().trim().max(1000).nullable().optional(),
    /** 人工保护可按字段解除；解除后后续 AI 通知才允许覆盖。 */
    unlock_fields: z.array(z.enum(EDITABLE_EVENT_FIELDS)).max(EDITABLE_EVENT_FIELDS.length).optional(),
    /** 乐观并发检查；旧客户端可省略，新详情页始终带上。 */
    expected_version: z.number().int().positive().optional(),
    /** version 跟踪内容变更；updated_at 也覆盖锁定设置等详情变更。 */
    expected_updated_at: z.number().int().nonnegative().safe().optional(),
  })
  .refine((o) =>
    o.status !== undefined || o.level !== undefined || o.unlock_fields !== undefined ||
    EDITABLE_EVENT_FIELDS.some((field) => o[field] !== undefined), {
    message: '至少提供一个需要修改或解除保护的字段',
  });
const resolveProposalSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  expected_version: z.number().int().positive().optional(),
  expected_updated_at: z.number().int().nonnegative().safe().optional(),
});
const patchGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    // null = 清除指定课程名（回到 AI 按群名猜）
    course_name: z.string().trim().max(50).nullable().optional(),
  })
  .refine((o) => o.enabled !== undefined || o.course_name !== undefined, {
    message: 'enabled 或 course_name 至少给一个',
  });
const replaySchema = z.object({ scenario: z.string().min(1) });
const importSchema = z.object({ groupName: z.string().default(''), text: z.string().min(1) });

/** '?from=&to=' → 毫秒；返回 null 表示格式不对 */
function parseRange(from: string | undefined, to: string | undefined): { from?: number; to?: number } | null {
  const out: { from?: number; to?: number } = {};
  for (const [key, raw] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    out[key] = n;
  }
  return out;
}

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ===== 群（B5）

interface GroupRow {
  group_id: string;
  name: string;
  enabled: number;
  course_name: string | null;
  adapter: string;
  message_count: number;
  event_count: number;
}

/** 群列表带 message_count / event_count（FR-10.1） */
function selectGroups(): GroupDTO[] {
  const rows = db
    .prepare(
      `SELECT g.group_id, g.name, g.enabled, g.course_name, g.adapter,
              (SELECT COUNT(*) FROM messages m WHERE m.group_id = g.group_id) AS message_count,
              (SELECT COUNT(*) FROM events e WHERE e.group_id = g.group_id OR EXISTS
                (SELECT 1 FROM event_sources s WHERE s.event_id=e.id AND s.group_id=g.group_id)) AS event_count
         FROM groups g
        ORDER BY g.created_at, g.group_id`,
    )
    .all() as unknown as GroupRow[];
  return rows.map(toGroupDTO);
}

function getGroupById(group_id: string): GroupDTO | null {
  const row = db
    .prepare(
      `SELECT g.group_id, g.name, g.enabled, g.course_name, g.adapter,
              (SELECT COUNT(*) FROM messages m WHERE m.group_id = g.group_id) AS message_count,
              (SELECT COUNT(*) FROM events e WHERE e.group_id = g.group_id OR EXISTS
                (SELECT 1 FROM event_sources s WHERE s.event_id=e.id AND s.group_id=g.group_id)) AS event_count
         FROM groups g
        WHERE g.group_id = ?`,
    )
    .get(group_id) as unknown as GroupRow | undefined;
  return row === undefined ? null : toGroupDTO(row);
}

function toGroupDTO(row: GroupRow): GroupDTO {
  const failure = getGroupFailure(row.group_id);
  return {
    group_id: row.group_id,
    name: row.name,
    enabled: row.enabled !== 0,
    platform: row.adapter === 'wechat' ? 'wechat' : ['onebot', 'history', 'forward'].includes(row.adapter) ? 'qq'
      : row.adapter === 'demo' ? 'demo' : row.adapter === 'import' ? 'import' : 'unknown',
    message_count: row.message_count,
    event_count: row.event_count,
    course_name: row.course_name,
    ...(failure ? { processing_failure: failure } : {}),
  };
}

/** 导出响应的固定头（FR-9.1） */
const ICS_HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8',
  'Content-Disposition': 'attachment; filename="classrep.ics"',
};

/** 事件 → .ics 响应（区间里没有事件时是合法的空日历，照样 200 下载） */
function icsResponse(c: Context, events: EventDTO[]): Response {
  return c.body(buildIcs(events, Date.now(), currentDataSpace() ?? 'local'), 200, ICS_HEADERS);
}

// ===== 路由

export function registerBusinessRoutes(app: Hono, options: {
  setWechatGroupEnabled?(id: string, enabled: boolean): Promise<void>;
  wechatCollectingGroupIds?(): readonly string[];
} = {}): void {
  // 今天（上海时间）：start_at 或 deadline_at 落在今天，状态不是 cancelled，按时间升序
  app.get('/api/today', (c) => {
    const now = Date.now();
    const date = shanghaiDate(now);
    const events = selectEventsInRange(shanghaiDayStart(date), shanghaiDayEnd(date));
    const overdue = selectEvents("WHERE e.type = 'assignment' AND e.status IN ('active', 'pending_confirm') AND e.deadline_at < ?", [now]);
    const body: TodayDTO = { date, summary: buildSummary(events, now, overdue), events, overdue };
    return c.json(body);
  });

  // 事件列表：from/to 为毫秒，各自可省略（省一个 = 那一侧不设限）；都省略时返回全部非 cancelled
  app.get('/api/events', (c) => {
    const range = parseRange(c.req.query('from'), c.req.query('to'));
    if (range === null) return c.json({ error: 'from/to 需要是毫秒时间戳' }, 400);
    const { from, to } = range;
    if (from === undefined && to === undefined) return c.json(selectAllEvents());
    const lo = from ?? Number.MIN_SAFE_INTEGER;
    const hi = to ?? Number.MAX_SAFE_INTEGER;
    if (hi <= lo) return c.json({ error: 'to 必须大于 from' }, 400);
    return c.json(selectEventsInRange(lo, hi));
  });

  // 导出 .ics：from/to 同 /api/events（省略的那侧不设限）；区间里没事件 → 200 空日历
  // 注意：这条必须注册在 /api/events/:id 之前
  app.get('/api/export.ics', (c) => {
    const range = parseRange(c.req.query('from'), c.req.query('to'));
    if (range === null) return c.json({ error: 'from/to 需要是毫秒时间戳' }, 400);
    const { from, to } = range;
    if (from === undefined && to === undefined) return icsResponse(c, selectAllEvents());
    const lo = from ?? Number.MIN_SAFE_INTEGER;
    const hi = to ?? Number.MAX_SAFE_INTEGER;
    if (hi <= lo) return c.json({ error: 'to 必须大于 from' }, 400);
    return icsResponse(c, selectEventsInRange(lo, hi));
  });

  // 单条导出（FR-9.2）：同 /api/export.ics 的格式，只有这一条
  app.get('/api/events/:id/export.ics', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: '事件 id 不合法' }, 400);
    const event = getEventById(id);
    if (event === null) return c.json({ error: '事件不存在' }, 404);
    if (event.start_at === null && event.deadline_at === null) {
      return c.json({ error: '这条事件没有时间，不能导出到日历' }, 404);
    }
    return icsResponse(c, [event]);
  });

  // 事件详情：sources 按时间升序，history 按 version 升序
  app.get('/api/events/:id', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: '事件 id 不合法' }, 400);
    const detail = getEventDetail(id);
    if (detail === null) return c.json({ error: '事件不存在' }, 404);
    return c.json(detail);
  });

  // 手动改状态/字段/危机等级。人工改过的业务字段会锁定，后续 AI 只生成差异提案。
  app.patch('/api/events/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: '事件 id 不合法' }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = patchEventSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? '事件修改内容不合法' }, 400);
    }

    const row = db
      .prepare(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = ?`)
      .get(id) as unknown as EventRow | undefined;
    if (row === undefined) return c.json({ error: '事件不存在' }, 404);
    if (parsed.data.expected_version !== undefined && parsed.data.expected_version !== row.version) {
      return c.json({ error: '事件已发生变化，请刷新后重新编辑' }, 409);
    }
    if (parsed.data.expected_updated_at !== undefined && parsed.data.expected_updated_at !== row.updated_at) {
      return c.json({ error: '事件已发生变化，请刷新后重新编辑' }, 409);
    }

    const now = Date.now();
    const data = parsed.data;
    const editedFields = EDITABLE_EVENT_FIELDS.filter((field) => data[field] !== undefined);
    const normalized = Object.fromEntries(editedFields.map((field) => {
      const value = data[field];
      return [field, (field === 'location' || field === 'action_required') && value === '' ? null : value];
    })) as Partial<Record<EditableEventField, string | number | null>>;
    const nextStart = normalized.start_at !== undefined ? normalized.start_at : row.start_at;
    const nextEnd = normalized.end_at !== undefined ? normalized.end_at : row.end_at;
    if (nextStart !== null && nextEnd !== null && nextEnd <= nextStart) {
      return c.json({ error: '结束时间必须晚于开始时间' }, 400);
    }
    const hasPending = listPendingEventProposals(id).length > 0;
    const manuallySetLevel = data.level !== undefined && data.level !== null;
    const hasManualCorrection = editedFields.length > 0 || manuallySetLevel;
    // v5 以前可能只有 pending_confirm 状态、没有结构化 proposal；同样不能经通用 PATCH
    // 直接进入完成/取消，必须先接受、拒绝或保存人工修正。
    if (row.status === 'pending_confirm' && (data.status === 'cancelled' || data.status === 'done')) {
      return c.json({ error: '请先处理待确认修改，再标记完成或取消' }, 409);
    }
    if (hasPending && !hasManualCorrection && data.status === 'active') {
      return c.json({ error: '这条事件有待确认修改，请选择接受、拒绝或保存人工修正' }, 409);
    }
    // 字段提案被人工修正全部消解后，应恢复提案原先的业务状态，
    // 而不是粗暴地一律改成 active（遗留 pending_confirm 可能是真实基线）。
    const baseStatusBeforeCorrection = hasPending && hasManualCorrection
      ? proposalBaseStatus(id, row.status as EventStatus)
      : row.status as EventStatus;

    // 字段、状态、锁与 history 放在同一个事务里，中途出错不留半截。
    beginTx();
    try {
      const locked = new Set(parseLockedFields(row.manual_locked_fields));
      for (const field of editedFields) locked.add(field);
      for (const field of data.unlock_fields ?? []) locked.delete(field);

      const changes: ProposedChanges = {};
      for (const field of editedFields) {
        const to = normalized[field] ?? null;
        if (row[field] !== to) changes[field] = { from: row[field], to };
      }
      if (hasPending && hasManualCorrection) {
        supersedePendingProposalFields(id, editedFields, now, 'update');
        // level 不在可编辑文本字段里，但人工选了等级（即使与现值相同）
        // 就是对该差异的最终裁决；必须缩减/关闭对应提案，且保留其他差异。
        if (manuallySetLevel) supersedePendingProposalFields(id, ['level'], now, 'update');
        const pendingAfterCorrection = hasPendingEventProposals(id);
        if (data.status === 'active' && pendingAfterCorrection) {
          rollbackTx();
          return c.json({ error: '仍有其他待确认修改，请逐条处理或继续人工修正' }, 409);
        }
        const desiredStatus: EventStatus = data.status === 'pending_confirm' || pendingAfterCorrection
          ? 'pending_confirm'
          : baseStatusBeforeCorrection;
        if (row.status !== desiredStatus) changes.status = { from: row.status, to: desiredStatus };
      } else if (hasManualCorrection && row.status === 'pending_confirm' && !hasPending) {
        // v5 前遗留的无结构提案：保存人工正确值就是完成确认，不要求用户再点一次。
        changes.status = { from: row.status, to: data.status ?? 'active' };
      } else if (hasManualCorrection && data.status !== undefined && data.status !== row.status) {
        changes.status = { from: row.status, to: data.status };
      }

      if (Object.keys(changes).length > 0 && editedFields.length > 0) {
        const fields = Object.keys(changes) as ProposedField[];
        const version = row.version + 1;
        db.prepare(
          `UPDATE events SET ${fields.map((field) => `${field} = ?`).join(', ')},
             manual_locked_fields = ?, version = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?`,
        ).run(
          ...fields.map((field) => changes[field]!.to as string | number | null),
          JSON.stringify([...locked]),
          version,
          now,
          id,
        );
        db.prepare(
          `INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
           VALUES (?, ?, ?, NULL, ?)`,
        ).run(id, version, JSON.stringify(changes), now);
      } else if (editedFields.length > 0 || data.unlock_fields !== undefined) {
        db.prepare('UPDATE events SET manual_locked_fields = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(
          JSON.stringify([...locked]), now, id,
        );
      }

      // 单独改状态，或仅用人工 level 消解最后一个提案时，也记录内容版本。
      const standaloneStatus = editedFields.length === 0
        ? ((changes.status?.to as EventStatus | undefined) ?? data.status)
        : undefined;
      if (standaloneStatus !== undefined && standaloneStatus !== row.status) {
        db.prepare('UPDATE events SET status = ?, version = version + 1, updated_at = MAX(updated_at + 1, ?) WHERE id = ?').run(standaloneStatus, now, id);
        db.prepare(
          `INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
           VALUES (?, ?, ?, NULL, ?)`,
        ).run(id, row.version + 1, JSON.stringify({ status: { from: row.status, to: standaloneStatus } }), now);
      }
      if (data.level !== undefined) {
        const latest = db.prepare(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = ?`).get(id) as unknown as EventRow;
        applyManualLevel(latest, data.level, now);
      }
      commitTx();
    } catch (err) {
      rollbackTx();
      throw err;
    }

    const detail = getEventDetail(id);
    if (detail === null) return c.json({ error: '事件不存在' }, 404);
    return c.json(detail);
  });

  // 接受/拒绝结构化待确认提案；同一决定重复提交是幂等的。
  app.post('/api/events/:id/proposals/:proposalId/resolve', async (c) => {
    const id = parseId(c.req.param('id'));
    const proposalId = parseId(c.req.param('proposalId'));
    if (id === null || proposalId === null) return c.json({ error: '事件或提案 id 不合法' }, 400);
    const raw = await c.req.json().catch(() => null);
    const parsed = resolveProposalSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'decision 只能是 accept 或 reject' }, 400);
    const result = resolveEventProposal(
      id,
      proposalId,
      parsed.data.decision,
      parsed.data.expected_version,
      parsed.data.expected_updated_at,
    );
    if (result === 'not_found') return c.json({ error: '事件或提案不存在' }, 404);
    if (result === 'already_resolved') return c.json({ error: '提案已经用另一种方式处理' }, 409);
    if (result === 'conflict') return c.json({ error: '事件已发生变化，请刷新后重新核对' }, 409);
    if (result === 'invalid_time') return c.json({ error: '接受后结束时间不会晚于开始时间，请改用人工修正' }, 400);
    const detail = getEventDetail(id);
    return detail === null ? c.json({ error: '事件不存在' }, 404) : c.json(detail);
  });

  // 群列表（FR-10.1）
  app.get('/api/groups', (c) => {
    const collecting = new Set(options.wechatCollectingGroupIds?.() ?? []);
    return c.json(selectGroups().map((group) => group.platform === 'wechat'
      ? { ...group, collecting: group.enabled && collecting.has(group.group_id) } : group));
  });

  app.post('/api/groups/:id/retry', (c) => {
    const groupId = c.req.param('id');
    const group = getGroupById(groupId);
    if (!group) return c.json({ error: '群不存在' }, 404);
    if (!group.enabled) return c.json({ error: '请先开启这个群的监听再重试' }, 409);
    if (desktopPipelinePaused() && group.platform !== 'wechat') return c.json({ error: '请先返回课代表模式再重试 QQ 整理' }, 409);
    // 后台处理，避免多批积压或 AI 等待让页面请求超时。调度器仍逐批核对账号与暂停状态。
    void runPipelineGroupNow(groupId).catch(() => console.warn('[pipeline] 手动重试启动失败'));
    return c.json({ accepted: true }, 202);
  });

  // 开 / 关某个群的监听
  app.patch('/api/groups/:id', async (c) => {
    const group_id = c.req.param('id');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = patchGroupSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'enabled 只能是 true / false，course_name 是最长 50 字的字符串或 null' }, 400);
    }
    const data = parsed.data;

    const exists = db.prepare('SELECT adapter FROM groups WHERE group_id = ?').get(group_id);
    if (exists === undefined) return c.json({ error: '群不存在' }, 404);

    if (data.enabled !== undefined) {
      if (exists.adapter === 'wechat') {
        try {
          if (!options.setWechatGroupEnabled) throw new Error();
          await options.setWechatGroupEnabled(group_id, data.enabled);
        } catch { return c.json({ error: '请先在连接页连接微信并读取群列表，再修改选群；原有消息保留' }, 409); }
      } else db.prepare('UPDATE groups SET enabled = ? WHERE group_id = ?').run(
        data.enabled ? 1 : 0,
        group_id,
      );
    }
    if (data.course_name !== undefined) {
      // 空串也当「清除指定课程名」处理
      db.prepare('UPDATE groups SET course_name = ? WHERE group_id = ?').run(
        data.course_name === null || data.course_name === '' ? null : data.course_name,
        group_id,
      );
    }

    const group = getGroupById(group_id);
    if (group === null) return c.json({ error: '群不存在' }, 404);
    return c.json(group);
  });

  // 删除该群的全部数据（群本身保留）：history → sources → events → messages。
  // B3：删 messages 前先把 id 写进 message_seen——否则下次历史补齐会把刚删掉的消息再拉回来；
  // 偏好反馈按真正被删除的事项移除，不能按群名误删同名群或仍有其他来源的事项。
  app.delete('/api/groups/:id/data', (c) => {
    const group_id = c.req.param('id');
    const exists = db.prepare('SELECT 1 AS ok FROM groups WHERE group_id = ?').get(group_id);
    if (exists === undefined) return c.json({ error: '群不存在' }, 404);

    const markSeen = db.prepare(
      'INSERT OR IGNORE INTO message_seen (group_id, message_id, sent_at) SELECT group_id, message_id, sent_at FROM messages WHERE group_id = ?',
    );
    const delMessages = db.prepare('DELETE FROM messages WHERE group_id = ?');

    beginTx();
    try {
      markSeen.run(group_id);
      clearGroupEventData(group_id, true);
      delMessages.run(group_id);
      clearGroupFailure(group_id);
      commitTx();
    } catch (err) {
      rollbackTx();
      throw err;
    }
    return c.json({ ok: true });
  });

  // ===== 演示与粘贴导入（B6）

  // 可用剧本列表
  // active：这个剧本的演示群当前是否有数据（回放过且没取消），前端据此显示「回放」或「取消」
  app.get('/api/demo/scenarios', (c) => {
    const exists = db.prepare('SELECT 1 FROM groups WHERE group_id = ?');
    return c.json(listScenarios().map((s) => ({ ...s, active: exists.get(s.group_id) !== undefined })));
  });

  // 回放剧本：注入后立即跑一次流水线（B10：和 reset 一样受 DEMO_MODE 限制）
  app.post('/api/demo/replay', async (c) => {
    if (!env.DEMO_MODE) return c.json({ error: '演示模式已关闭' }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = replaySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: '需要 { scenario: "剧本名" }' }, 400);

    const msgs = buildDemoMessages(parsed.data.scenario);
    if (msgs === null) return c.json({ error: '剧本不存在' }, 404);

    const { inserted } = ingestMessages(msgs, 'demo');
    await runPipelineNow();
    return c.json({ injected: inserted });
  });

  // 清空演示数据：所有 demo- 开头的群及其全部数据
  app.post('/api/demo/reset', (c) => {
    if (!env.DEMO_MODE) return c.json({ error: '演示模式已关闭' }, 403);
    const demoGroups = db
      .prepare("SELECT group_id FROM groups WHERE group_id LIKE 'demo-%'")
      .all() as unknown as { group_id: string }[];
    deleteGroupsData(demoGroups.map((g) => g.group_id));
    return c.json({ ok: true });
  });

  // 取消某个剧本的回放：删掉这个剧本对应演示群的全部数据，其他演示群和真实群不动
  app.post('/api/demo/undo', async (c) => {
    if (!env.DEMO_MODE) return c.json({ error: '演示模式已关闭' }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = replaySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: '需要 { scenario: "剧本名" }' }, 400);
    const groupId = scenarioGroupId(parsed.data.scenario);
    if (groupId === null) return c.json({ error: '剧本不存在' }, 404);
    if (!groupId.startsWith('demo-')) return c.json({ error: '只能取消演示群' }, 400);
    deleteGroupsData([groupId]);
    return c.json({ ok: true });
  });

  // 粘贴一段聊天记录 → 解析成消息进流水线
  app.post('/api/import/text', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = importSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: '需要 { groupName, text }' }, 400);

    const msgs = parseImportedText(parsed.data.groupName, parsed.data.text);
    if (msgs.length === 0) return c.json({ error: '没解析出任何消息' }, 400);

    const { inserted } = ingestMessages(msgs, 'import');
    await runPipelineNow();
    return c.json({ messages: inserted });
  });
}

/** 在一个事务里删掉若干群及其消息、事件、来源、变更记录（演示用：不写 message_seen，重放要能再入库） */
function deleteGroupsData(groupIds: string[]): void {
  const delMessages = db.prepare('DELETE FROM messages WHERE group_id = ?');
  const delGroup = db.prepare('DELETE FROM groups WHERE group_id = ?');

  beginTx();
  try {
    for (const id of groupIds) {
      clearGroupEventData(id, false);
      delMessages.run(id);
      clearGroupFailure(id);
      delGroup.run(id);
    }
    commitTx();
  } catch (err) {
    rollbackTx();
    throw err;
  }
}

/** event_history.changed_fields 存的是 JSON；坏数据不让整个详情接口挂掉 */
function parseChangedFields(raw: string): HistoryDTO['changed_fields'] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as HistoryDTO['changed_fields'];
    }
  } catch {
    // 落到下面的空对象
  }
  return {};
}
