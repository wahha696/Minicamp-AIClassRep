// 长期记忆（FR-12）：开关、总结防抖、整体替换、失败保留旧规则、瞎编 id 过滤。
// OpenAI 客户端整个 mock 掉；key 用 saveLlmSettings 写进测试临时目录。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountDataState, setAccountsDirForTest, switchAccount } from '../accounts.js';
import { db, openDb } from '../db/index.js';
import { saveLlmSettings, setLlmSettingsDir } from '../ai-settings.js';
import { llmStats } from './stats.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(..._args: unknown[]) {}
  },
}));

import {
  invalidatePreferenceSummary,
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

let llmSettingsDir = '';

beforeAll(() => {
  llmSettingsDir = mkdtempSync(join(tmpdir(), 'classrep-preference-settings-'));
  setLlmSettingsDir(llmSettingsDir);
  openDb(':memory:');
  saveLlmSettings('deepseek', 'sk-test-key');
});
afterAll(() => {
  db.close();
  rmSync(llmSettingsDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});
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

  it('总结等 AI 期间用户删了规则 / 清空 → 这次结果丢掉，不把删掉的规则写回来', async () => {
    addFeedback();
    let release!: () => void;
    createMock.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(reply({ rules: [{ text: '刚被删的规则', level: 4, feedback_ids: [] }] })))),
    );
    const running = summarize();
    await vi.waitFor(() => expect(createMock).toHaveBeenCalled());
    invalidatePreferenceSummary(); // 路由里删规则 / 清空时会调
    release();
    await running;
    expect(rules()).toHaveLength(0);
  });

  it('总结等 AI 期间切换数据库 → 旧账号的迟到结果不能覆盖新账号规则', async () => {
    addFeedback({ title: '账号 A 的偏好' });
    let release!: () => void;
    createMock.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(reply({ rules: [{ text: '只属于 A', level: 4, feedback_ids: [] }] })))),
    );
    const running = summarize();
    await vi.waitFor(() => expect(createMock).toHaveBeenCalled());

    openDb(':memory:'); // 模拟账号 A → B：同一个 db 活绑定换到新 generation
    db.prepare("INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES ('账号 B 原有规则', 2, '[]', ?)").run(Date.now());
    release();
    await running;

    expect(rules().map((r) => r.text)).toEqual(['账号 B 原有规则']);
  });

  it('目标账号挂库失败且 dbGeneration 未变时，迟到总结也不能在错误账号状态写旧库', async () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-preference-account-'));
    const accounts = join(root, 'accounts');
    setAccountsDirForTest(accounts, join(root, 'fallback.db'));
    await switchAccount('11111');
    addFeedback({ title: '账号 A 的偏好' });
    db.prepare("INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES ('A 的旧规则', 2, '[]', ?)").run(Date.now());

    let release!: () => void;
    createMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve(reply({ rules: [{ text: 'A 的迟到总结', level: 4, feedback_ids: [] }] }));
      }),
    );
    const running = summarize();
    await vi.waitFor(() => expect(createMock).toHaveBeenCalledOnce());

    const blocker = join(accounts, '22222');
    writeFileSync(blocker, 'not a directory');
    await expect(switchAccount('22222')).rejects.toThrow();
    expect(accountDataState()).toBe('error');
    release();
    await running;

    expect(rules().map((r) => r.text)).toEqual(['A 的旧规则']);

    // 恢复 scheduler/account 状态并释放账号库句柄，Windows CI 才能删除临时目录。
    rmSync(blocker);
    await switchAccount('11111');
    setAccountsDirForTest(join(root, 'unused-accounts'), join(root, 'unused-fallback.db'));
    openDb(':memory:');
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
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
