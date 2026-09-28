import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { env } from '../env.js';
import { saveTimetable } from '../timetable.js';
import type { Message } from '../types.js';
import {
  type ExtractInput,
  type LlmClient,
  buildSystemPrompt,
  buildUserPrompt,
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
  groupId: 'demo-test',
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

  it('事件过滤后没有任何有效来源时整个输出判为不合格，防止无法审计的重放重复', () => {
    const r = parseExtraction(
      JSON.stringify({ events: [ev({ source_message_ids: ['not-in-this-batch'] })] }),
      ids,
    );
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('source_message_ids');
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
    ['create 没标题', JSON.stringify({ events: [ev({ title: null })] })],
    ['时间写中文', JSON.stringify({ events: [ev({ start_at: '明天下午两点' })] })],
  ])('%s → 失败', (_, raw) => {
    expect(parseExtraction(raw, ids).ok).toBe(false);
  });

  it('编出来的 type 归到 other，不算失败', () => {
    const r = parseExtraction(JSON.stringify({ events: [ev({ type: 'survey' })] }), ids);
    expect(r.ok && r.events[0]?.type).toBe('other');
  });

  it.each([
    [3, 3],
    [undefined, null], // 缺省
    [null, null],
    [5, null],         // 越界
    [0, null],
    ['高', null],      // 乱写
    [2.5, null],       // 非整数
  ] as const)('level=%s → %s', (level, want) => {
    const r = parseExtraction(JSON.stringify({ events: [ev({ level })] }), ids);
    expect(r.ok && r.events[0]?.level).toBe(want);
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
    const status = { llmFailed: false };
    await expect(extractEvents(input([msg('m1', '小测')]), client, status)).resolves.toEqual([]);
    expect(llmStats.llm).toBe('error');
    expect(status.llmFailed).toBe(true);
  });

  it('截断拆批后半连不上 → 整批 [] 并标记 llmFailed（留着整批重试，前半结果不落库）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi
      .fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"events": [' }, finish_reason: 'length' }] })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ events: [ev({ source_message_ids: ['m1'] })] }) }, finish_reason: 'stop' }],
      })
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const status = { llmFailed: false };
    const out = await extractEvents(input([msg('m1', '明天小测'), msg('m2', '周五交作业')]), client, status);
    expect(out).toEqual([]);
    expect(status.llmFailed).toBe(true);
  });

  it('输出被截断（finish_reason=length）→ 对半拆开分别重跑，结果合并', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replies = [
      { content: '{"events": [{"action": "cre', finish_reason: 'length' },
      { content: JSON.stringify({ events: [ev({ source_message_ids: ['m1'] })] }), finish_reason: 'stop' },
      { content: JSON.stringify({ events: [ev({ title: '作业', type: 'assignment', source_message_ids: ['m2'] })] }), finish_reason: 'stop' },
    ];
    const create = vi.fn(async () => {
      const r = replies.shift()!;
      return { choices: [{ message: { content: r.content }, finish_reason: r.finish_reason }] };
    });
    const client = { chat: { completions: { create } } } as unknown as LlmClient;
    const out = await extractEvents(input([msg('m1', '明天小测'), msg('m2', '周五交作业')]), client);
    expect(create).toHaveBeenCalledTimes(3);
    expect(out.map((e) => e.title)).toEqual(['高数小测', '作业']);
    const second = create.mock.calls[2] as unknown as [{ messages: { content: string }[] }];
    expect(second[0].messages.at(-1)?.content).toContain('周五交作业');
  });

  it('补拉的旧消息：日历从最早消息的前一周开始列，并提示按发送时间换算', async () => {
    const { client, create } = fakeClient(JSON.stringify({ events: [] }));
    await extractEvents(input([msg('m1', '明天小测', 20 * 24 * 60)]), client);
    const call = create.mock.calls[0] as unknown as [{ messages: { content: string }[] }];
    expect(call[0].messages[0]!.content).toContain('09-06(日)'); // 20 天前 = 09-06，所在周的前一周
    expect(call[0].messages[0]!.content).toContain('本周：09-21(一)');
    expect(call[0].messages[1]!.content).toContain('补拉回来的历史消息');
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

// ===== 提示词附加段：偏好（记忆）+ 课表（FR-12 / FR-13，需要库）

describe('提示词附加段', () => {
  afterEach(() => {
    try {
      db.exec("DELETE FROM level_rules; DELETE FROM courses; INSERT OR REPLACE INTO kv (key, value) VALUES ('memory_enabled', '1');");
    } catch {
      // 库没开就不管
    }
  });

  it('记忆开 + 有规则 → system prompt 带偏好段；关掉开关就没有', async () => {
    openDb(':memory:');
    db.prepare("INSERT INTO level_rules (text, level, feedback_ids, created_at) VALUES ('大物实验报告一律紧急', 4, '[]', ?)").run(Date.now());
    const { client, create } = fakeClient(JSON.stringify({ events: [ev()] }));
    await extractEvents(input([msg('m1', '小测')]), client);
    const sys = (create.mock.calls[0] as unknown as [{ messages: { content: string }[] }])[0]
      .messages[0]!.content;
    expect(sys).toContain('用户对危机等级的偏好');
    expect(sys).toContain('大物实验报告一律紧急 → 4 紧急');

    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('memory_enabled', '0')").run();
    const { client: c2, create: create2 } = fakeClient(JSON.stringify({ events: [ev()] }));
    await extractEvents(input([msg('m1', '小测')]), c2);
    const sys2 = (create2.mock.calls[0] as unknown as [{ messages: { content: string }[] }])[0]
      .messages[0]!.content;
    expect(sys2).not.toContain('用户对危机等级的偏好');
  });

  it('有课表 → user prompt 带课表段；群绑定了课程写「用户指定」，没绑定写按群名判断', () => {
    openDb(':memory:');
    saveTimetable({
      semester_start: '2026-09-07',
      courses: [
        {
          name: '概率论与数理统计A',
          teacher: '彭丽华(副教授)',
          location: 'B座312',
          weekday: 2,
          block: 2, start_period: 3, end_period: 4,
          weeks: [1, 2, 3, 4],
        },
      ],
    });

    // 消息发送时间 2026-09-26（第 3 周周六）；下周也有第 4 周课
    const unbound = buildUserPrompt(input([msg('m1', '下节课要小测')]));
    expect(unbound).toContain('本群课表');
    expect(unbound).toContain('概率论与数理统计A B座312');
    expect(unbound).toContain('根据群名「测试群」判断');

    db.prepare("UPDATE groups SET course_name = '概率论与数理统计A' WHERE group_id = 'demo-test'").run();
    // groups 表可能还没这个群（input 的 groupId 对应行不在库里）→ 先插
    db.prepare(
      "INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, course_name, created_at) VALUES ('demo-test', '测试群', 1, 'demo', NULL, ?)",
    ).run(Date.now());
    db.prepare("UPDATE groups SET course_name = '概率论与数理统计A' WHERE group_id = 'demo-test'").run();
    const bound = buildUserPrompt(input([msg('m1', '下节课要小测')]));
    expect(bound).toContain('本群对应课程：概率论与数理统计A（用户指定）');
  });

  it('课表段覆盖到本批最晚一条消息的下一周（跨几周的补齐批次）', () => {
    openDb(':memory:');
    saveTimetable({
      semester_start: '2026-09-07',
      courses: [
        { name: '大学物理', teacher: '', location: 'A101', weekday: 3, block: 1, start_period: 1, end_period: 2, weeks: [1, 2, 3, 4, 5, 6, 7, 8] },
      ],
    });
    // 最早一条 21 天前（第 0/1 周附近），最晚一条 10 分钟前（第 3 周）；第 4 周的课也要列出来
    const p = buildUserPrompt(input([msg('m1', '下节课交报告', 21 * 24 * 60), msg('m2', '下节课小测')]));
    expect(p).toContain('9/30 周三'); // 第 4 周周三
  });

  it('没导入课表 → 没有课表段', () => {
    openDb(':memory:');
    const p = buildUserPrompt(input([msg('m1', '下节课要小测')]));
    expect(p).not.toContain('本群课表');
  });
});
