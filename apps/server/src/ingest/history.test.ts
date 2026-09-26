// 历史补齐（FR-16）：假 callAction 模拟翻页。
// 验 message_seq 锚点、days 过滤、空页/旧 id 停止、message_seen 去重、群失败不影响别的群。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import type { Message } from '../types.js';

const { callActionMock } = vi.hoisted(() => ({ callActionMock: vi.fn() }));

vi.mock('../napcat/onebot.js', () => ({
  callAction: callActionMock,
  getGroupNameCached: (id: string) => `群${id}`,
  isMentionOther: () => false,
  // 与真实现一致的最小转换：只取本测试用到的字段
  toMessage: (item: unknown, name: (id: string) => string): Message | null => {
    const o = item as Record<string, unknown>;
    if (typeof o.message_id !== 'number' && typeof o.message_id !== 'string') return null;
    return {
      message_id: String(o.message_id),
      group_id: String(o.group_id),
      group_name: name(String(o.group_id)),
      sender_name: String((o.sender as Record<string, unknown> | undefined)?.nickname ?? '某人'),
      text: String(o.raw_message ?? '文本'),
      sent_at: Number(o.time) * 1000,
    };
  },
}));

import { syncHistory } from './history.js';

const DAY = 24 * 3600_000;
const NOW = Date.now();

/** 造一条 NapCat 历史消息条目（time 是秒级） */
const item = (id: number, at: number, text = '消息') => ({
  message_id: id,
  group_id: 1001,
  time: Math.floor(at / 1000),
  raw_message: text,
  sender: { nickname: '同学' },
});

const page = (...ids: [number, number][]) =>
  ids.map(([id, at]) => item(id, at));

function seedGroup(id = '1001'): void {
  db.prepare(
    "INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, 'onebot', ?)",
  ).run(id, `群${id}`, Date.now());
}

const msgCount = () => (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

beforeAll(() => openDb(':memory:'));
afterAll(() => db.close());
beforeEach(() => {
  db.exec('DELETE FROM messages; DELETE FROM groups; DELETE FROM message_seen;');
  callActionMock.mockReset();
});

describe('syncHistory 翻页', () => {
  it('3 页：首页不带 message_seq，之后用上一页最早一条的 message_id', async () => {
    seedGroup();
    // 每页两条：按返回顺序遍历，锚点是本页最早的那条（小的 message_id）
    callActionMock
      .mockResolvedValueOnce({ messages: page([103, NOW - 1 * DAY], [102, NOW - 2 * DAY]) })
      .mockResolvedValueOnce({ messages: page([101, NOW - 3 * DAY], [100, NOW - 4 * DAY]) })
      .mockResolvedValueOnce({ messages: [] });
    const res = await syncHistory(7);
    expect(res).toEqual({ groups: 1, messages: 4 });
    expect(msgCount()).toBe(4);

    const calls = callActionMock.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(calls[0]![1]).not.toHaveProperty('message_seq');
    expect(calls[1]![1].message_seq).toBe(102);
    expect(calls[2]![1].message_seq).toBe(100);
  });

  it('days 过滤 + 本页最早早于窗口 → 停止', async () => {
    seedGroup();
    callActionMock.mockResolvedValueOnce({
      messages: page([102, NOW - 1 * DAY], [101, NOW - 20 * DAY], [100, NOW - 30 * DAY]),
    });
    const res = await syncHistory(7);
    expect(res.messages).toBe(1); // 只有窗口内的入库
    expect(callActionMock).toHaveBeenCalledTimes(1); // 本页最早已早于窗口 → 不翻第二页
  });

  it('本页全是旧 id（锚点重复）→ 停止翻页', async () => {
    seedGroup();
    // 第二页返回的 id 和第一页重复 → newIds = 0
    callActionMock
      .mockResolvedValueOnce({ messages: page([102, NOW - 1 * DAY], [101, NOW - 2 * DAY]) })
      .mockResolvedValueOnce({ messages: page([102, NOW - 1 * DAY], [101, NOW - 2 * DAY]) });
    const res = await syncHistory(7);
    expect(res.messages).toBe(2); // ingest 去重后也只入 2 条
    expect(callActionMock).toHaveBeenCalledTimes(2);
  });

  it('callAction 抛错 → 该群停止，不影响其他群', async () => {
    seedGroup();
    db.prepare(
      "INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('2002', '群2002', 1, 'onebot', ?)",
    ).run(Date.now());
    callActionMock.mockImplementation((_action: string, params: Record<string, unknown>) => {
      if (params.group_id === 1001) return Promise.reject(new Error('消息 X 不存在'));
      return Promise.resolve({ messages: [] });
    });
    const res = await syncHistory(7);
    expect(res.groups).toBe(2); // 两个群都跑完了
    expect(res.messages).toBe(0);
  });

  it('message_seen 里已有的 id 不再入库', async () => {
    seedGroup();
    db.prepare('INSERT INTO message_seen (message_id, sent_at) VALUES (?, ?)').run('101', NOW - DAY);
    callActionMock.mockResolvedValueOnce({ messages: page([102, NOW - DAY], [101, NOW - 2 * DAY]) });
    const res = await syncHistory(7);
    expect(res.messages).toBe(1); // 101 在 message_seen 里，跳过
    const ids = (db.prepare('SELECT message_id FROM messages').all() as { message_id: string }[]).map((r) => r.message_id);
    expect(ids).toEqual(['102']);
  });

  it('enabled=0 / adapter 不是 onebot 的群不拉', async () => {
    db.prepare(
      "INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('off', '关', 0, 'onebot', ?)",
    ).run(Date.now());
    db.prepare(
      "INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('demo', '演示', 1, 'demo', ?)",
    ).run(Date.now());
    const res = await syncHistory(7);
    expect(res.groups).toBe(0);
    expect(callActionMock).not.toHaveBeenCalled();
  });

  it('同一时刻只跑一个 sync：并发第二次返回同一个 Promise', async () => {
    seedGroup();
    let resolveFirst: (v: unknown) => void = () => {};
    callActionMock.mockImplementationOnce(
      () => new Promise((r) => { resolveFirst = r; }),
    );
    const p1 = syncHistory(7);
    const p2 = syncHistory(30);
    resolveFirst({ messages: [] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2); // 同一个结果
    expect(callActionMock).toHaveBeenCalledTimes(1);
  });
});
