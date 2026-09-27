import OpenAI from 'openai';
import { z } from 'zod';

import { db } from '../db/index.js';
import { getLlmConfig } from '../llm-settings.js';
import type { Level } from '../types.js';
import type { LlmClient } from './extract.js';

/** 记忆开关：kv.memory_enabled，默认 '1'。关了 AI 不用规则，但调级仍记录。 */
export function memoryEnabled(): boolean {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'memory_enabled'").get() as
    | { value: string }
    | undefined;
  return row ? row.value === '1' : true;
}

/** 给抽取提示词用的规则列表 */
export function preferenceRules(): Array<{ text: string; level: Level }> {
  return db
    .prepare('SELECT text, level FROM level_rules ORDER BY id')
    .all() as Array<{ text: string; level: Level }>;
}

interface FeedbackRow {
  id: number;
  group_name: string;
  type: string;
  title: string;
  ai_level: number;
  user_level: number;
}

const SummarySchema = z.object({
  rules: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(100),
        level: z.number().int().min(1).max(4),
        feedback_ids: z.array(z.number().int()).default([]),
      }),
    )
    .max(12)
    .default([]),
});

const PROMPT = `你在维护「用户对日程事件危机等级的偏好」。输入是用户手动调级的记录（JSON 数组）：
[{"id":1,"group_name":"软工A班","type":"assignment","title":"大物实验报告","ai_level":2,"user_level":4}, ...]
把相似的调级总结成一句规则（不超过 12 条），每条：
- text：一句话、不超过 50 字、带「一律」或「默认」；
- level：1~4 整数，这条规则下事件应该的等级；
- feedback_ids：覆盖到哪些调级记录的 id 数组。
规则要能泛化：类型 + 关键词组合，不要逐字复述标题。
冲突时按 user_level 偏离 ai_level 更远的优先。
输出 JSON：{"rules": [{"text": "...", "level": 4, "feedback_ids": [1, 2]}]}`;

let client: LlmClient | null = null;
let clientKey = '';

function getClient(): LlmClient {
  const cfg = getLlmConfig();
  const key = `${cfg.baseURL}\n${cfg.model}`;
  if (!client || clientKey !== key) {
    client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, timeout: 30_000 });
    clientKey = key;
  }
  return client;
}

/** 防抖：调级/改规则后 5s 总结一次 */
let timer: NodeJS.Timeout | null = null;

/**
 * 代数：删规则 / 清空 / 又排了一次新总结时 +1。总结要等 AI 好几秒，回来时代数变了就不写——
 * 否则会把用户刚删掉的规则（用的是删之前的调级记录）写回去。
 */
let generation = 0;

/** 让正在进行的总结作废（清空记忆时用；删规则走 schedulePreferenceSummary，同样会作废） */
export function invalidatePreferenceSummary(): void {
  generation++;
}

export function schedulePreferenceSummary(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void summarize();
  }, 5_000);
  timer.unref?.();
}

/** 把最近 100 条未忽略调级记录总结成规则，事务性替换 level_rules。失败时保留旧规则。 */
export async function summarize(): Promise<void> {
  const gen = generation;
  const feedback = db
    .prepare(
      `SELECT id, group_name, type, title, ai_level, user_level
       FROM level_feedback WHERE ignored = 0 ORDER BY id DESC LIMIT 100`,
    )
    .all() as unknown as FeedbackRow[];

  if (feedback.length === 0) {
    // 记录清空了就把规则也清掉（事务保证中间态不会留下"无规则但有记录"）
    db.exec('DELETE FROM level_rules');
    return;
  }

  const cfg = getLlmConfig();
  if (!cfg.apiKey) {
    console.warn('[preferences] no API key configured, skip summarize');
    return;
  }

  let rules: z.infer<typeof SummarySchema>['rules'];
  try {
    const resp = await getClient().chat.completions.create({
      model: cfg.model,
      temperature: 0,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: JSON.stringify(feedback) },
      ],
    });
    const raw = resp.choices[0]?.message?.content ?? '';
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const parsed = SummarySchema.safeParse(JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw));
    if (!parsed.success) {
      console.warn('[preferences] invalid rules JSON, keep old rules:', parsed.error.issues[0]?.message);
      return;
    }
    rules = parsed.data.rules;
  } catch (e) {
    console.warn('[preferences] summarize failed, keep old rules:', (e as Error).message);
    return;
  }

  if (gen !== generation) {
    console.warn('[preferences] 总结期间记忆有改动，丢弃这次结果');
    return;
  }

  const validIds = new Set(feedback.map((f) => f.id));
  const now = Date.now();
  const del = db.prepare('DELETE FROM level_rules');
  const ins = db.prepare(
    'INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES (?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    del.run();
    for (const r of rules) {
      // AI 可能瞎编 id，只保留这批真实存在的
      const ids = r.feedback_ids.filter((id) => validIds.has(id));
      ins.run(r.text, r.level, JSON.stringify(ids), now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
