// 待办接口（FR-15）：群事件里满足 isTodo 的 + 用户手动添加的，合并返回。
// 「是否待办」现算不存状态；群事件打勾走 PATCH /api/events/:id {status:'done'}。
import type { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { parseLockedFields } from '../event-proposals.js';
import type { EventDTO, EventStatus, EventType, Level, TodoDTO, TodosDTO } from '../types.js';

/** 与 todo.ts 的 isTodo 完全等价的 SQL 条件（活跃 + 无截止 +（完全没时间 或 是作业）） */
export const TODO_SQL = `e.status IN ('active', 'pending_confirm') AND e.deadline_at IS NULL
    AND ((e.start_at IS NULL AND e.end_at IS NULL) OR e.type = 'assignment')`;

// ----- 群事件待办：与 business.ts 同一份列名/行形（TODO: 若加字段两边同步） -----

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

interface TodoRow {
  id: number;
  title: string;
  note: string;
  level: number;
  done_at: number | null;
  created_at: number;
}

const toTodoDTO = (r: TodoRow): TodoDTO => ({ ...r, level: r.level as Level });

const createSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(100, '标题最长 100 字'),
  note: z.string().trim().max(500).default(''),
  level: z.number().int().min(1).max(4).default(2),
});

const patchSchema = z
  .object({
    title: z.string().trim().min(1, '标题不能为空').max(100).optional(),
    note: z.string().trim().max(500).optional(),
    level: z.number().int().min(1).max(4).optional(),
    done: z.boolean().optional(),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), { message: '没有要改的字段' });

export function registerTodoRoutes(app: Hono): void {
  // 群待办：所有满足 isTodo 的事件，level 降序、created_at 升序；手动待办：未完成的
  app.get('/api/todos', (c) => {
    const rows = db
      .prepare(
        `SELECT e.*, g.name AS group_name FROM events e
           LEFT JOIN groups g ON g.group_id = e.group_id
          WHERE ${TODO_SQL}
          ORDER BY e.level DESC, e.created_at, e.id`,
      )
      .all() as unknown as EventRow[];
    const manual = db
      .prepare('SELECT * FROM todos WHERE done_at IS NULL ORDER BY created_at, id')
      .all() as unknown as TodoRow[];
    const body: TodosDTO = {
      events: rows.map(toEventDTO),
      manual: manual.map(toTodoDTO),
    };
    return c.json(body);
  });

  app.post('/api/todos', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? '参数不合法' }, 400);
    }
    const now = Date.now();
    const res = db
      .prepare('INSERT INTO todos (title, note, level, done_at, created_at) VALUES (?, ?, ?, NULL, ?)')
      .run(parsed.data.title, parsed.data.note, parsed.data.level, now);
    const row = db
      .prepare('SELECT * FROM todos WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as unknown as TodoRow;
    return c.json(toTodoDTO(row));
  });

  app.patch('/api/todos/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: '待办 id 不合法' }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? '参数不合法' }, 400);
    }

    const row = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as unknown as
      | TodoRow
      | undefined;
    if (row === undefined) return c.json({ error: '待办不存在' }, 404);

    const d = parsed.data;
    const doneAt = d.done === undefined ? row.done_at : d.done ? Date.now() : null;
    db.prepare('UPDATE todos SET title = ?, note = ?, level = ?, done_at = ? WHERE id = ?').run(
      d.title ?? row.title,
      d.note ?? row.note,
      d.level ?? row.level,
      doneAt,
      id,
    );
    const updated = db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as unknown as TodoRow;
    return c.json(toTodoDTO(updated));
  });
}
