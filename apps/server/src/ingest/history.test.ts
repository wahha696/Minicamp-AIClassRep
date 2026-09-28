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

/** 只数 get_group_msg_history 的调用（get_essence_msg_list 是补充通道，每群一次、不参与翻页计数） */
const histCalls = () =>
  (callActionMock.mock.calls as unknown as [string, Record<string, unknown>][]).filter(
    (c) => c[0] === 'get_group_msg_history',
  );
/**
 * 按 action 分派：get_essence_msg_list 永远回空；
 * get_group_msg_history 按顺序消费 pages 队列（耗尽了回空页）。
 */
const mockHistoryPages = (...pages: unknown[][]) =>
  callActionMock.mockImplementation((action: string) => {
    if (action === 'get_essence_msg_list') return Promise.resolve([]);
    return Promise.resolve({ messages: pages.length ? pages.shift() : [] });
  });

beforeAll(() => openDb(':memory:'));
afterAll(() => db.close());
beforeEach(() => {
  db.exec('DELETE FROM messages; DELETE FROM groups; DELETE FROM message_seen; DELETE FROM group_sync;');
  callActionMock.mockReset();
});

const syncRow = (id = '1001') =>
  db.prepare('SELECT * FROM group_sync WHERE group_id = ?').get(id) as
    | { last_sync_at: number; oldest_at: number | null; complete: number; reason: string }
    | undefined;

describe('syncHistory 翻页', () => {
  it('3 页：首页不带 message_seq，之后用上一页最早一条的 message_id', async () => {
    seedGroup();
    // 每页两条：按返回顺序遍历，锚点是本页最早的那条（小的 message_id）
    mockHistoryPages(
      page([103, NOW - 1 * DAY], [102, NOW - 2 * DAY]),
      page([101, NOW - 3 * DAY], [100, NOW - 4 * DAY]),
      [],
    );
    const res = await syncHistory(7);
    expect(res).toEqual({ groups: 1, messages: 4, failures: 0 });
    expect(msgCount()).toBe(4);

    const calls = histCalls();
    expect(calls[0]![1]).not.toHaveProperty('message_seq');
    expect(calls[1]![1].message_seq).toBe(102);
    expect(calls[1]![1].reverse_order).toBe(true); // 向后翻页必须带（NapCat 缺省向前）
    expect(calls[2]![1].message_seq).toBe(100);
  });

  it('days 过滤 + 本页最早早于窗口 → 停止', async () => {
    seedGroup();
    mockHistoryPages(page([102, NOW - 1 * DAY], [101, NOW - 20 * DAY], [100, NOW - 30 * DAY]));
    const res = await syncHistory(7);
    expect(res.messages).toBe(1); // 只有窗口内的入库
    expect(histCalls()).toHaveLength(1); // 本页最早已早于窗口 → 不翻第二页
  });

  it('本页全是旧 id（锚点重复）→ 停止翻页', async () => {
    seedGroup();
    // 第二页返回的 id 和第一页重复 → newIds = 0
    mockHistoryPages(
      page([102, NOW - 1 * DAY], [101, NOW - 2 * DAY]),
      page([102, NOW - 1 * DAY], [101, NOW - 2 * DAY]),
    );
    const res = await syncHistory(7);
    expect(res.messages).toBe(2); // ingest 去重后也只入 2 条
    expect(histCalls()).toHaveLength(2);
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
    mockHistoryPages(page([102, NOW - DAY], [101, NOW - 2 * DAY]));
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

  it('同一时刻只跑一个 sync：并发第二次天数不更大时返回同一个 Promise', async () => {
    seedGroup();
    let resolveFirst: (v: unknown) => void = () => {};
    callActionMock.mockImplementation((action: string) => {
      if (action === 'get_essence_msg_list') return Promise.resolve([]);
      return new Promise((r) => { resolveFirst = r; });
    });
    const p1 = syncHistory(7);
    const p2 = syncHistory(1);
    resolveFirst({ messages: [] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2); // 同一个结果
    expect(histCalls()).toHaveLength(1);
  });

  it('正在补 7 天时点「30 天」：等前一次结束后再按 30 天补一次，不会被 7 天的结果顶替', async () => {
    seedGroup();
    let resolveFirst: (v: unknown) => void = () => {};
    // 第一次（7 天）：一页就翻到窗口外，停；第二次（30 天）：从头翻，第二页多出 20 天前那条
    let firstPending = true;
    // 第二趟（30 天）：首页仍是 [1,3]（id3 这次在窗口内），下一页多出 20 天前的 id2
    const pages = [page([1, NOW - DAY], [3, NOW - 8 * DAY]), page([2, NOW - 20 * DAY]), []];
    callActionMock.mockImplementation((action: string) => {
      if (action === 'get_essence_msg_list') return Promise.resolve([]);
      if (firstPending) {
        firstPending = false;
        return new Promise((r) => { resolveFirst = r; });
      }
      return Promise.resolve({ messages: pages.length ? pages.shift() : [] });
    });
    const p1 = syncHistory(7);
    const p2 = syncHistory(30);
    resolveFirst({ messages: page([1, NOW - DAY], [3, NOW - 8 * DAY]) });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.messages).toBe(1);
    expect(r2.messages).toBe(3); // 7 天那次的 1 条 + 30 天补出来的 8 天前、20 天前 2 条
    expect(msgCount()).toBe(3);
  });

  it('历史请求在切库后才返回：旧响应与排队的大窗口都不能写入或在新库重跑', async () => {
    seedGroup();
    let resolveFirst: (v: unknown) => void = () => {};
    callActionMock.mockImplementation((action: string) => {
      if (action === 'get_essence_msg_list') return Promise.resolve([]);
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });
    const first = syncHistory(7);
    const queuedLargerWindow = syncHistory(30);
    await vi.waitFor(() => expect(histCalls()).toHaveLength(1));

    openDb(':memory:'); // A → B；B 故意也有同群，防止错误实现看似因为无群而通过
    seedGroup();
    resolveFirst({ messages: [] });
    await Promise.all([first, queuedLargerWindow]);

    expect(histCalls()).toHaveLength(1); // 30 天任务属于旧代次，不能在 B 上重新发起
    expect(msgCount()).toBe(0);
    expect(syncRow()).toBeUndefined();
  });
});

describe('group_sync 落账（R03：补到哪/补没补全可报告）', () => {
  it('补到窗口尽头 → complete=1 reason=ok，oldest_at 是拉到的最早一条', async () => {
    seedGroup();
    mockHistoryPages(page([102, NOW - 1 * DAY], [101, NOW - 20 * DAY]));
    const res = await syncHistory(7);
    expect(res.failures).toBe(0);
    const row = syncRow();
    expect(row).toBeDefined();
    expect(row!.complete).toBe(1);
    expect(row!.reason).toBe('ok');
    expect(row!.oldest_at).toBe(NOW - 20 * DAY - (NOW - 20 * DAY) % 1000); // time 是秒级
  });

  it('翻页持续报错（重试也失败）→ complete=0 reason=page_error，计入 failures', async () => {
    seedGroup();
    callActionMock.mockImplementation((action: string) =>
      action === 'get_essence_msg_list' ? Promise.resolve([]) : Promise.reject(new Error('网络超时')),
    );
    const res = await syncHistory(7);
    expect(res.failures).toBe(1);
    expect(histCalls()).toHaveLength(2); // 单页失败重试一次后才放弃
    const row = syncRow();
    expect(row!.complete).toBe(0);
    expect(row!.reason).toBe('page_error');
  });

  it('翻页报错重试一次成功 → 不算失败', async () => {
    seedGroup();
    let histAttempt = 0;
    callActionMock.mockImplementation((action: string) => {
      if (action === 'get_essence_msg_list') return Promise.resolve([]);
      histAttempt++;
      return histAttempt === 1
        ? Promise.reject(new Error('网络抖动'))
        : Promise.resolve({ messages: page([101, NOW - DAY]) });
    });
    const res = await syncHistory(7);
    expect(res.failures).toBe(0);
    expect(res.messages).toBe(1);
    expect(syncRow()!.reason).toBe('ok');
  });

  it('NapCat「消息不存在」= 翻到顶，算补全不是失败', async () => {
    seedGroup();
    callActionMock.mockImplementation((action: string) =>
      action === 'get_essence_msg_list'
        ? Promise.resolve([])
        : Promise.reject(new Error('消息 99 不存在')),
    );
    const res = await syncHistory(7);
    expect(res.failures).toBe(0);
    const row = syncRow();
    expect(row!.complete).toBe(1);
    expect(row!.reason).toBe('ok');
  });

  it('群级异常 → reason=error 且不影响其他群', async () => {
    seedGroup();
    db.prepare(
      "INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('2002', '群2002', 1, 'onebot', ?)",
    ).run(Date.now());
    callActionMock.mockImplementation((a: string, params: Record<string, unknown>) =>
      a === 'get_essence_msg_list'
        ? Promise.resolve([])
        : params.group_id === 1001
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ messages: [] }),
    );
    const res = await syncHistory(7);
    expect(res.failures).toBe(1);
    expect(syncRow()!.reason).toBe('page_error'); // 翻页里的错
    expect(syncRow('2002')!.reason).toBe('ok'); // 空页 = 补全
  });
});
