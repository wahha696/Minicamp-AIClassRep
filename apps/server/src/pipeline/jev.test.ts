import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import type { Message } from '../types.js';
import { filterWithJev } from './jev.js';
import { jevStats } from './stats.js';

const messages: Message[] = [
  { message_id: '1', group_id: 'g', group_name: '课程群', sender_name: '老师', text: '高数考试改到周五', sent_at: 1 },
  { message_id: '2', group_id: 'g', group_name: '课程群', sender_name: '同学', text: '今天的奶茶很好喝', sent_at: 2 },
];

const original = { enabled: env.ENABLE_JEV, key: env.TYPESAFE_API_KEY, model: env.JEV_MODEL };

beforeEach(() => {
  env.ENABLE_JEV = true;
  env.TYPESAFE_API_KEY = 'test-key';
  env.JEV_MODEL = 'jev-latest';
  jevStats.state = 'ok';
});

afterEach(() => {
  env.ENABLE_JEV = original.enabled;
  env.TYPESAFE_API_KEY = original.key;
  env.JEV_MODEL = original.model;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Jev 快判', () => {
  it('一批只调一次，逐条读取 Noul 概率并保留通知', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: {
      message_0: { type: 'noul', noul: 0.98 },
      message_1: { type: 'noul', noul: 0.04 },
    } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await filterWithJev(messages, [], '课程群')).toEqual([messages[0]]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('jev-latest');
    expect(body.state.messages.map((m: { text: string }) => m.text)).toEqual(messages.map((m) => m.text));
    expect(Object.keys(body.questions)).toEqual(['message_0', 'message_1']);
    expect(body.questions.message_0.type).toBe('noul');
    expect(body.questions.message_0.criteria.true).toContain('聚餐');
  });

  it('缺 key、关闭或候选为空时不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    env.TYPESAFE_API_KEY = '';
    expect(await filterWithJev(messages, [], '课程群')).toBeNull();
    env.TYPESAFE_API_KEY = 'test-key';
    env.ENABLE_JEV = false;
    expect(await filterWithJev(messages, [], '课程群')).toBeNull();
    env.ENABLE_JEV = true;
    expect(await filterWithJev([], [], '课程群')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('服务错误或缺少答案时交由 LLM 处理', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: { message_0: { type: 'noul', noul: 0.9 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await filterWithJev(messages, [], '课程群')).toBeNull();
    expect(await filterWithJev(messages, [], '课程群')).toBeNull();
    expect(jevStats.state).toBe('error');
  });
});
