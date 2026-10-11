// 用 :memory: 库；extractEvents 换成假的，不调 LLM
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { env } from '../env.js';
import { ingestMessages } from '../ingest/index.js';
import { cleanupOnce } from '../jobs/cleanup.js';
import { MOCK_DIR } from '../paths.js';
import type { Message } from '../types.js';
import { type ExtractInput, type ExtractedEvent, type LlmClient, extractEvents } from './extract.js';
import { isNoise } from './filter.js';
import { jevAvailable, scoreWithJev } from './jev.js';
import { getPipelineStats } from './index.js';
import { llmStats } from './stats.js';
import { LLM_RETRY_MS, quiesceScheduler, resetLlmRetry, resumeScheduler, runPipelineNow, runPipelineGroupNow, tick } from './scheduler.js';
import { getGroupFailure } from './failures.js';
import { setDesktopPipelinePaused } from './activity.js';
import { assistantMemoryState, assistantSuppression, saveAssistantMemory, deleteAssistantMemory } from '../assistant-memory.js';

vi.mock('./extract.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./extract.js')>()),
  extractEvents: vi.fn(),
}));
vi.mock('./jev.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev.js')>()),
  scoreWithJev: vi.fn(),
  jevAvailable: vi.fn(),
}));
const extract = vi.mocked(extractEvents);
const jev = vi.mocked(scoreWithJev);
const jevOn = vi.mocked(jevAvailable);

const NOW = Date.now();

/** 读一个剧本，按回放的方式换成 Message[] */
function scenario(name: string): Message[] {
  const sc = JSON.parse(readFileSync(join(MOCK_DIR, `${name}.json`), 'utf8')) as {
    group: { id: string; name: string };
    messages: { offset_minutes: number; sender: string; text: string }[];
  };
  return sc.messages.map((m, i) => ({
    message_id: `demo-${name}-${i + 1}`,
    group_id: sc.group.id,
    group_name: sc.group.name,
    sender_name: m.sender,
    text: m.text,
    sent_at: NOW + m.offset_minutes * 60_000,
  }));
}

const chat = (group: string, n: number, text = '明天几点上课来着'): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    message_id: `${group}-${i}`,
    group_id: group,
    group_name: group,
    sender_name: '同学',
    text,
    sent_at: NOW + i * 1000,
  }));

const created = (input: ExtractInput): ExtractedEvent => ({
  action: 'create',
  update_of: null,
  type: 'exam',
  title: '高数小测',
  description: '',
  start_at: NOW + 86400_000,
  end_at: null,
  deadline_at: null,
  location: 'A301',
  action_required: null,
  confidence: 0.9,
  level: 2,
  source_message_ids: [input.candidates[0]!.message_id],
});

const count = (where: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get() as { n: number }).n;

it('explicit memory excludes only future matching homework, records sources and keeps other notices', async () => {
  ingestMessages(chat('demo-physics', 2, '物理作业周五提交'), 'demo');
  db.prepare("UPDATE groups SET course_name='物理' WHERE group_id='demo-physics'").run();
  saveAssistantMemory({ text: '人工测试偏好', action: 'exclude_calendar', course: '物理', event_types: ['assignment'] });
  extract.mockImplementation(async input => [
    { ...created(input), type: 'assignment', title: '物理作业' },
    { ...created(input), title: '物理考试', source_message_ids: [input.candidates[1]!.message_id] },
  ]);
  await runPipelineNow();
  expect(db.prepare('SELECT title FROM events').all()).toEqual([{ title: '物理考试' }]);
  expect(count('processed = 1')).toBe(2);
  expect(count("decision_reason = 'user_preference'")).toBe(1);
  expect(assistantSuppression(assistantMemoryState().recent_suppressions[0]!.id)?.sources[0]?.text).toBe('物理作业周五提交');
});

it('edits, disabling and deletion of preferences affect subsequent real pipeline runs', async () => {
  const rule = saveAssistantMemory({ text: 'Synthetic explicit preference', action: 'exclude_calendar', course: 'Physics', event_types: ['assignment'] });
  extract.mockImplementation(async input => [{ ...created(input), type: 'assignment',
    title: `Synthetic assignment ${input.candidates[0]!.message_id}`,
    start_at: input.candidates[0]!.sent_at + 86400_000 }]);
  async function processNext(n: number) {
    ingestMessages([{ ...chat('synthetic-physics', 1, '作业通知：请完成教材练习')[0]!,
      message_id: `future-${n}`, sent_at: NOW + n * 7 * 86400_000 }], 'demo');
    db.prepare("UPDATE groups SET course_name='Physics' WHERE group_id='synthetic-physics'").run();
    await runPipelineNow();
    return db.prepare('SELECT decision_reason FROM messages WHERE message_id=?').get(`future-${n}`)?.decision_reason;
  }
  expect(await processNext(1)).toBe('user_preference');
  saveAssistantMemory({ course: 'Chemistry' }, rule.id);
  expect(await processNext(2)).toBe('event_recognized');
  saveAssistantMemory({ course: 'Physics', enabled: false }, rule.id);
  expect(await processNext(3)).toBe('event_recognized');
  saveAssistantMemory({ enabled: true }, rule.id);
  deleteAssistantMemory(rule.id);
  expect(await processNext(4)).toBe('event_recognized');
  expect(count('processed = 1')).toBe(4);
  expect(assistantMemoryState().rules).toEqual([]);
  expect(assistantMemoryState().recent_suppressions).toHaveLength(1);
  expect(assistantSuppression(assistantMemoryState().recent_suppressions[0]!.id)?.sources[0]?.message_id).toBe('future-1');
});

beforeEach(() => {
  setDesktopPipelinePaused(false);
  openDb(':memory:');
  extract.mockReset();
  extract.mockResolvedValue([]);
  jev.mockReset();
  jev.mockResolvedValue(null);
  jevOn.mockReset();
  jevOn.mockReturnValue(false);
  resetLlmRetry();
});
afterEach(() => { setDesktopPipelinePaused(false); vi.useRealTimers(); vi.restoreAllMocks(); });

it('AI在途时清理群，迟到响应不能重建事项或来源', async () => {
  ingestMessages(chat('demo-cleared', 15), 'demo');
  let resolve!: (events: ExtractedEvent[]) => void;
  let candidate!: ExtractInput;
  extract.mockImplementationOnce(input => { candidate = input; return new Promise(done => { resolve = done; }); });
  const running = tick();
  await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
  db.prepare('DELETE FROM messages WHERE group_id=?').run('demo-cleared');
  resolve([created(candidate)]); await running;
  expect(db.prepare('SELECT COUNT(*) n FROM events').get()!.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) n FROM event_sources').get()!.n).toBe(0);
});

describe('逐群失败控制', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    extract.mockRejectedValue(new Error('boom'));
  });

  it('只尝试三次；等待期间和暂停后不请求 AI；其他群照常处理', async () => {
    ingestMessages(chat('demo-a', 15), 'demo');
    for (let i = 0; i < 3; i++) {
      await tick();
      expect(extract).toHaveBeenCalledTimes(i + 1);
      await tick();
      expect(extract).toHaveBeenCalledTimes(i + 1);
      vi.setSystemTime(NOW + (i + 1) * LLM_RETRY_MS);
    }
    expect(getGroupFailure('demo-a')).toMatchObject({ paused: true, failed_attempts: 3, pending_count: 15 });
    await tick();
    expect(extract).toHaveBeenCalledTimes(3);

    ingestMessages(chat('demo-b', 15), 'demo');
    extract.mockResolvedValue([]);
    await tick();
    expect(count("processed = 0 AND group_id = 'demo-b'")).toBe(0);
    expect(count("processed = 0 AND group_id = 'demo-a'")).toBe(15);
    expect(extract).toHaveBeenCalledTimes(4);
  });

  it('暂停状态和消息跨数据库重开保留，重开不追加自动尝试', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'classrep-pipeline-restart-'));
    const path = join(dir, 'test.db');
    try {
      openDb(path);
      ingestMessages(chat('demo-a', 15), 'demo');
      for (let i = 0; i < 3; i++) {
        await tick();
        vi.setSystemTime(NOW + (i + 1) * LLM_RETRY_MS);
      }
      db.prepare('UPDATE messages SET sent_at = ?').run(NOW - 60 * 86400_000);
      openDb(path);
      expect(cleanupOnce(Date.now())).toBe(0);
      await tick();
      expect(extract).toHaveBeenCalledTimes(3);
      expect(count('processed = 0')).toBe(15);
      expect(getGroupFailure('demo-a')?.paused).toBe(true);
    } finally {
      openDb(':memory:');
      if (!dir.startsWith(join(tmpdir(), 'classrep-pipeline-restart-'))) throw new Error('unsafe test cleanup path');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('仅手动恢复目标群，成功后清掉失败状态，不恢复其他暂停群', async () => {
    ingestMessages([...chat('demo-a', 15), ...chat('demo-b', 15)], 'demo');
    for (let i = 0; i < 3; i++) {
      await tick();
      vi.setSystemTime(NOW + (i + 1) * LLM_RETRY_MS);
    }
    extract.mockResolvedValue([]);
    await runPipelineGroupNow('demo-a');
    expect(count("processed = 0 AND group_id = 'demo-a'")).toBe(0);
    expect(getGroupFailure('demo-a')).toBeNull();
    expect(getGroupFailure('demo-b')?.paused).toBe(true);
    expect(count("processed = 0 AND group_id = 'demo-b'")).toBe(15);
  });

  it('手动重试目标群不等待其他群的慢请求', async () => {
    ingestMessages(chat('demo-slow', 15), 'demo');
    let release!: () => void;
    extract.mockImplementation(async (input) => {
      if (input.groupId === 'demo-slow') await new Promise<void>((resolve) => { release = resolve; });
      return [];
    });
    const slow = tick();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    ingestMessages(chat('demo-target', 2), 'demo');
    const retry = runPipelineGroupNow('demo-target');
    try {
      await vi.waitFor(() => expect(count("processed = 0 AND group_id = 'demo-target'")).toBe(0));
      expect(count("processed = 0 AND group_id = 'demo-slow'")).toBe(15);
    } finally {
      release();
      await Promise.all([slow, retry]);
    }
  });

  it('有效配置改变后恢复，同一密钥重新保存或重启不能绕过暂停', async () => {
    const key = env.LLM_API_KEY;
    try {
      env.LLM_API_KEY = 'test-key-before';
      ingestMessages(chat('demo-a', 15), 'demo');
      for (let i = 0; i < 3; i++) {
        await tick();
        vi.setSystemTime(NOW + (i + 1) * LLM_RETRY_MS);
      }
      env.LLM_API_KEY = 'test-key-before';
      await tick();
      expect(extract).toHaveBeenCalledTimes(3);
      env.LLM_API_KEY = 'test-key-after';
      extract.mockResolvedValue([]);
      await tick();
      expect(count('processed = 0')).toBe(0);
      expect(getGroupFailure('demo-a')).toBeNull();
    } finally { env.LLM_API_KEY = key; }
  });

  it('一个群在等待重试时，新到另一个群的消息不等待同一倒计时', async () => {
    ingestMessages(chat('demo-a', 15), 'demo');
    await tick();
    ingestMessages(chat('demo-b', 15), 'demo');
    extract.mockResolvedValue([]);
    await tick();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(count("processed = 0 AND group_id = 'demo-b'")).toBe(0);
    expect(count("processed = 0 AND group_id = 'demo-a'")).toBe(15);
  });

  it('迟到失败不能写入换号后的数据库，也不能暂停新账号', async () => {
    ingestMessages(chat('demo-a', 15), 'demo');
    let reject!: (error: Error) => void;
    extract.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const running = tick();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    openDb(':memory:');
    ingestMessages(chat('demo-a', 15), 'demo');
    reject(new Error('late failure'));
    await running;
    expect(getGroupFailure('demo-a')).toBeNull();
    extract.mockResolvedValue([]);
    await tick();
    expect(count('processed = 0')).toBe(0);
  });

  it('失败状态写库异常时仍控制当前进程重试，换号后不能沿用旧兜底状态', async () => {
    db.exec("CREATE TRIGGER fail_failure_record BEFORE INSERT ON pipeline_failures BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    ingestMessages(chat('demo-a', 15), 'demo');
    for (let i = 0; i < 3; i++) {
      await tick();
      vi.setSystemTime(NOW + (i + 1) * LLM_RETRY_MS);
    }
    await tick();
    expect(extract).toHaveBeenCalledTimes(3);
    expect(getGroupFailure('demo-a')?.paused).toBe(true);
    expect(getGroupFailure('demo-a')?.state_saved).toBe(false);
    openDb(':memory:');
    ingestMessages(chat('demo-a', 15), 'demo');
    extract.mockResolvedValue([]);
    await tick();
    expect(count('processed = 0')).toBe(0);
  });
});

describe('desktop QQ pause', () => {
  function selectedWechat(n = 2) {
    db.prepare('INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES(?,?,1,?,?)')
      .run('synthetic-wechat', '人工微信群', 'wechat', NOW);
    ingestMessages(chat('synthetic-wechat', n), 'wechat');
  }

  it.each(['tick', 'all', 'group'] as const)('QQ pause keeps WeChat processing through %s', async (mode) => {
    selectedWechat(15); ingestMessages(chat('qq-paused', 15), 'demo');
    setDesktopPipelinePaused(true);
    if (mode === 'tick') await tick(NOW + 60_000);
    else if (mode === 'all') await runPipelineNow();
    else await runPipelineGroupNow('synthetic-wechat');
    expect(count("group_id='synthetic-wechat' AND processed=0")).toBe(0);
    expect(count("group_id='qq-paused' AND processed=0")).toBe(15);
    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]![0].groupId).toBe('synthetic-wechat');
  });

  it('QQ pause and recovery do not discard an in-flight WeChat AI reply', async () => {
    selectedWechat();
    let finish!: (events: ExtractedEvent[]) => void;
    extract.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const running = runPipelineNow();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    setDesktopPipelinePaused(true); setDesktopPipelinePaused(false);
    finish([created(extract.mock.calls[0]![0])]); await running;
    expect(count("processed=0")).toBe(0);
    expect(db.prepare('SELECT group_id FROM events').all()).toEqual([{ group_id: 'synthetic-wechat' }]);
  });

  it('space-switch quiescing still blocks WeChat replies and waits for them', async () => {
    selectedWechat();
    let finish!: (events: ExtractedEvent[]) => void;
    extract.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const running = runPipelineNow();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    const quiet = quiesceScheduler();
    try {
      finish([created(extract.mock.calls[0]![0])]); await Promise.all([running, quiet]);
      expect(count('processed=0')).toBe(2);
      expect(db.prepare('SELECT * FROM events').all()).toHaveLength(0);
    } finally { resumeScheduler(false); }
  });

  it('blocks new AI work and retries pending messages after returning', async () => {
    ingestMessages(chat('demo-paused', 2), 'demo');
    setDesktopPipelinePaused(true);
    await runPipelineNow();
    await tick(NOW + 60_000);
    expect(extract).not.toHaveBeenCalled();
    expect(count('processed = 0')).toBe(2);
    setDesktopPipelinePaused(false);
    await runPipelineNow();
    expect(count('processed = 0')).toBe(0);
  });
  it('discards an AI reply from before a pause even if the same account has resumed', async () => {
    ingestMessages(chat('demo-late', 2), 'demo');
    let finish!: (events: ExtractedEvent[]) => void;
    extract.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = runPipelineNow();
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    const input = extract.mock.calls[0]![0];
    setDesktopPipelinePaused(true);
    setDesktopPipelinePaused(false);
    finish([created(input)]);
    await running;
    expect(db.prepare('SELECT * FROM events').all()).toHaveLength(0);
    expect(count('processed = 0')).toBe(2);
    await runPipelineNow();
    expect(count('processed = 0')).toBe(0);
  });
  it('does not let a late fast-judge reply mark messages filtered during QQ mode', async () => {
    ingestMessages(chat('demo-jev-late', 2), 'demo');
    let finish!: (scores: number[]) => void;
    jev.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const running = runPipelineNow();
    await vi.waitFor(() => expect(jev).toHaveBeenCalledOnce());
    setDesktopPipelinePaused(true);
    finish([0, 0]);
    await running;
    expect(count('filtered_out = 1')).toBe(0);
    expect(count('processed = 0')).toBe(2);
  });
});

describe('runPipelineNow', () => {
  it('reschedule 剧本：全部置已处理，噪声置 filtered_out，按 30 条分批，事件入库', async () => {
    const msgs = scenario('reschedule');
    ingestMessages(msgs, 'demo');
    extract.mockImplementationOnce(async (input) => [created(input)]);

    await runPipelineNow();

    expect(count('processed = 0')).toBe(0);
    const noise = msgs.filter((m) => isNoise(m.text)).length;
    expect(count('filtered_out = 1')).toBe(noise);
    expect(getPipelineStats().filtered_count).toBe(noise);

    // 68 条 → 30 + 30 + 8，每批都有候选
    expect(extract).toHaveBeenCalledTimes(3);
    const calls = extract.mock.calls.map(([input]) => input);
    for (const input of calls) {
      expect(input.groupName).toBe(msgs[0]!.group_name);
      expect(input.candidates.every((m) => !isNoise(m.text))).toBe(true);
    }
    // 第 1 批没有上文；第 2 批的上文 = 之前最近的 ≤10 条非噪声消息（这里就是第 1 批的候选）
    expect(calls[0]!.context).toEqual([]);
    expect(calls[1]!.context).toEqual(calls[0]!.candidates.slice(-10));
    // 第 3 批（8 条）的上文取满 10 条，且都早于本批
    expect(calls[2]!.context).toHaveLength(10);
    expect(calls[2]!.context.every((m) => m.sent_at < calls[2]!.candidates[0]!.sent_at)).toBe(true);
    // 第 2 批起能看到第 1 批建的事件
    expect(calls[1]!.activeEvents.map((e) => e.title)).toEqual(['高数小测']);

    const ev = db.prepare('SELECT * FROM events').all() as { group_id: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0]!.group_id).toBe(msgs[0]!.group_id);
  });

  it('extract 意外抛错：保留消息，自动调度等待，手动重试可恢复', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingestMessages(chat('demo-a', 20), 'demo');
    extract.mockRejectedValue(new Error('boom'));
    await expect(runPipelineNow()).resolves.toBeUndefined();
    expect(count('processed = 0')).toBe(20);
    expect(extract).toHaveBeenCalledOnce();
    await tick();
    expect(extract).toHaveBeenCalledOnce();
    extract.mockResolvedValue([]);
    await runPipelineNow();
    expect(count('processed = 0')).toBe(0);
    expect(count("decision_reason = 'llm_no_event'")).toBe(20);
  });

  it('逐条记录已识别、未识别与待确认原因', async () => {
    ingestMessages(chat('demo-decisions', 2), 'demo');
    extract.mockImplementationOnce(async (input) => [created(input)]);
    await runPipelineNow();
    expect(count("decision_reason = 'event_recognized'")).toBe(1);
    expect(count("decision_reason = 'llm_no_event'")).toBe(1);

    // 换一个群避免被上面已识别的同时间事件合并，这里只验证低置信新建事件的解释。
    const pending = chat('demo-pending', 1, '听说明天可能有考试');
    pending[0]!.message_id = 'pending-one';
    ingestMessages(pending, 'demo');
    extract.mockImplementationOnce(async (input) => [{ ...created(input), confidence: 0.5 }]);
    await runPipelineNow();
    expect(count("decision_reason = 'pending_confirmation'")).toBe(1);
  });

  it('真实提取器未配置 AI 时保留消息；之后配置成功可提取入库', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { extractEvents: realExtract } = await vi.importActual<typeof import('./extract.js')>('./extract.js');
    const key = env.LLM_API_KEY;
    try {
      env.LLM_API_KEY = '';
      ingestMessages(chat('demo-a', 2), 'demo');
      extract.mockImplementation((input, _client, status) => realExtract(input, undefined, status));
      await runPipelineNow();
      expect(count('processed = 0')).toBe(2);
      expect(llmStats.llm).toBe('unconfigured');
      expect(db.prepare('SELECT * FROM events').all()).toHaveLength(0);

      extract.mockImplementation(async (input) => [created(input)]);
      await runPipelineNow();
      expect(count('processed = 0')).toBe(0);
      expect(db.prepare('SELECT * FROM events').all()).toHaveLength(1);
    } finally {
      env.LLM_API_KEY = key;
    }
  });

  it('真实提取器格式错误保留整批，修复输出后成功的空列表可完成处理', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { extractEvents: realExtract } = await vi.importActual<typeof import('./extract.js')>('./extract.js');
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'not json' } }] });
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    ingestMessages(chat('demo-a', 20), 'demo');
    extract.mockImplementation((input, _client, status) => realExtract(input, client, status));
    await runPipelineNow();
    expect(count('processed = 0')).toBe(20);
    expect(create).toHaveBeenCalledTimes(2);
    expect(llmStats.llm).toBe('error');
    create.mockResolvedValue({ choices: [{ message: { content: '{"events": []}' } }] });
    await runPipelineNow();
    expect(count('processed = 0')).toBe(0);
    expect(db.prepare('SELECT * FROM events').all()).toHaveLength(0);
  });

  it('事件入库失败会回滚，消息保留；恢复后可重试', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingestMessages(chat('demo-a', 2), 'demo');
    extract.mockImplementation(async (input) => [created(input)]);
    db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    await runPipelineNow();
    expect(count('processed = 0')).toBe(2);
    expect(db.prepare('SELECT * FROM events').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM event_sources').all()).toHaveLength(0);
    await tick();
    expect(extract).toHaveBeenCalledOnce();
    db.exec('DROP TRIGGER fail_events');
    await runPipelineNow();
    expect(count('processed = 0')).toBe(0);
    expect(db.prepare('SELECT * FROM events').all()).toHaveLength(1);
  });

  it('事件已写入但处理标记失败时，重试不重复创建事件和来源', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingestMessages(chat('demo-a', 2), 'demo');
    extract.mockImplementation(async (input) => [created(input)]);
    db.exec("CREATE TRIGGER fail_processed BEFORE UPDATE OF processed ON messages BEGIN SELECT RAISE(ABORT, 'test flag failure'); END");
    await runPipelineNow();
    expect(count('processed = 0')).toBe(2);
    expect(db.prepare('SELECT * FROM events').all()).toHaveLength(1);
    await tick();
    expect(extract).toHaveBeenCalledOnce();
    db.exec('DROP TRIGGER fail_processed');
    await runPipelineNow();
    expect(count('processed = 0')).toBe(0);
    expect(db.prepare('SELECT * FROM events').all()).toHaveLength(1);
    expect(db.prepare('SELECT * FROM event_sources').all()).toHaveLength(1);
  });

  it('其他群连续清理多批积压时，本次手动处理只尝试失败群一次', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingestMessages([...chat('demo-a', 5), ...chat('demo-b', 95)], 'demo');
    extract.mockImplementation(async (input) => {
      if (input.groupId === 'demo-a') throw new Error('boom');
      return [];
    });
    await runPipelineNow();
    expect(count("processed = 0 AND group_id = 'demo-a'")).toBe(5);
    expect(count("processed = 0 AND group_id = 'demo-b'")).toBe(0);
    expect(extract.mock.calls.filter(([input]) => input.groupId === 'demo-a')).toHaveLength(1);
    expect(extract.mock.calls.filter(([input]) => input.groupId === 'demo-b')).toHaveLength(4);
  });

  it('AI 连不上：这批不置已处理，歇一会；之后连上了再处理', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingestMessages(chat('demo-a', 20), 'demo');
    extract.mockImplementation(async (_input, _client, status) => {
      status!.llmFailed = true; // 真的 extractEvents 连不上时就是这样
      return [];
    });
    await runPipelineNow();
    expect(count('processed = 0')).toBe(20);
    expect(extract).toHaveBeenCalledOnce(); // 没有空转

    extract.mockClear();
    await tick(); // 刚失败，自动调度先不重试
    expect(extract).not.toHaveBeenCalled();

    extract.mockResolvedValue([]);
    resetLlmRetry(); // 相当于等过了 60s
    await tick(Date.now() + 60_000);
    expect(count('processed = 0')).toBe(0);
  });

  it('多群并发：一个群 AI 连不上，不连累同时在跑的别的群', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingestMessages([...chat('demo-a', 5), ...chat('demo-b', 5)], 'demo');
    extract.mockImplementation(async (input, _client, status) => {
      await new Promise((r) => setTimeout(r, 10)); // 让两个群的调用重叠
      if (input.groupId === 'demo-a') {
        llmStats.failed++;
        status!.llmFailed = true;
      }
      return [];
    });
    await runPipelineNow();
    const left = db.prepare('SELECT group_id, COUNT(*) n FROM messages WHERE processed = 0 GROUP BY group_id').all();
    expect(left).toEqual([{ group_id: 'demo-a', n: 5 }]);
  });

  it('候选全是噪声就不调 LLM', async () => {
    ingestMessages(chat('demo-a', 20, '收到'), 'demo');
    await runPipelineNow();
    expect(extract).not.toHaveBeenCalled();
    expect(count('filtered_out = 1')).toBe(20);
    expect(count("decision_reason = 'rule_noise'")).toBe(20);
  });

  it('Jev 丢弃闲聊、保留改期，并在没有剩余候选时省去 LLM', async () => {
    const messages = chat('demo-jev', 3, '今天作业提交安排是什么');
    messages[0]!.text = '下周二交实验报告';
    messages[1]!.text = '今晚约饭吗同学们';
    messages[2]!.text = '实验报告改成周五交';
    ingestMessages(messages, 'demo');
    jev.mockResolvedValueOnce([0.95, 0.05, 0.9]);
    await runPipelineNow();
    expect(extract.mock.calls[0]![0].candidates.map((m) => m.text)).toEqual([
      '下周二交实验报告', '实验报告改成周五交',
    ]);
    expect(count('filtered_out = 1')).toBe(1);
    expect(count("decision_reason = 'jev_below_threshold'")).toBe(1);
    expect(getPipelineStats().jev_filtered_count).toBeGreaterThanOrEqual(1);

    const onlyChat = chat('demo-jev', 1, '晚上一起打游戏吗');
    onlyChat[0]!.message_id = 'another-chat';
    ingestMessages(onlyChat, 'demo');
    jev.mockResolvedValueOnce([0.03]);
    extract.mockClear();
    await runPipelineNow();
    expect(extract).not.toHaveBeenCalled();
  });

  it('Jev 失败时原候选全部交给 LLM', async () => {
    const messages = chat('demo-jev-fallback', 2, '明天考试地点有改动');
    ingestMessages(messages, 'demo');
    jev.mockResolvedValueOnce(null);
    await runPipelineNow();
    expect(extract.mock.calls[0]![0].candidates).toHaveLength(2);
    expect(count('filtered_out = 1')).toBe(0);
  });

  it('关掉的群不处理，也不会空转', async () => {
    ingestMessages(chat('demo-off', 5), 'demo');
    db.prepare("UPDATE groups SET enabled = 0 WHERE group_id = 'demo-off'").run();
    await runPipelineNow();
    expect(count('processed = 0')).toBe(5);
  });

  it('同一个群不并发，不同群并发处理', async () => {
    ingestMessages([...chat('demo-a', 40), ...chat('demo-b', 40)], 'demo');
    const running = new Map<string, number>();
    let peakSame = 0;
    let peakAll = 0;
    extract.mockImplementation(async (input) => {
      const g = input.groupName;
      running.set(g, (running.get(g) ?? 0) + 1);
      peakSame = Math.max(peakSame, running.get(g)!);
      peakAll = Math.max(peakAll, [...running.values()].reduce((a, b) => a + b, 0));
      await new Promise((r) => setTimeout(r, 5));
      running.set(g, running.get(g)! - 1);
      return [];
    });
    await Promise.all([runPipelineNow(), runPipelineNow(), tick(NOW + 60_000)]);
    expect(peakSame).toBe(1);
    expect(peakAll).toBe(2); // 两个群同时跑，不用排队
    expect(extract).toHaveBeenCalledTimes(4); // 两个群各 30 + 10
    expect(count('processed = 0')).toBe(0);
  });
});

describe('tick 阈值（Jev 不可用时的老规则）', () => {
  it('不到 15 条且等了不到 20 秒 → 不处理；等够 20 秒 → 处理', async () => {
    const t0 = Date.now();
    ingestMessages(chat('demo-a', 5), 'demo');
    await tick(t0 + 5_000);
    expect(count('processed = 0')).toBe(5);
    await tick(t0 + 60_000);
    expect(count('processed = 0')).toBe(0);
  });

  it('攒够 15 条立刻处理', async () => {
    const t0 = Date.now();
    ingestMessages(chat('demo-a', 15), 'demo');
    ingestMessages(chat('demo-b', 3), 'demo');
    await tick(t0);
    expect(count("processed = 0 AND group_id = 'demo-a'")).toBe(0);
    expect(count("processed = 0 AND group_id = 'demo-b'")).toBe(3);
  });
});

describe('tick：Jev 分数决定等多久', () => {
  beforeEach(() => jevOn.mockReturnValue(true));

  it('不同群相同 message_id 的 Jev 分数互不覆盖', async () => {
    const t0 = Date.now();
    const a = chat('demo-a', 1, '今晚约饭吗同学们');
    const b = chat('demo-b', 1, '明天下午两点 A301 小测');
    a[0]!.message_id = b[0]!.message_id = 'same-id';
    ingestMessages([...a, ...b], 'demo');
    jev.mockImplementation(async (_messages, _context, groupName) => [groupName === 'demo-a' ? 0.01 : 0.95]);
    await tick(t0 + 1_000);
    expect(count("processed = 0 AND group_id = 'demo-a'")).toBe(0);
    expect(count("processed = 0 AND group_id = 'demo-b'")).toBe(1);
    expect(extract).not.toHaveBeenCalled();
    await tick(t0 + 3_500);
    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]![0].groupId).toBe('demo-b');
  });

  it('确定是通知（≥0.8）：群里安静 3 秒就处理，不等 20 秒', async () => {
    const t0 = Date.now();
    ingestMessages(chat('demo-u', 2, '明天下午两点 A301 小测'), 'demo');
    jev.mockResolvedValueOnce([0.95, 0.4]);
    await tick(t0 + 1_000); // 刚发完：先打分，还在等后续补充
    expect(jev).toHaveBeenCalledOnce();
    expect(count('processed = 0')).toBe(2);
    await tick(t0 + 3_500);
    expect(count('processed = 0')).toBe(0);
    expect(jev).toHaveBeenCalledOnce(); // 批次复用分诊时的分数，不再请求 Jev
    expect(extract.mock.calls[0]![0].candidates).toHaveLength(2);
  });

  it('全部确定不是（<0.2）：立刻收尾且不调 LLM', async () => {
    const t0 = Date.now();
    ingestMessages(chat('demo-d', 3, '今晚约饭吗同学们'), 'demo');
    jev.mockResolvedValueOnce([0.05, 0.1, 0.02]);
    await tick(t0 + 500);
    expect(count('processed = 0')).toBe(0);
    expect(count('filtered_out = 1')).toBe(3);
    expect(extract).not.toHaveBeenCalled();
  });

  it('拿不准（0.2~0.8）：等 8 秒攒上下文再交给 LLM', async () => {
    const t0 = Date.now();
    ingestMessages(chat('demo-m', 2, '那下周还办吗'), 'demo');
    jev.mockResolvedValueOnce([0.5, 0.3]);
    await tick(t0 + 5_000);
    expect(count('processed = 0')).toBe(2);
    await tick(t0 + 8_500);
    expect(count('processed = 0')).toBe(0);
    expect(extract).toHaveBeenCalledOnce();
  });

  it('Jev 失败：退回老规则，候选全部交给 LLM', async () => {
    const t0 = Date.now();
    ingestMessages(chat('demo-f', 2, '明天考试地点有改动'), 'demo');
    jev.mockResolvedValue(null);
    await tick(t0 + 5_000);
    expect(count('processed = 0')).toBe(2);
    await tick(t0 + 25_000);
    expect(count('processed = 0')).toBe(0);
    expect(extract.mock.calls[0]![0].candidates).toHaveLength(2);
  });

  it('静默会等待仍在 Jev 分诊的入口，迟到分数不能再改库', async () => {
    ingestMessages(chat('demo-switching', 2, '明天考试地点有改动'), 'demo');
    let release!: () => void;
    jev.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve([0.01, 0.02]);
      }),
    );

    const running = tick(NOW + 500);
    await vi.waitFor(() => expect(jev).toHaveBeenCalledOnce());
    let quiesced = false;
    const quiet = quiesceScheduler().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false); // 切库必须等这个尚未登记进 inflight 的分诊入口

    try {
      release();
      await Promise.all([running, quiet]);
      expect(count('processed = 0')).toBe(2);
      expect(count('filtered_out = 1')).toBe(0);
    } finally {
      resumeScheduler(false);
    }
  });
});

describe('getPipelineStats', () => {
  it('账号数据不可公开时不查询/返回旧账号的聚合计数', () => {
    ingestMessages(chat('demo-private', 2), 'demo');
    db.prepare('UPDATE messages SET filtered_out = 1').run();
    const previousCalled = llmStats.called;
    try {
      llmStats.called = 7;
      expect(getPipelineStats()).toMatchObject({ filtered_count: 2, llm_called_count: 7 });
      expect(getPipelineStats(false)).toMatchObject({
        filtered_count: 0,
        jev_filtered_count: 0,
        jev_called_count: 0,
        llm_called_count: 0,
      });
    } finally {
      llmStats.called = previousCalled;
    }
  });

  it('没配 key 报 unconfigured', () => {
    const key = env.LLM_API_KEY;
    env.LLM_API_KEY = '';
    expect(getPipelineStats().llm).toBe('unconfigured');
    env.LLM_API_KEY = 'x';
    expect(getPipelineStats().llm).not.toBe('unconfigured');
    env.LLM_API_KEY = key;
  });
});
