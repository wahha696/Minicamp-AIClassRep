// B1 验收：建表成功、幂等、约束生效（用 :memory: 库，不碰 data/）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { db, openDb } from './index.js';

const TABLES = [
  'groups', 'messages', 'events', 'event_sources', 'event_history',
  'todos', 'level_feedback', 'level_rules', 'courses', 'kv', 'message_seen',
];
const INDEXES = ['idx_messages_group_time', 'idx_messages_processed'];

const tempDirs: string[] = [];

afterAll(() => {
  // Windows 上文件库没关就删不掉目录；正常路径已在用例里 close，这里只兜底
  try {
    db.close();
  } catch {
    // 已关就忽略
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 兜底清理失败不影响测试结论
    }
  }
});

function tableNames(): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function indexNames(): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe('db 建表', () => {
  it(':memory: 库能建出 §5 的全部表', () => {
    openDb(':memory:');
    const names = tableNames();
    for (const t of TABLES) expect(names).toContain(t);
    for (const i of INDEXES) expect(indexNames()).toContain(i);
  });

  it('openDb 幂等：再跑一次不报错、表还是那 5 张', () => {
    openDb(':memory:');
    openDb(':memory:');
    expect(tableNames().filter((n) => TABLES.includes(n)).sort()).toEqual([...TABLES].sort());
  });

  it('groups 主键去重 + enabled 默认 1', () => {
    openDb(':memory:');
    const now = Date.now();
    db.prepare(
      'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)',
    ).run('g1', '高数(2)班', 'demo', now);
    db.prepare(
      'INSERT OR IGNORE INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)',
    ).run('g1', '高数(2)班', 'demo', now);
    const count = db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number };
    expect(count.n).toBe(1);
    const row = db.prepare('SELECT enabled FROM groups WHERE group_id = ?').get('g1') as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
  });

  it('messages 默认 processed=0 / filtered_out=0', () => {
    openDb(':memory:');
    db.prepare(
      'INSERT INTO messages (message_id, group_id, sender_name, text, sent_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('m1', 'g1', '张老师', '明天下午两点小测', Date.now(), 'demo', Date.now());
    const row = db.prepare('SELECT processed, filtered_out FROM messages WHERE message_id = ?').get('m1') as {
      processed: number;
      filtered_out: number;
    };
    expect(row.processed).toBe(0);
    expect(row.filtered_out).toBe(0);
  });

  it('events 默认 status=active / version=1，且 id 自增', () => {
    openDb(':memory:');
    const now = Date.now();
    const insert = db.prepare(
      'INSERT INTO events (group_id, type, title, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('g1', 'exam', '高数小测', 0.9, now, now);
    insert.run('g1', 'meeting', '班会', 0.8, now, now);
    const rows = db.prepare('SELECT id, status, version FROM events ORDER BY id').all() as {
      id: number;
      status: string;
      version: number;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBeGreaterThan(0);
    expect(rows[1]!.id).toBeGreaterThan(rows[0]!.id);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.version).toBe(1);
  });

  it('event_sources 的 (event_id, message_id) 是主键（快照可去重）', () => {
    openDb(':memory:');
    const ins = db.prepare(
      'INSERT OR IGNORE INTO event_sources (event_id, message_id, sender_name, text, sent_at) VALUES (?, ?, ?, ?, ?)',
    );
    ins.run(1, 'm1', '张老师', '明天下午两点小测', Date.now());
    ins.run(1, 'm1', '张老师', '明天下午两点小测', Date.now());
    const count = db.prepare('SELECT COUNT(*) AS n FROM event_sources').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('openDb 重复调用会关掉旧连接', () => {
    openDb(':memory:');
    const old = db;
    openDb(':memory:');
    expect(old.isOpen).toBe(false);
    expect(db.isOpen).toBe(true);
  });

  it('老库自动升级：缺列补上 + 新表建出 + 旧数据还在', () => {
    // 先用「旧版」最小 schema 建一个文件库并插数据（没有 level/course_name/新表）
    const dir = mkdtempSync(join(tmpdir(), 'classrep-db-old-'));
    tempDirs.push(dir);
    const file = join(dir, 'classrep.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE groups (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, adapter TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', start_at INTEGER, end_at INTEGER, deadline_at INTEGER,
        location TEXT, action_required TEXT, status TEXT NOT NULL DEFAULT 'active', confidence REAL NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
    const now = Date.now();
    old.prepare('INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)').run('g1', '高数(2)班', 'demo', now);
    old.prepare("INSERT INTO events (group_id, type, title, confidence, created_at, updated_at) VALUES ('g1', 'exam', '高数小测', 0.9, ?, ?)").run(now, now);
    old.close();

    openDb(file); // 升级

    const eventCols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
    expect(eventCols).toContain('level');
    expect(eventCols).toContain('level_locked');
    const groupCols = (db.prepare('PRAGMA table_info(groups)').all() as { name: string }[]).map((c) => c.name);
    expect(groupCols).toContain('course_name');

    // 旧数据还在，新列是默认值
    const ev = db.prepare('SELECT title, level, level_locked FROM events').get() as Record<string, unknown>;
    expect(ev).toMatchObject({ title: '高数小测', level: 2, level_locked: 0 });
    const g = db.prepare('SELECT name, course_name FROM groups WHERE group_id = ?').get('g1') as Record<string, unknown>;
    expect(g).toMatchObject({ name: '高数(2)班', course_name: null });

    // 新表建出来了 + 默认 kv 写入
    for (const t of ['todos', 'level_feedback', 'level_rules', 'courses', 'kv', 'message_seen']) {
      expect(tableNames()).toContain(t);
    }
    const kv = db.prepare("SELECT value FROM kv WHERE key = 'semester_start'").get() as { value: string };
    expect(kv.value).toBe('2026-09-07');
  });

  it('文件库的 journal_mode 是 WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classrep-db-'));
    tempDirs.push(dir);
    openDb(join(dir, 'classrep.db'));
    const row = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
    expect(String(Object.values(row)[0]).toLowerCase()).toBe('wal');
    // 建表对文件库同样生效
    expect(tableNames()).toContain('events');
  });
});
