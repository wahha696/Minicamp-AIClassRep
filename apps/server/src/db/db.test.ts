// B1 验收：建表成功、幂等、约束生效（用 :memory: 库，不碰 data/）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { db, openDb } from './index.js';

const TABLES = ['groups', 'messages', 'events', 'event_sources', 'event_history'];
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
