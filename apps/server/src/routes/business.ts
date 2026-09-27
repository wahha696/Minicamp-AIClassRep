// 业务路由：今日 / 事件查询 / 事件详情 / 改状态 / 导出 .ics / 群管理 / 演示。主人是 B。
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { currentAccount } from '../accounts.js';
import { beginTx, commitTx, db, rollbackTx } from '../db/index.js';
import { env } from '../env.js';
import { buildIcs } from '../ics.js';
import { buildDemoMessages, listScenarios, parseImportedText, scenarioGroupId } from '../ingest/demo.js';
import { ingestMessages } from '../ingest/index.js';
import { runPipelineNow } from '../pipeline/index.js';
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
function sortTime(e: EventDTO): number | null {
  return e.start_at ?? e.deadline_at;
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
  version: number;
  created_at: number;
  updated_at: number;
}

// 排序时间（COALESCE）与 id 兜底：无时间的事件排在最后，且顺序稳定
const EVENT_COLUMNS = `
  e.id, e.group_id, g.name AS group_name, e.type, e.title, e.description,
  e.start_at, e.end_at, e.deadline_at, e.location, e.action_required,
  e.status, e.confidence, e.level, e.level_locked, e.version, e.created_at, e.updated_at
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
         OR (e.deadline_at IS NOT NULL AND e.deadline_at >= ? AND e.deadline_at < ?))`,
    [from, to, from, to],
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
      'SELECT message_id, sender_name, text, sent_at FROM event_sources WHERE event_id = ? ORDER BY sent_at, message_id',
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

  return { ...event, sources, history };
}

/** 手动调级 / 交还 AI（level === null）。调级记 level_feedback 并防抖触发偏好总结（FR-12）。 */
function applyManualLevel(row: EventRow, level: number | null, now: number): void {
  if (level === null) {
    db.prepare('UPDATE events SET level_locked = 0, updated_at = ? WHERE id = ?').run(now, row.id);
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
    // 手动调级不升 version：version>1 表示「按群里新通知改过」，卡片据此显示「已按最新通知更新」。
    // 仍写一条 history（沿用当前 version、source_message_id 为 NULL），详情页按 id 排序展示。
    db.prepare(
      'UPDATE events SET level = ?, level_locked = 1, updated_at = ? WHERE id = ?',
    ).run(level, now, row.id);
    db.prepare(
      `INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(row.id, row.version, JSON.stringify({ level: { from: row.level, to: level } }), now);
  } else {
    db.prepare('UPDATE events SET level_locked = 1, updated_at = ? WHERE id = ?').run(now, row.id);
  }

  db.prepare(
    `INSERT INTO level_feedback (event_id, group_name, type, title, ai_level, user_level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.group_name ?? '', row.type, row.title, aiLevel, level, now);
  schedulePreferenceSummary();
}

// ===== 摘要文案

/** 「今天 N 件事，最急的是 HH:mm 标题」；无事件时「今天没有待办，轻松一天」 */
function buildSummary(events: EventDTO[], now: number): string {
  if (events.length === 0) return '今天没有待办，轻松一天';
  // events 已按排序时间升序：最急 = 排序时间 ≥ 现在的第一个，没有则第一个
  const urgent = events.find((e) => {
    const t = sortTime(e);
    return t !== null && t >= now;
  });
  const pick = urgent ?? events[0]!;
  const t = sortTime(pick);
  const when = t === null ? '待定' : shanghaiHHmm(t);
  return `今天 ${events.length} 件事，最急的是 ${when} ${pick.title}`;
}

// ===== 校验

const EVENT_STATUSES = ['active', 'cancelled', 'done', 'pending_confirm'] as const;
const patchEventSchema = z
  .object({
    status: z.enum(EVENT_STATUSES).optional(),
    // 1~4 手动设级；null = 解除锁定交还 AI
    level: z.number().int().min(1).max(4).nullable().optional(),
  })
  .refine((o) => o.status !== undefined || o.level !== undefined, {
    message: 'status 或 level 至少给一个',
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
  message_count: number;
  event_count: number;
}

/** 群列表带 message_count / event_count（FR-10.1） */
function selectGroups(): GroupDTO[] {
  const rows = db
    .prepare(
      `SELECT g.group_id, g.name, g.enabled, g.course_name,
              (SELECT COUNT(*) FROM messages m WHERE m.group_id = g.group_id) AS message_count,
              (SELECT COUNT(*) FROM events e WHERE e.group_id = g.group_id)   AS event_count
         FROM groups g
        ORDER BY g.created_at, g.group_id`,
    )
    .all() as unknown as GroupRow[];
  return rows.map(toGroupDTO);
}

function getGroupById(group_id: string): GroupDTO | null {
  const row = db
    .prepare(
      `SELECT g.group_id, g.name, g.enabled, g.course_name,
              (SELECT COUNT(*) FROM messages m WHERE m.group_id = g.group_id) AS message_count,
              (SELECT COUNT(*) FROM events e WHERE e.group_id = g.group_id)   AS event_count
         FROM groups g
        WHERE g.group_id = ?`,
    )
    .get(group_id) as unknown as GroupRow | undefined;
  return row === undefined ? null : toGroupDTO(row);
}

function toGroupDTO(row: GroupRow): GroupDTO {
  return {
    group_id: row.group_id,
    name: row.name,
    enabled: row.enabled !== 0,
    message_count: row.message_count,
    event_count: row.event_count,
    course_name: row.course_name,
  };
}

/** 导出响应的固定头（FR-9.1） */
const ICS_HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8',
  'Content-Disposition': 'attachment; filename="classrep.ics"',
};

/** 事件 → .ics 响应（区间里没有事件时是合法的空日历，照样 200 下载） */
function icsResponse(c: Context, events: EventDTO[]): Response {
  return c.body(buildIcs(events, Date.now(), currentAccount() ?? 'local'), 200, ICS_HEADERS);
}

// ===== 路由

export function registerBusinessRoutes(app: Hono): void {
  // 今天（上海时间）：start_at 或 deadline_at 落在今天，状态不是 cancelled，按时间升序
  app.get('/api/today', (c) => {
    const now = Date.now();
    const date = shanghaiDate(now);
    const events = selectEventsInRange(shanghaiDayStart(date), shanghaiDayEnd(date));
    const body: TodayDTO = { date, summary: buildSummary(events, now), events };
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

  // 手动改状态 / 调危机等级。level: null 表示解除锁定交还 AI。
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
      return c.json({ error: 'status 或 level 不合法' }, 400);
    }

    const row = db
      .prepare(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = ?`)
      .get(id) as unknown as EventRow | undefined;
    if (row === undefined) return c.json({ error: '事件不存在' }, 404);

    const now = Date.now();
    const data = parsed.data;
    // 改状态、改等级、写 history / feedback 放一个事务里，中途出错不留半截
    beginTx();
    try {
      if (data.status !== undefined) {
        db.prepare('UPDATE events SET status = ?, updated_at = ? WHERE id = ?').run(
          data.status,
          now,
          id,
        );
        // 手动改状态也记一条 history（不升 version，source_message_id 为 NULL，同手动调级）：
        // 回收站靠它区分「自己取消」和「群消息取消」、知道取消前是什么状态
        if (data.status !== row.status) {
          db.prepare(
            `INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
             VALUES (?, ?, ?, NULL, ?)`,
          ).run(id, row.version, JSON.stringify({ status: { from: row.status, to: data.status } }), now);
        }
      }
      if (data.level !== undefined) {
        applyManualLevel(row, data.level, now);
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

  // 群列表（FR-10.1）
  app.get('/api/groups', (c) => c.json(selectGroups()));

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

    const exists = db.prepare('SELECT 1 AS ok FROM groups WHERE group_id = ?').get(group_id);
    if (exists === undefined) return c.json({ error: '群不存在' }, 404);

    if (data.enabled !== undefined) {
      db.prepare('UPDATE groups SET enabled = ? WHERE group_id = ?').run(
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
  // 同时清掉这个群的 level_feedback 孤儿记录（群都没了，偏好记录留着没意义）
  app.delete('/api/groups/:id/data', (c) => {
    const group_id = c.req.param('id');
    const exists = db.prepare('SELECT 1 AS ok FROM groups WHERE group_id = ?').get(group_id);
    if (exists === undefined) return c.json({ error: '群不存在' }, 404);

    const markSeen = db.prepare(
      'INSERT OR IGNORE INTO message_seen (group_id, message_id, sent_at) SELECT group_id, message_id, sent_at FROM messages WHERE group_id = ?',
    );
    const delHistory = db.prepare(
      'DELETE FROM event_history WHERE event_id IN (SELECT id FROM events WHERE group_id = ?)',
    );
    const delSources = db.prepare(
      'DELETE FROM event_sources WHERE event_id IN (SELECT id FROM events WHERE group_id = ?)',
    );
    const delEvents = db.prepare('DELETE FROM events WHERE group_id = ?');
    const delMessages = db.prepare('DELETE FROM messages WHERE group_id = ?');
    const delFeedback = db.prepare(
      'DELETE FROM level_feedback WHERE group_name = (SELECT name FROM groups WHERE group_id = ?)',
    );

    beginTx();
    try {
      markSeen.run(group_id);
      delHistory.run(group_id);
      delSources.run(group_id);
      delEvents.run(group_id);
      delMessages.run(group_id);
      delFeedback.run(group_id);
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
  const delHistory = db.prepare(
    'DELETE FROM event_history WHERE event_id IN (SELECT id FROM events WHERE group_id = ?)',
  );
  const delSources = db.prepare(
    'DELETE FROM event_sources WHERE event_id IN (SELECT id FROM events WHERE group_id = ?)',
  );
  const delEvents = db.prepare('DELETE FROM events WHERE group_id = ?');
  const delMessages = db.prepare('DELETE FROM messages WHERE group_id = ?');
  const delGroup = db.prepare('DELETE FROM groups WHERE group_id = ?');

  beginTx();
  try {
    for (const id of groupIds) {
      delHistory.run(id);
      delSources.run(id);
      delEvents.run(id);
      delMessages.run(id);
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
