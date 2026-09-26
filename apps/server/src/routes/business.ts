// 业务路由：今日 / 事件查询 / 事件详情 / 改状态。主人是 B。
// 导出（B4）、群管理（B5）、演示（B6）后续补。
import type { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import type {
  EventDTO,
  EventDetailDTO,
  EventStatus,
  HistoryDTO,
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
  version: number;
  created_at: number;
  updated_at: number;
}

// 排序时间（COALESCE）与 id 兜底：无时间的事件排在最后，且顺序稳定
const EVENT_COLUMNS = `
  e.id, e.group_id, g.name AS group_name, e.type, e.title, e.description,
  e.start_at, e.end_at, e.deadline_at, e.location, e.action_required,
  e.status, e.confidence, e.version, e.created_at, e.updated_at
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

/** 状态不是 cancelled，且 start_at 或 deadline_at 落在 [from, to) 内 */
function selectEventsInRange(from: number, to: number): EventDTO[] {
  return selectEvents(
    `WHERE e.status <> 'cancelled'
       AND ((e.start_at IS NOT NULL AND e.start_at >= ? AND e.start_at < ?)
         OR (e.deadline_at IS NOT NULL AND e.deadline_at >= ? AND e.deadline_at < ?))`,
    [from, to, from, to],
  );
}

/** 全部非 cancelled（含两个时间都为空的） */
function selectAllEvents(): EventDTO[] {
  return selectEvents(`WHERE e.status <> 'cancelled'`, []);
}

function getEventById(id: number): EventDTO | null {
  const row = db.prepare(`SELECT ${EVENT_COLUMNS} ${EVENT_FROM} WHERE e.id = ?`).get(id) as
    | unknown as EventRow
    | undefined;
  return row === undefined ? null : toEventDTO(row);
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
const patchEventSchema = z.object({ status: z.enum(EVENT_STATUSES) });

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

  // 事件详情：sources 按时间升序，history 按 version 升序
  app.get('/api/events/:id', (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: '事件 id 不合法' }, 400);
    const event = getEventById(id);
    if (event === null) return c.json({ error: '事件不存在' }, 404);

    const sources = db
      .prepare(
        'SELECT message_id, sender_name, text, sent_at FROM event_sources WHERE event_id = ? ORDER BY sent_at, message_id',
      )
      .all(id) as unknown as SourceMessageDTO[];

    const historyRows = db
      .prepare(
        'SELECT version, changed_fields, source_message_id, changed_at FROM event_history WHERE event_id = ? ORDER BY version',
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

    const body: EventDetailDTO = { ...event, sources, history };
    return c.json(body);
  });

  // 手动改状态（完成 / 取消）
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
      return c.json({ error: `status 只能是 ${EVENT_STATUSES.join(' / ')}` }, 400);
    }

    const res = db
      .prepare('UPDATE events SET status = ?, updated_at = ? WHERE id = ?')
      .run(parsed.data.status, Date.now(), id);
    if (res.changes === 0) return c.json({ error: '事件不存在' }, 404);

    const event = getEventById(id);
    if (event === null) return c.json({ error: '事件不存在' }, 404);
    return c.json(event);
  });
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
