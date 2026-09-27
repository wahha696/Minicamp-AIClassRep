// 修复计划第一节验收：按 QQ 号分库 —— switchAccount / openInitialDb / 老库迁移 / 换号通知 / 复合主键
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  accountDbPath,
  currentAccount,
  db,
  deleteAccountData,
  listAccounts,
  onAccountSwitch,
  openDb,
  openInitialDb,
  setDataDir,
  switchAccount,
} from './index.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'classrep-acc-'));
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

describe('按 QQ 号分库（修复计划第一节）', () => {
  it('A 写数据 → 切 B 为空 → 切回 A 原样恢复；文件落在 accounts/<uin>/', () => {
    const dir = tempDir();
    setDataDir(dir);
    switchAccount('10001');
    expect(currentAccount()).toBe('10001');
    insertMsg('g1', 'm1');
    expect(count('messages')).toBe(1);
    expect(existsSync(accountDbPath('10001'))).toBe(true);

    switchAccount('10002');
    expect(currentAccount()).toBe('10002');
    expect(count('messages')).toBe(0); // B 的库是空的

    switchAccount('10001');
    expect(count('messages')).toBe(1); // A 的数据原样回来
  });

  it('openInitialDb：没 uin 开内存占位库（不落盘），有 uin 直接开它的库', () => {
    const dir = tempDir();
    setDataDir(dir);
    openInitialDb(undefined);
    expect(currentAccount()).toBeNull();
    expect(count('messages')).toBe(0); // 占位库可用，业务接口返回空列表
    expect(existsSync(join(dir, 'accounts'))).toBe(false); // :memory: 不落盘

    openInitialDb('10001');
    expect(currentAccount()).toBe('10001');
    expect(existsSync(accountDbPath('10001'))).toBe(true);
  });

  it('老库迁移：有 uin 时 data/classrep.db 搬进 accounts/<uin>/ 并升级', () => {
    const dir = tempDir();
    setDataDir(dir);
    const oldFile = join(dir, 'classrep.db');
    const old = new DatabaseSync(oldFile);
    old.exec('CREATE TABLE t (x INTEGER)');
    old.close();

    openInitialDb('10001');
    expect(existsSync(oldFile)).toBe(false); // 老文件已搬走
    expect(existsSync(accountDbPath('10001'))).toBe(true);
    // 搬过去的库被打开且完成迁移（schema_version 写入）
    const v = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as { value: string };
    expect(v.value).toBe('2');
  });

  it('老库迁移：没 uin 时改名为 classrep.legacy.db 留底', () => {
    const dir = tempDir();
    setDataDir(dir);
    const oldFile = join(dir, 'classrep.db');
    const old = new DatabaseSync(oldFile);
    old.exec('CREATE TABLE t (x INTEGER)');
    old.close();

    openInitialDb(undefined);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(join(dir, 'classrep.legacy.db'))).toBe(true);
    expect(currentAccount()).toBeNull(); // 仍开内存占位库
  });

  it('v1→v2 迁移：老库的 messages/message_seen 重建成复合主键，数据保留', () => {
    const dir = tempDir();
    setDataDir(dir);
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

  it('onAccountSwitch：换号时通知订阅者（各模块清缓存用）', () => {
    const dir = tempDir();
    setDataDir(dir);
    const seen: (string | null)[] = [];
    onAccountSwitch((uin) => seen.push(uin));
    switchAccount('20001');
    switchAccount('20002');
    switchAccount(null);
    expect(seen).toEqual(['20001', '20002', null]);
  });

  it('deleteAccountData：删掉 accounts/<uin>/ 并切回占位库', () => {
    const dir = tempDir();
    setDataDir(dir);
    switchAccount('30001');
    insertMsg('g1', 'm1');
    expect(listAccounts()).toContain('30001');
    deleteAccountData('30001');
    expect(currentAccount()).toBeNull();
    expect(existsSync(join(dir, 'accounts', '30001'))).toBe(false);
    expect(listAccounts()).not.toContain('30001');
  });
});
