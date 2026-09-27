// 长期记忆接口（FR-12）：开关 + 规则列表（逐条删 / 清空）。
// 规则由 pipeline/preferences.ts 的 summarize() 从 level_feedback 总结而来。
import type { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { invalidatePreferenceSummary, schedulePreferenceSummary } from '../pipeline/preferences.js';
import type { Level, LevelRuleDTO, MemoryDTO } from '../types.js';

function memoryDTO(): MemoryDTO {
  const enabled =
    (db.prepare("SELECT value FROM kv WHERE key = 'memory_enabled'").get() as { value: string } | undefined)
      ?.value !== '0';
  const rules = db
    .prepare('SELECT id, text, level FROM level_rules ORDER BY id')
    .all() as unknown as Array<{ id: number; text: string; level: Level }>;
  const feedback = db
    .prepare('SELECT COUNT(*) AS n FROM level_feedback')
    .get() as { n: number };
  return { enabled, rules: rules as LevelRuleDTO[], feedback_count: feedback.n };
}

const putSchema = z.object({ enabled: z.boolean() });

export function registerMemoryRoutes(app: Hono): void {
  app.get('/api/settings/memory', (c) => c.json(memoryDTO()));

  app.put('/api/settings/memory', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: '请求体不是合法 JSON' }, 400);
    }
    const parsed = putSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'enabled 只能是 true / false' }, 400);
    db.prepare(
      "INSERT INTO kv (key, value) VALUES ('memory_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(parsed.data.enabled ? '1' : '0');
    return c.json(memoryDTO());
  });

  // 删一条规则：它总结进来的调级记录标 ignored=1，之后总结不再用它们
  app.delete('/api/settings/memory/rules/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: '规则 id 不合法' }, 400);
    const row = db.prepare('SELECT feedback_ids FROM level_rules WHERE id = ?').get(id) as
      | { feedback_ids: string }
      | undefined;
    if (row === undefined) return c.json({ error: '规则不存在' }, 404);

    let ids: number[] = [];
    try {
      const v: unknown = JSON.parse(row.feedback_ids);
      if (Array.isArray(v)) ids = v.filter((n): n is number => typeof n === 'number');
    } catch {
      // feedback_ids 坏了就跳过标记，规则照删
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (ids.length) {
        db.prepare(
          'UPDATE level_feedback SET ignored = 1 WHERE id IN (SELECT value FROM json_each(?))',
        ).run(JSON.stringify(ids));
      }
      db.prepare('DELETE FROM level_rules WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // 剩下的记录重新总结一遍（防抖 5s）
    schedulePreferenceSummary();
    return c.json(memoryDTO());
  });

  // 清空：规则与调级记录都删掉
  app.delete('/api/settings/memory', (c) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM level_rules').run();
      db.prepare('DELETE FROM level_feedback').run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    invalidatePreferenceSummary(); // 正在跑的总结别把规则写回来
    return c.json(memoryDTO());
  });
}
