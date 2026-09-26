import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import type { Message } from '../types.js';
import {
  type ExtractInput,
  type LlmClient,
  buildSystemPrompt,
  extractEvents,
  fmtShanghai,
  parseExtraction,
  parseTime,
} from './extract.js';
import { llmStats } from './stats.js';

// 2026-09-26 13:30 星期六（Asia/Shanghai）
const NOW = Date.parse('2026-09-26T13:30+08:00');

const msg = (id: string, text: string, minutesAgo = 10): Message => ({
  message_id: id,
  group_id: 'demo-test',
  group_name: '测试群',
  sender_name: '班长',
  text,
  sent_at: NOW - minutesAgo * 60_000,
});

const input = (candidates: Message[]): ExtractInput => ({
  groupName: '测试群',
  candidates,
  context: [],
  now: NOW,
  activeEvents: [],
});

const ev = (over: Record<string, unknown> = {}) => ({
  action: 'create',
  update_of: null,
  type: 'exam',
  title: '高数小测',
  description: '',
  start_at: '2026-09-27T14:00+08:00',
  end_at: null,
  deadline_at: null,
  location: 'A301',
  action_required: null,
  confidence: 0.9,
  source_message_ids: ['m1'],
  ...over,
});

/** 按顺序吐出给定回复的假 client；Error 表示这次调用抛网络错误 */
function fakeClient(...replies: (string | Error)[]) {
  const create = vi.fn(async () => {
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return { choices: [{ message: { content: r ?? '' } }] };
  });
  return { client: { chat: { completions: { create } } } as unknown as LlmClient, create };
}

describe('时间', () => {
  it('fmtShanghai 输出上海时间和星期', () => {
    expect(fmtShanghai(NOW)).toBe('2026-09-26 13:30 星期六');
  });

  it.each([
    ['2026-09-27T14:00+08:00', '2026-09-27T06:00:00.000Z'],
    ['2026-09-27T14:00', '2026-09-27T06:00:00.000Z'], // 缺时区按 +08:00
    ['2026-09-27 14:00:00', '2026-09-27T06:00:00.000Z'],
    ['2026-09-27T06:00Z', '2026-09-27T06:00:00.000Z'],
    ['2026-10-02', '2026-10-02T15:59:00.000Z'], // 只有日期 → 23:59
  ])('parseTime(%s)', (s, iso) => {
    expect(new Date(parseTime(s)).toISOString()).toBe(iso);
  });

  it('parseTime 不认识的返回 NaN', () => {
    expect(parseTime('明天下午两点')).toBeNaN();
  });

  it('system prompt 带当前时间', () => {
    expect(buildSystemPrompt(NOW)).toContain('2026-09-26 13:30 星期六（Asia/Shanghai）');
  });
});

describe('parseExtraction', () => {
  const ids = new Set(['m1', 'm2']);

  it('时间串转毫秒，丢弃不在输入里的消息 id', () => {
    const r = parseExtraction(JSON.stringify({ events: [ev({ source_message_ids: ['m1', 'x9', 'm1', 2] })] }), ids);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events[0]?.start_at).toBe(Date.parse('2026-09-27T14:00+08:00'));
    expect(r.events[0]?.source_message_ids).toEqual(['m1']);
  });

  it('update 可以不给标题；空串字段当 null；update_of 容忍字符串数字', () => {
    const r = parseExtraction(
      JSON.stringify({ events: [ev({ action: 'update', update_of: '3', title: null, location: ' ', start_at: '' })] }),
      ids,
    );
    expect(r.ok && r.events[0]).toMatchObject({ update_of: 3, title: '', location: null, start_at: null });
  });

  it.each([
    ['非 JSON', '```json {"events": []}```'],
    ['缺 events', '{}'],
    ['type 不合法', JSON.stringify({ events: [ev({ type: 'party' })] })],
    ['create 没标题', JSON.stringify({ events: [ev({ title: null })] })],
    ['时间写中文', JSON.stringify({ events: [ev({ start_at: '明天下午两点' })] })],
  ])('%s → 失败', (_, raw) => {
    expect(parseExtraction(raw, ids).ok).toBe(false);
  });
});

describe('extractEvents', () => {
  const key = env.LLM_API_KEY;
  afterEach(() => {
    env.LLM_API_KEY = key;
    vi.restoreAllMocks();
  });

  it('正常返回', async () => {
    const { client, create } = fakeClient(JSON.stringify({ events: [ev()] }));
    const out = await extractEvents(input([msg('m1', '明天下午两点 A301 小测')]), client);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('高数小测');
    expect(llmStats.llm).toBe('ok');
    const body = create.mock.calls[0] as unknown as [{ response_format: unknown; temperature: number }];
    expect(body[0]).toMatchObject({ response_format: { type: 'json_object' }, temperature: 0 });
  });

  it('第一次不合法 → 带上错误重试一次', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, create } = fakeClient('not json', JSON.stringify({ events: [ev()] }));
    const out = await extractEvents(input([msg('m1', '小测')]), client);
    expect(out).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1] as unknown as [{ messages: { role: string; content: string }[] }];
    expect(retry[0].messages.at(-1)?.content).toContain('不合法');
  });

  it('两次都不合法 → []，不抛', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, create } = fakeClient('', '{"events": 1}');
    await expect(extractEvents(input([msg('m1', '小测')]), client)).resolves.toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('网络错误 → []，llm=error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fakeClient(new Error('ECONNRESET'));
    await expect(extractEvents(input([msg('m1', '小测')]), client)).resolves.toEqual([]);
    expect(llmStats.llm).toBe('error');
  });

  it('没有候选消息不调用', async () => {
    const { client, create } = fakeClient();
    await expect(extractEvents(input([]), client)).resolves.toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('没配 key → []，llm=unconfigured', async () => {
    env.LLM_API_KEY = '';
    await expect(extractEvents(input([msg('m1', '小测')]))).resolves.toEqual([]);
    expect(llmStats.llm).toBe('unconfigured');
  });
});
