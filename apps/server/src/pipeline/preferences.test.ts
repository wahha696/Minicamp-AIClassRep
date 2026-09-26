// 长期记忆（FR-12）：开关、总结防抖、整体替换、失败保留旧规则、瞎编 id 过滤。
// OpenAI 客户端整个 mock 掉；key 用 saveLlmSettings 写进测试临时目录。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { saveLlmSettings } from '../llm-settings.js';
import { llmStats } from './stats.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(..._args: unknown[]) {}
  },
}));

import {
  memoryEnabled,
  preferenceRules,
  schedulePreferenceSummary,
  summarize,
} from './preferences.js';

function addFeedback(over: { title?: string; ai_level?: number; user_level?: number; ignored?: number } = {}): number {
  const res = db
    .prepare(
      `INSERT INTO level_feedback (event_id, group_name, type, title, ai_level, user_level, ignored, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, '软工A班', 'assignment', over.title ?? '大物实验报告', over.ai_level ?? 2, over.user_level ?? 4, over.ignored ?? 0, Date.now());
  return Number(res.lastInsertRowid);
}

const rules = () => db.prepare('SELECT * FROM level_rules ORDER BY id').all() as Record<string, unknown>[];

const reply = (body: unknown) => ({
  choices: [{ message: { content: JSON.stringify(body) } }],
});

beforeAll(() => {
  openDb(':memory:');
  saveLlmSettings('deepseek', 'sk-test-key');
});
afterAll(() => db.close());
beforeEach(() => {
  db.exec('DELETE FROM level_feedback; DELETE FROM level_rules;');
  createMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('memoryEnabled', () => {
  it('默认开；kv 写 0 就关', () => {
    expect(memoryEnabled()).toBe(true);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('memory_enabled', '0')").run();
    expect(memoryEnabled()).toBe(false);
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('memory_enabled', '1')").run();
  });
});

describe('summarize', () => {
  it('没有未忽略的记录 → 规则清空', async () => {
    db.prepare("INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES ('旧规则', 4, '[]', ?)").run(Date.now());
    await summarize();
    expect(rules()).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('成功：规则整体替换，feedback_ids 只留真实存在的', async () => {
    const a = addFeedback({ title: '大物实验报告', user_level: 4 });
    const b = addFeedback({ title: '大物作业', user_level: 4 });
    db.prepare("INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES ('旧规则', 1, '[]', ?)").run(Date.now());
    createMock.mockResolvedValueOnce(
      reply({ rules: [{ text: '大物相关一律紧急', level: 4, feedback_ids: [a, b, 9999] }] }),
    );
    await summarize();
    const rs = rules();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ text: '大物相关一律紧急', level: 4 });
    expect(JSON.parse(rs[0]!.feedback_ids as string)).toEqual([a, b]); // 9999 被滤掉
  });

  it('ignored=1 的记录不进总结输入', async () => {
    addFeedback({ title: '算数的' });
    addFeedback({ title: '被忽略的', ignored: 1 });
    let seen = '';
    createMock.mockImplementationOnce(async (args: { messages: { content: string }[] }) => {
      seen = args.messages[1]!.content;
      return reply({ rules: [] });
    });
    await summarize();
    expect(seen).toContain('算数的');
    expect(seen).not.toContain('被忽略的');
  });

  it('AI 抛错 → 保留旧规则，且不增加 llmStats.failed', async () => {
    db.prepare("INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES ('旧规则', 3, '[]', ?)").run(Date.now());
    addFeedback();
    const before = llmStats.failed;
    createMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await summarize();
    expect(rules().map((r) => r.text)).toEqual(['旧规则']);
    expect(llmStats.failed).toBe(before);
  });

  it('AI 返回非法 JSON → 保留旧规则', async () => {
    db.prepare("INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES ('旧规则', 3, '[]', ?)").run(Date.now());
    addFeedback();
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: 'not json at all' } }] });
    await summarize();
    expect(rules().map((r) => r.text)).toEqual(['旧规则']);
  });
});

describe('schedulePreferenceSummary 防抖', () => {
  it('5 秒内连续调度只总结一次', async () => {
    vi.useFakeTimers();
    try {
      addFeedback();
      createMock.mockResolvedValue(reply({ rules: [] }));
      schedulePreferenceSummary();
      schedulePreferenceSummary();
      schedulePreferenceSummary();
      expect(createMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      // summarize 是 async 的：再等一拍让它跑完
      await vi.advanceTimersByTimeAsync(0);
      expect(createMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
