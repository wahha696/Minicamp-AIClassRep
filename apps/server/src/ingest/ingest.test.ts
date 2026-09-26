// B2 验收：ingestMessages 去重 / 丢弃关闭的群 / 新群自动登记 / 群名更新，以及 upsertGroup
import { describe, expect, it } from 'vitest';
import { db, openDb } from '../db/index.js';
import { ingestMessages, upsertGroup } from './index.js';
import type { Message, MessageSource } from '../types.js';

function freshDb(): void {
  openDb(':memory:');
}

function addGroup(group_id: string, name: string, enabled = 1, adapter: MessageSource = 'onebot'): void {
  db.prepare(
    'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(group_id, name, enabled, adapter, Date.now());
}

function msg(
  message_id: string,
  group_id: string,
  text: string,
  group_name = '高数(2)班',
  sender_name = '张老师',
  sent_at = Date.now(),
): Message {
  return { message_id, group_id, group_name, sender_name, text, sent_at };
}

function countMessages(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
}

describe('ingestMessages', () => {
  it('同一条插两次只剩一条，inserted 只算第一次', () => {
    freshDb();
    const m = msg('m1', 'g1', '明天下午两点在 A301 随堂小测');
    expect(ingestMessages([m], 'demo')).toEqual({ inserted: 1 });
    expect(ingestMessages([m], 'demo')).toEqual({ inserted: 0 });
    expect(countMessages()).toBe(1);
  });

  it('批次内自带重复也只插一条', () => {
    freshDb();
    const m = msg('m1', 'g1', '明天下午两点在 A301 随堂小测');
    expect(ingestMessages([m, { ...m }], 'demo')).toEqual({ inserted: 1 });
    expect(countMessages()).toBe(1);
  });

  it('enabled=0 的群消息被丢弃，也不登记成新群', () => {
    freshDb();
    addGroup('g-off', '已关闭的群', 0);
    expect(ingestMessages([msg('m1', 'g-off', '这条不该进库')], 'onebot')).toEqual({ inserted: 0 });
    expect(countMessages()).toBe(0);
    // 群还在，只是没进消息
    const groups = db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number };
    expect(groups.n).toBe(1);
  });

  it('新群自动登记，enabled 默认 1、adapter 用本次 source', () => {
    freshDb();
    expect(ingestMessages([msg('m1', 'g-new', '下周三交作业', '离散数学')], 'demo')).toEqual({
      inserted: 1,
    });
    const row = db.prepare('SELECT name, enabled, adapter FROM groups WHERE group_id = ?').get('g-new') as {
      name: string;
      enabled: number;
      adapter: string;
    };
    expect(row.name).toBe('离散数学');
    expect(row.enabled).toBe(1);
    expect(row.adapter).toBe('demo');
  });

  it('群名变了会更新（消息照常入库）', () => {
    freshDb();
    addGroup('g1', '旧群名');
    expect(ingestMessages([msg('m1', 'g1', '班会改到周五', '新群名')], 'onebot')).toEqual({
      inserted: 1,
    });
    const row = db.prepare('SELECT name FROM groups WHERE group_id = ?').get('g1') as { name: string };
    expect(row.name).toBe('新群名');
    expect(countMessages()).toBe(1);
  });

  it('一批里多个群各自处理，计数只算真正入库的', () => {
    freshDb();
    addGroup('g-off', '关掉的群', 0);
    const res = ingestMessages(
      [
        msg('a1', 'g1', '明天下午两点小测', '高数(2)班'),
        msg('a2', 'g1', '收到', '高数(2)班', '小王'),
        msg('b1', 'g2', '周五交实验报告', '物理实验'),
        msg('x1', 'g-off', '不该进库', '关掉的群'),
        msg('a1', 'g1', '明天下午两点小测', '高数(2)班'), // 与 a1 重复
      ],
      'demo',
    );
    expect(res).toEqual({ inserted: 3 });
    expect(countMessages()).toBe(3);
  });

  it('入库字段落对：sender_name / text / sent_at / source，processed 与 filtered_out 默认 0', () => {
    freshDb();
    const sentAt = 1790000000000;
    ingestMessages([msg('m1', 'g1', '明天下午两点小测', '高数(2)班', '张老师', sentAt)], 'history');
    const row = db
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .get('m1') as Record<string, unknown>;
    expect(row.group_id).toBe('g1');
    expect(row.sender_name).toBe('张老师');
    expect(row.text).toBe('明天下午两点小测');
    expect(row.sent_at).toBe(sentAt);
    expect(row.source).toBe('history');
    expect(row.processed).toBe(0);
    expect(row.filtered_out).toBe(0);
    expect(typeof row.created_at).toBe('number');
  });

  it('空批次不报错、不改库', () => {
    freshDb();
    expect(ingestMessages([], 'onebot')).toEqual({ inserted: 0 });
    expect(countMessages()).toBe(0);
  });
});

describe('upsertGroup', () => {
  it('新群登记为 enabled=1', () => {
    freshDb();
    upsertGroup('g1', '高数(2)班', 'onebot');
    const row = db.prepare('SELECT name, enabled, adapter FROM groups WHERE group_id = ?').get('g1') as {
      name: string;
      enabled: number;
      adapter: string;
    };
    expect(row).toEqual({ name: '高数(2)班', enabled: 1, adapter: 'onebot' });
  });

  it('已存在的群只改名，不动 enabled（用户关掉的群不能被重新打开）', () => {
    freshDb();
    addGroup('g1', '旧群名', 0);
    upsertGroup('g1', '新群名', 'onebot');
    const row = db.prepare('SELECT name, enabled FROM groups WHERE group_id = ?').get('g1') as {
      name: string;
      enabled: number;
    };
    expect(row).toEqual({ name: '新群名', enabled: 0 });
  });

  it('重复调用幂等，群不会变两条', () => {
    freshDb();
    upsertGroup('g1', '高数(2)班', 'onebot');
    upsertGroup('g1', '高数(2)班', 'onebot');
    const n = (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n;
    expect(n).toBe(1);
  });
});
