// B7 验收：7 天原始消息清理
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { env } from '../env.js';
import { cleanupOnce, startCleanupJob } from './cleanup.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** 测试里跟着 env 走，避免 .env 把 TTL 改成别的值导致断言写死 */
const TTL_DAYS = env.RAW_MSG_TTL_DAYS;
const NOW = Date.parse('2026-09-23T12:00:00+08:00');

function addMessage(message_id: string, sent_at: number, group_id = 'g1', processed = 1): void {
  db.prepare(
    'INSERT INTO messages (message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
  ).run(message_id, group_id, '张老师', `消息 ${message_id}`, sent_at, 'onebot', processed, sent_at);
}

function addEventWithSource(eventId: number, message_id: string): void {
  db.prepare(
    `INSERT INTO events (id, group_id, type, title, description, start_at, status, confidence, version, created_at, updated_at)
     VALUES (?, 'g1', 'exam', '高数小测', '', ?, 'active', 0.9, 1, ?, ?)`,
  ).run(eventId, NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO event_sources (event_id, message_id, sender_name, text, sent_at) VALUES (?, ?, ?, ?, ?)',
  ).run(eventId, message_id, '张老师', '明天下午两点小测', NOW - 8 * DAY_MS);
}

function count(table: string, where = '', params: unknown[] = []): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where === '' ? '' : ` WHERE ${where}`}`;
  return (db.prepare(sql).get(...(params as never[])) as { n: number }).n;
}

function ids(): string[] {
  return (
    db.prepare('SELECT message_id FROM messages ORDER BY message_id').all() as unknown as {
      message_id: string;
    }[]
  ).map((r) => r.message_id);
}

beforeEach(() => {
  openDb(':memory:');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cleanupOnce', () => {
  it('删掉超过 TTL 的过期消息，未过期的保留', () => {
    addMessage('old-1', NOW - (TTL_DAYS + 1) * DAY_MS);
    addMessage('old-2', NOW - 30 * DAY_MS);
    addMessage('fresh-1', NOW - 1 * DAY_MS);
    addMessage('fresh-2', NOW);

    const removed = cleanupOnce(NOW);

    expect(removed).toBe(2);
    expect(ids()).toEqual(['fresh-1', 'fresh-2']);
  });

  it('正好卡在边界上的保留（sent_at < 截止点，不是 ≤）', () => {
    const cutoff = NOW - TTL_DAYS * DAY_MS;
    addMessage('exactly-cutoff', cutoff);
    addMessage('one-ms-older', cutoff - 1);

    const removed = cleanupOnce(NOW);

    expect(removed).toBe(1);
    expect(ids()).toEqual(['exactly-cutoff']);
  });

  it('没有过期消息时返回 0，且不打印', () => {
    addMessage('fresh', NOW - 1000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(cleanupOnce(NOW)).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(ids()).toEqual(['fresh']);
  });

  it('删了数据时在控制台打印一行中文（带条数）', () => {
    addMessage('old-1', NOW - 10 * DAY_MS);
    addMessage('old-2', NOW - 9 * DAY_MS);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    cleanupOnce(NOW);

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0]![0] as string;
    expect(line).toContain('已清理 2 条');
    expect(line).toContain(`${TTL_DAYS} 天`);
  });

  it('event_sources 里的来源快照不受影响（原始消息删了仍能看来源）', () => {
    addMessage('old-1', NOW - 20 * DAY_MS);
    addEventWithSource(1, 'old-1');
    addEventWithSource(2, 'old-1');

    cleanupOnce(NOW);

    expect(count('messages')).toBe(0);
    expect(count('event_sources')).toBe(2);
    const row = db
      .prepare('SELECT text FROM event_sources WHERE event_id = 1')
      .get() as { text: string };
    expect(row.text).toBe('明天下午两点小测');
    // 事件本身也还在
    expect(count('events')).toBe(2);
  });

  it('删掉的消息先记进 message_seen（30 天刷新再拉到时不重复整理）', () => {
    addMessage('old-1', NOW - (TTL_DAYS + 1) * DAY_MS);

    cleanupOnce(NOW);

    expect(count('messages')).toBe(0);
    const seen = db
      .prepare('SELECT message_id, sent_at FROM message_seen')
      .all() as unknown as { message_id: string; sent_at: number }[];
    expect(seen).toEqual([{ message_id: 'old-1', sent_at: NOW - (TTL_DAYS + 1) * DAY_MS }]);
  });

  it('过 TTL 但没处理的消息保留；超过 45 天还没处理的强删', () => {
    addMessage('unprocessed', NOW - (TTL_DAYS + 1) * DAY_MS, 'g1', 0);
    addMessage('ancient', NOW - 46 * DAY_MS, 'g1', 0);

    const removed = cleanupOnce(NOW);

    expect(removed).toBe(1);
    expect(ids()).toEqual(['unprocessed']);
    // 46 天 > message_seen 的 40 天保留期，同行里被顺手清掉——反正它也不可能在 ≤30 天的刷新里再出现
    expect(count('message_seen', "message_id = 'ancient'")).toBe(0);
  });

  it('message_seen 里超过 40 天的行被清掉', () => {
    db.prepare('INSERT INTO message_seen (message_id, sent_at) VALUES (?, ?)').run(
      'stale-seen',
      NOW - 41 * DAY_MS,
    );
    db.prepare('INSERT INTO message_seen (message_id, sent_at) VALUES (?, ?)').run(
      'fresh-seen',
      NOW - 1 * DAY_MS,
    );

    cleanupOnce(NOW);

    const seen = db
      .prepare('SELECT message_id FROM message_seen ORDER BY message_id')
      .all() as unknown as { message_id: string }[];
    expect(seen).toEqual([{ message_id: 'fresh-seen' }]);
  });

  it('空库上跑不报错', () => {
    expect(cleanupOnce(NOW)).toBe(0);
  });

  it('不传 now 时用当前时间', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    addMessage('old', NOW - (TTL_DAYS + 2) * DAY_MS);
    addMessage('fresh', NOW - 1000);

    expect(cleanupOnce()).toBe(1);
    expect(ids()).toEqual(['fresh']);
  });
});

describe('startCleanupJob', () => {
  it('启动时立刻清一次，之后每小时一次，定时器调了 unref()', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    addMessage('old-on-start', NOW - (TTL_DAYS + 1) * DAY_MS);
    addMessage('fresh', NOW - 1000);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // 包一层拿到 setInterval 返回的定时器，验证 unref() 被调过
    const fakeSetInterval = globalThis.setInterval;
    const unref = vi.fn();
    const timers: NodeJS.Timeout[] = [];
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      const timer = fakeSetInterval(fn, ms);
      timer.unref = unref;
      timers.push(timer);
      return timer;
    }) as typeof setInterval;

    try {
      startCleanupJob();

      // 启动就清了一次
      expect(ids()).toEqual(['fresh']);
      expect(timers).toHaveLength(1);
      expect(unref).toHaveBeenCalledTimes(1);

      // 过一小时再清一次
      addMessage('old-later', NOW - (TTL_DAYS + 3) * DAY_MS);
      expect(count('messages')).toBe(2);
      vi.advanceTimersByTime(HOUR_MS);
      expect(ids()).toEqual(['fresh']);
    } finally {
      globalThis.setInterval = fakeSetInterval;
    }
  });

  it('首次执行出错也不抛（库没打开时）', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    // 关掉库，让 cleanupOnce 抛
    db.close();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fakeSetInterval = globalThis.setInterval;

    try {
      expect(() => startCleanupJob()).not.toThrow();
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]![0] as string).toContain('清理任务首次执行失败');
    } finally {
      globalThis.setInterval = fakeSetInterval;
    }
  });
});
