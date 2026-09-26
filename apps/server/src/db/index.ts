// node:sqlite 封装：打开 data/classrep.db（WAL）并建表。
// 单进程单库：整个后端都 import 这里的 db；openDb() 负责建表（幂等）。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../paths.js';

export const DB_FILE = join(DATA_DIR, 'classrep.db');

/**
 * 唯一库实例。openDb() 之后才可用（import 本模块不会碰磁盘）；
 * 测试里可以 openDb(':memory:') 换成内存库。
 * 别的模块请用 `db.prepare(...)`，不要在别处 new DatabaseSync。
 */
export let db!: DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  group_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  adapter     TEXT NOT NULL,              -- MessageSource
  course_name TEXT,                       -- 用户指定的对应课程名；NULL = AI 按群名猜
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  message_id   TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL,
  sender_name  TEXT NOT NULL,
  text         TEXT NOT NULL,
  sent_at      INTEGER NOT NULL,
  source       TEXT NOT NULL,            -- MessageSource
  processed    INTEGER NOT NULL DEFAULT 0,   -- C 处理完置 1
  filtered_out INTEGER NOT NULL DEFAULT 0,   -- C 规则过滤掉置 1
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_processed  ON messages(processed);
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        TEXT NOT NULL,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  start_at        INTEGER, end_at INTEGER, deadline_at INTEGER,
  location        TEXT, action_required TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  confidence      REAL NOT NULL,
  level           INTEGER NOT NULL DEFAULT 2,   -- 危机等级 1 低 2 中 3 高 4 紧急
  level_locked    INTEGER NOT NULL DEFAULT 0, -- 用户手动设过 = 1，AI 更新不改 level
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
-- 来源消息存「快照」：原始 messages 7 天后被清理，详情页的「查看来源」仍要能看
CREATE TABLE IF NOT EXISTS event_sources (
  event_id    INTEGER NOT NULL,
  message_id  TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  text        TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (event_id, message_id)
);
CREATE TABLE IF NOT EXISTS event_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          INTEGER NOT NULL,
  version           INTEGER NOT NULL,
  changed_fields    TEXT NOT NULL,       -- JSON：Record<字段, {from,to}>
  source_message_id TEXT,
  changed_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  level      INTEGER NOT NULL DEFAULT 2, -- 1 低 2 中 3 高 4 紧急
  done_at    INTEGER,
  created_at INTEGER NOT NULL
);
-- 每次手动调级都记一条（记忆开关关着也记）；ignored=1 的总结时不再用
CREATE TABLE IF NOT EXISTS level_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL,
  group_name TEXT NOT NULL,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  ai_level   INTEGER NOT NULL,
  user_level INTEGER NOT NULL,
  ignored    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- AI 把 level_feedback 总结成的一句话规则；feedback_ids 是 JSON 数组
CREATE TABLE IF NOT EXISTS level_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  text         TEXT NOT NULL,
  level        INTEGER NOT NULL,
  feedback_ids TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
-- 课表：weekday 1=周一…7=周日，block 1–5，weeks 是 JSON 数组如 [3,4,...,16]
CREATE TABLE IF NOT EXISTS courses (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  teacher  TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  weekday  INTEGER NOT NULL,
  block    INTEGER NOT NULL,
  weeks    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 已处理过的消息 id：清理原始消息时留下，防止 30 天刷新把旧消息再处理一遍
CREATE TABLE IF NOT EXISTS message_seen (
  message_id TEXT PRIMARY KEY,
  sent_at    INTEGER NOT NULL
);
`;

/** 老库缺列时补列（CREATE TABLE IF NOT EXISTS 不会给已有表加列） */
function ensureColumn(table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** 老库自动升级：补列 + 写默认 kv。在 db.exec(SCHEMA) 之后调用。 */
function migrate(): void {
  ensureColumn('events', 'level', 'level INTEGER NOT NULL DEFAULT 2');
  ensureColumn('events', 'level_locked', 'level_locked INTEGER NOT NULL DEFAULT 0');
  ensureColumn('groups', 'course_name', 'course_name TEXT');
  db.prepare(
    "INSERT OR IGNORE INTO kv (key, value) VALUES ('semester_start', '2026-09-07'), ('memory_enabled', '1')",
  ).run();
}

/**
 * 打开库并建表（幂等）。index.ts 启动时调一次，不带参数。
 * 传 ':memory:' 则换成内存库（只有测试用），DATA_DIR 不会被创建。
 */
export function openDb(path: string = DB_FILE): void {
  // 首次运行时 data/ 还没有：先建目录再打开库文件
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  // 重复调用（测试切库）时先关掉旧连接，避免句柄泄漏、Windows 上文件被锁
  if (db?.isOpen) db.close();
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  migrate();
}
