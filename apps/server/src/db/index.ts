// node:sqlite 封装：打开 data/classrep.db（WAL）并建表。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../paths.js';

const DB_FILE = join(DATA_DIR, 'classrep.db');

// 先保证 data/ 存在，再打开库文件（首次运行时 data/ 还没有）
mkdirSync(DATA_DIR, { recursive: true });

/** 单进程单库：data/classrep.db（B1 会补上 :memory: 的测试入口） */
export const db: DatabaseSync = new DatabaseSync(DB_FILE);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  group_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  adapter    TEXT NOT NULL,              -- MessageSource
  created_at INTEGER NOT NULL
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
`;

/** 建表（幂等）。index.ts 启动时调一次。 */
export function openDb(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
}
