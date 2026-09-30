import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../env.js';
import type { Message } from '../types.js';
import { LOCAL_JEV_BACKOFF_MS, resetLocalJevBackoff } from './jev-local.js';
import {
  getDualScoreLog,
  JEV_BACKOFF_MS,
  jevAvailable,
  pickRouted,
  resetDualScoreLog,
  resetJevBackoff,
  scoreWithJev,
} from './jev.js';
import { jevStats } from './stats.js';

vi.mock('./jev-local.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jev-local.js')>();
  return {
    ...actual,
    localJevAvailable: vi.fn(() => true),
    localJevReady: vi.fn(() => true),
    scoreWithLocal: vi.fn(async () => [0.9, 0.1] as number[] | null),
  };
});

import { localJevAvailable, localJevReady, scoreWithLocal } from './jev-local.js';

const messages: Message[] = [
  { message_id: '1', group_id: 'g', group_name: '课程群', sender_name: '老师', text: '高数考试改到周五', sent_at: 1 },
  { message_id: '2', group_id: 'g', group_name: '课程群', sender_name: '同学', text: '今天的奶茶很好喝', sent_at: 2 },
];

const original = {
  enabled: env.ENABLE_JEV,
  key: env.TYPESAFE_API_KEY,
  mode: env.FASTJUDGE_MODE,
  route: env.FASTJUDGE_ROUTE,
};

function stubRemoteOk(scores = [0.7, 0.2]) {
  const answers = Object.fromEntries(scores.map((noul, i) => [`message_${i}`, { type: 'noul', noul }]));
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  env.ENABLE_JEV = true;
  env.TYPESAFE_API_KEY = 'test-key';
  env.FASTJUDGE_MODE = 'jev';
  env.FASTJUDGE_ROUTE = 'jev';
  jevStats.state = 'ok';
  resetJevBackoff();
  resetLocalJevBackoff();
  resetDualScoreLog();
  vi.mocked(localJevAvailable).mockReturnValue(true);
  vi.mocked(localJevReady).mockReturnValue(true);
  vi.mocked(scoreWithLocal).mockResolvedValue([0.9, 0.1]);
});

afterEach(() => {
  env.ENABLE_JEV = original.enabled;
  env.TYPESAFE_API_KEY = original.key;
  env.FASTJUDGE_MODE = original.mode;
  env.FASTJUDGE_ROUTE = original.route;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pickRouted', () => {
  it('ROUTE=local 时两边都有分用 local', () => {
    env.FASTJUDGE_ROUTE = 'local';
    expect(pickRouted([0.5], [0.8])).toEqual({ routed: [0.8], routeBackend: 'local' });
  });

  it('ROUTE=local 时 local 为空回落到 remote', () => {
    env.FASTJUDGE_ROUTE = 'local';
    expect(pickRouted([0.5], null)).toEqual({ routed: [0.5], routeBackend: 'jev' });
  });

  it('ROUTE=jev 时两边都有分用 remote', () => {
    env.FASTJUDGE_ROUTE = 'jev';
    expect(pickRouted([0.5], [0.8])).toEqual({ routed: [0.5], routeBackend: 'jev' });
  });

  it('ROUTE=jev 时 remote 为空回落到 local', () => {
    env.FASTJUDGE_ROUTE = 'jev';
    expect(pickRouted(null, [0.8])).toEqual({ routed: [0.8], routeBackend: 'local' });
  });

  it('两边都空：返回 null，routeBackend 仍反映偏好', () => {
    env.FASTJUDGE_ROUTE = 'local';
    expect(pickRouted(null, null)).toEqual({ routed: null, routeBackend: 'local' });
    env.FASTJUDGE_ROUTE = 'jev';
    expect(pickRouted(null, null)).toEqual({ routed: null, routeBackend: 'jev' });
  });
});

describe('scoreWithJev mode dispatch', () => {
  it('mode=local 只走本地，不发远端请求', async () => {
    env.FASTJUDGE_MODE = 'local';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await scoreWithJev(messages, [], '课程群')).toEqual([0.9, 0.1]);
    expect(scoreWithLocal).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mode=jev 只走远端', async () => {
    env.FASTJUDGE_MODE = 'jev';
    const fetchMock = stubRemoteOk([0.6, 0.3]);
    expect(await scoreWithJev(messages, [], '课程群')).toEqual([0.6, 0.3]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(scoreWithLocal).not.toHaveBeenCalled();
  });

  it('dual + ROUTE=local：两边打分，路由用 local', async () => {
    env.FASTJUDGE_MODE = 'dual';
    env.FASTJUDGE_ROUTE = 'local';
    stubRemoteOk([0.7, 0.2]);
    vi.mocked(scoreWithLocal).mockResolvedValue([0.91, 0.11]);
    expect(await scoreWithJev(messages, [], '课程群')).toEqual([0.91, 0.11]);
    expect(scoreWithLocal).toHaveBeenCalledOnce();
    const log = getDualScoreLog(5);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      groupName: '课程群',
      n: 2,
      remote: [0.7, 0.2],
      local: [0.91, 0.11],
      routed: [0.91, 0.11],
      routeBackend: 'local',
    });
    // 摘要不含原文
    expect(log[0]).not.toHaveProperty('texts');
  });

  it('dual + ROUTE=local：local 失败时回落 remote', async () => {
    env.FASTJUDGE_MODE = 'dual';
    env.FASTJUDGE_ROUTE = 'local';
    stubRemoteOk([0.7, 0.2]);
    vi.mocked(scoreWithLocal).mockResolvedValue(null);
    expect(await scoreWithJev(messages, [], '课程群')).toEqual([0.7, 0.2]);
    expect(getDualScoreLog(1)[0]?.routeBackend).toBe('jev');
  });

  it('dual 时本地未配置：仍可只走远端', async () => {
    env.FASTJUDGE_MODE = 'dual';
    env.FASTJUDGE_ROUTE = 'local';
    vi.mocked(localJevAvailable).mockReturnValue(false);
    stubRemoteOk([0.55, 0.15]);
    expect(await scoreWithJev(messages, [], '课程群')).toEqual([0.55, 0.15]);
    expect(scoreWithLocal).not.toHaveBeenCalled();
  });
});

describe('local backoff awareness via jevAvailable', () => {
  it('mode=local 时 localJevReady=false 则不可用', () => {
    env.FASTJUDGE_MODE = 'local';
    vi.mocked(localJevReady).mockReturnValue(false);
    expect(jevAvailable()).toBe(false);
  });

  it('mode=dual 时本地退避仍可因远端就绪而可用', () => {
    env.FASTJUDGE_MODE = 'dual';
    env.TYPESAFE_API_KEY = 'test-key';
    vi.mocked(localJevReady).mockReturnValue(false);
    expect(jevAvailable()).toBe(true);
  });

  it('mode=dual 远端退避 + 本地就绪仍可用', async () => {
    env.FASTJUDGE_MODE = 'dual';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 529 }));
    vi.stubGlobal('fetch', fetchMock);
    // 触发远端失败 → backoff
    env.FASTJUDGE_MODE = 'jev';
    expect(await scoreWithJev(messages, [], '课程群')).toBeNull();
    expect(jevAvailable()).toBe(false);

    env.FASTJUDGE_MODE = 'dual';
    vi.mocked(localJevReady).mockReturnValue(true);
    expect(jevAvailable()).toBe(true);
    expect(jevAvailable(Date.now() + JEV_BACKOFF_MS + 1)).toBe(true);
    // 常量存在，便于与远端对齐
    expect(LOCAL_JEV_BACKOFF_MS).toBe(30_000);
  });
});
