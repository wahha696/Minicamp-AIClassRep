// schema 版本化迁移验收（D3）：v1 老库 → v2 复合主键；换号时通知订阅者清缓存
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { setAccountsDirForTest, switchAccount } from '../accounts.js';
import { db, onAccountSwitch, openDb } from './index.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'classrep-mig-'));
  tempDirs.push(d);
  return d;
}

afterAll(() => {
  try {
    db.close();
  } catch {
    // 已关就忽略
  }
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
});

function insertMsg(groupId: string, mid: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)',
  ).run(groupId, groupId, 'onebot', Date.now());
  db.prepare(
    'INSERT INTO messages (message_id, group_id, sender_name, text, sent_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(mid, groupId, '张三', 'hi', Date.now(), 'onebot', Date.now());
}

const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('schema 迁移（v1 → v2）', () => {
  it('老库的 messages/message_seen 重建成复合主键，数据保留，跨群同 id 不再冲突', () => {
    const dir = tempDir();
    const file = join(dir, 'accounts', '10001', 'classrep.db');
    mkdirSync(dirname(file), { recursive: true });
    const old = new DatabaseSync(file);
    // v1 形状：message_id 单列主键、message_seen 不带群
    old.exec(`
      CREATE TABLE groups (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, adapter TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL,
        sent_at INTEGER NOT NULL, source TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
        filtered_out INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE message_seen (message_id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL);
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', start_at INTEGER, end_at INTEGER, deadline_at INTEGER,
        location TEXT, action_required TEXT, status TEXT NOT NULL DEFAULT 'active', confidence REAL NOT NULL,
        level INTEGER NOT NULL DEFAULT 2, level_locked INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    old.prepare(
      'INSERT INTO messages (message_id, group_id, sender_name, text, sent_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('m1', 'g1', '张三', '老消息', Date.now(), 'onebot', Date.now());
    old.prepare('INSERT INTO message_seen (message_id, sent_at) VALUES (?, ?)').run('old-seen', 1);
    old.close();

    openDb(file); // 升级到 v2

    // 数据还在，且表结构是复合主键
    expect(count('messages')).toBe(1);
    const seen = db.prepare('SELECT group_id, message_id FROM message_seen').all() as {
      group_id: string;
      message_id: string;
    }[];
    expect(seen).toEqual([{ group_id: '', message_id: 'old-seen' }]); // 老记录记 group_id=''
    insertMsg('g2', 'm1'); // 同 id 跨群不再冲突
    expect(count('messages')).toBe(2);
    const v = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as { value: string };
    expect(v.value).toBe('2');
  });
});

describe('换号通知', () => {
  it('onAccountSwitch：切账号时通知订阅者（各模块清缓存用）', async () => {
    const dir = tempDir();
    setAccountsDirForTest(join(dir, 'accounts'), join(dir, 'fallback.db'));
    const seen: (string | null)[] = [];
    onAccountSwitch((uin) => seen.push(uin));
    await switchAccount('20001');
    await switchAccount('20002');
    expect(seen).toEqual(['20001', '20002']);
  });
});
