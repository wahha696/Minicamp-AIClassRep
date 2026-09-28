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

    openDb(file); // 升级到最新 schema（v1 → v2 → v3 链式迁移）

    // 数据还在，且表结构是复合主键
    expect(count('messages')).toBe(1);
    const seen = db.prepare('SELECT group_id, message_id FROM message_seen').all() as {
      group_id: string;
      message_id: string;
    }[];
    expect(seen).toEqual([{ group_id: '', message_id: 'old-seen' }]); // 老记录记 group_id=''
    insertMsg('g2', 'm1'); // 同 id 跨群不再冲突
    expect(count('messages')).toBe(2);
    // v6：课程仍是 PR#31 形状，并补上事件提案、人工字段锁和稳定 create 指纹
    const courseCols = (db.prepare('PRAGMA table_info(courses)').all() as { name: string }[]).map((c) => c.name);
    expect(courseCols).toContain('block');
    expect(courseCols).toContain('details');
    expect(count('event_proposals')).toBe(0);
    const eventCols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
    expect(eventCols).toContain('manual_locked_fields');
    const v = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as { value: string };
    expect(v.value).toBe('6');
  });

  it('v3 过渡库（start_section/end_section）重建回 block+details，节次写进 details', () => {
    const dir = tempDir();
    const file = join(dir, 'accounts', '10003', 'classrep.db');
    mkdirSync(dirname(file), { recursive: true });
    const old = new DatabaseSync(file);
    // v3 形状：复合主键 + 节次范围课表 + schema_version=3
    old.exec(`
      CREATE TABLE groups (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, adapter TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE messages (
        message_id TEXT NOT NULL, group_id TEXT NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL,
        sent_at INTEGER NOT NULL, source TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
        filtered_out INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, message_id));
      CREATE TABLE message_seen (group_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (group_id, message_id));
      CREATE TABLE courses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, teacher TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', weekday INTEGER NOT NULL, start_section INTEGER NOT NULL, end_section INTEGER NOT NULL, weeks TEXT NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv (key, value) VALUES ('schema_version', '3');
      INSERT INTO courses (name, teacher, location, weekday, start_section, end_section, weeks) VALUES ('高数', '张老师', 'A301', 1, 5, 8, '[1,2,3]');
    `);
    old.close();

    openDb(file); // v3 → v4

    const c = db.prepare('SELECT name, block, details FROM courses').get() as Record<string, unknown>;
    expect(c).toMatchObject({ name: '高数', block: 3 }); // (5+1)/2=3
    expect(JSON.parse(String(c.details))).toMatchObject({ start_period: 5, end_period: 8 });
    const cols = (db.prepare('PRAGMA table_info(courses)').all() as { name: string }[]).map((x) => x.name);
    expect(cols).not.toContain('start_section');
    expect(cols).not.toContain('end_section');
  });

  it('v2 老库的 block 课表补 details 列（不用重建，block 原样保留）', () => {
    const dir = tempDir();
    const file = join(dir, 'accounts', '10002', 'classrep.db');
    mkdirSync(dirname(file), { recursive: true });
    const old = new DatabaseSync(file);
    // v2 形状：复合主键 + block 课表 + schema_version=2
    old.exec(`
      CREATE TABLE groups (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, adapter TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE messages (
        message_id TEXT NOT NULL, group_id TEXT NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL,
        sent_at INTEGER NOT NULL, source TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
        filtered_out INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, message_id));
      CREATE TABLE message_seen (group_id TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (group_id, message_id));
      CREATE TABLE courses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, teacher TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', weekday INTEGER NOT NULL, block INTEGER NOT NULL, weeks TEXT NOT NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv (key, value) VALUES ('schema_version', '2');
      INSERT INTO courses (name, teacher, location, weekday, block, weeks) VALUES ('高数', '张老师', 'A301', 1, 3, '[1,2,3]');
    `);
    old.close();

    openDb(file); // v2 → v4（block 保留，只补 details）

    const c = db.prepare('SELECT name, block, details FROM courses').get() as Record<string, unknown>;
    expect(c).toMatchObject({ name: '高数', block: 3, details: '{}' });
  });

  it('v4 事件历史原列与数据保留，并新增提案表、原因列和人工字段锁', () => {
    const dir = tempDir();
    const file = join(dir, 'accounts', '10004', 'classrep.db');
    mkdirSync(dirname(file), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv (key, value) VALUES ('schema_version', '4');
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', start_at INTEGER, end_at INTEGER, deadline_at INTEGER,
        location TEXT, action_required TEXT, status TEXT NOT NULL DEFAULT 'active', confidence REAL NOT NULL,
        level INTEGER NOT NULL DEFAULT 2, level_locked INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE event_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, version INTEGER NOT NULL,
        changed_fields TEXT NOT NULL, source_message_id TEXT, changed_at INTEGER NOT NULL);
      INSERT INTO events (group_id, type, title, confidence, created_at, updated_at)
        VALUES ('g1', 'exam', '高数小测', 0.9, 1, 1);
      INSERT INTO event_history (event_id, version, changed_fields, source_message_id, changed_at)
        VALUES (1, 1, '{"location":{"from":null,"to":"A301"}}', 'm-old', 1);
    `);
    old.close();

    openDb(file);

    const eventCols = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
    expect(eventCols).toContain('manual_locked_fields');
    expect(db.prepare('SELECT manual_locked_fields FROM events WHERE id = 1').get()).toEqual({
      manual_locked_fields: '[]',
    });
    expect(db.prepare('SELECT source_message_id, changed_fields FROM event_history WHERE id = 1').get()).toEqual({
      source_message_id: 'm-old',
      changed_fields: '{"location":{"from":null,"to":"A301"}}',
    });
    const proposalCols = (db.prepare('PRAGMA table_info(event_proposals)').all() as { name: string }[]).map((c) => c.name);
    expect(proposalCols).toEqual(expect.arrayContaining([
      'reason', 'proposed_changes', 'source_message_ids', 'event_fingerprint', 'base_version',
    ]));
    expect((db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as { value: string }).value).toBe('6');
  });

  it('v5 create 提案升级时只回填一次原始事件指纹，后续人工编辑不会改写', () => {
    const dir = tempDir();
    const file = join(dir, 'accounts', '10005', 'classrep.db');
    mkdirSync(dirname(file), { recursive: true });
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv (key, value) VALUES ('schema_version', '5');
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', start_at INTEGER, end_at INTEGER, deadline_at INTEGER,
        location TEXT, action_required TEXT, status TEXT NOT NULL DEFAULT 'active', confidence REAL NOT NULL,
        level INTEGER NOT NULL DEFAULT 2, level_locked INTEGER NOT NULL DEFAULT 0,
        manual_locked_fields TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE event_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, kind TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'low_confidence', proposed_changes TEXT NOT NULL,
        source_message_ids TEXT NOT NULL DEFAULT '[]', confidence REAL NOT NULL,
        base_version INTEGER NOT NULL, base_status TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, resolved_at INTEGER,
        UNIQUE(event_id, kind, source_message_ids));
      INSERT INTO events
        (group_id, type, title, description, start_at, location, action_required, status,
         confidence, level, created_at, updated_at)
        VALUES ('g1', 'exam', '原始小测', '第三章', 1000, 'A301', '带计算器',
                'pending_confirm', 0.4, 3, 1, 1);
      INSERT INTO event_proposals
        (event_id, kind, proposed_changes, source_message_ids, confidence, base_version,
         base_status, status, created_at)
        VALUES (1, 'create', '{"status":{"from":"pending_confirm","to":"active"}}',
                '["m1"]', 0.4, 1, 'pending_confirm', 'pending', 1);
    `);
    old.close();

    openDb(file);
    const first = (db.prepare('SELECT event_fingerprint FROM event_proposals WHERE id = 1').get() as {
      event_fingerprint: string;
    }).event_fingerprint;
    expect(JSON.parse(first)).toEqual({
      type: 'exam',
      title: '原始小测',
      description: '第三章',
      start_at: 1000,
      end_at: null,
      deadline_at: null,
      location: 'A301',
      action_required: '带计算器',
      level: 3,
    });
    db.prepare("UPDATE events SET title = '人工改名', location = 'B202' WHERE id = 1").run();
    db.close();

    openDb(file);
    expect((db.prepare('SELECT event_fingerprint FROM event_proposals WHERE id = 1').get() as {
      event_fingerprint: string;
    }).event_fingerprint).toBe(first);
    expect((db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as { value: string }).value).toBe('6');
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
