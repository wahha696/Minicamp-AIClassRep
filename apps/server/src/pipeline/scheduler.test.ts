// 用 :memory: 库；extractEvents 换成假的，不调 LLM
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { env } from '../env.js';
import { ingestMessages } from '../ingest/index.js';
import { MOCK_DIR } from '../paths.js';
import type { Message } from '../types.js';
import { type ExtractInput, type ExtractedEvent, extractEvents } from './extract.js';
import { isNoise } from './filter.js';
import { jevAvailable, scoreWithJev } from './jev.js';
import { getPipelineStats } from './index.js';
import { llmStats } from './stats.js';
import { quiesceScheduler, resetLlmRetry, resumeScheduler, runPipelineNow, tick } from './scheduler.js';
import { setDesktopPipelinePaused } from './activity.js';

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
afterEach(() => { setDesktopPipelinePaused(false); vi.restoreAllMocks(); });

describe('desktop QQ pause', () => {
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

  it('extract 出错也置已处理，不抛', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ingestMessages(chat('demo-a', 20), 'demo');
    extract.mockRejectedValue(new Error('boom'));
    await expect(runPipelineNow()).resolves.toBeUndefined();
    expect(count('processed = 0')).toBe(0);
    expect(count("decision_reason = 'pipeline_error'")).toBe(20);
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
