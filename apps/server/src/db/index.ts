// node:sqlite 封装（修复计划第一节 + 四问题修复 #1）：每个 QQ 号一个库文件。
//   data/classrep.db                ← 未登录时的「无账号」兜底库（演示模式数据落这里）；
//                                     也是旧版单库的位置，启动时由 accounts.ts 一次性迁移走
//   data/accounts/<uin>/classrep.db ← 该号的全部业务数据
// 换号 = 换库文件：accounts.ts 的 switchAccount 静默流水线后调 openDb(账号库路径)，
// 换号不会串数据，换回来原样恢复。
// 整个后端都 import 这里的 db（export let，ESM live binding，openDb 重新赋值即可）。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../paths.js';

export const DB_FILE = join(DATA_DIR, 'classrep.db'); // 兜底库路径（也是旧版单库位置）

/**
 * 唯一库实例。openDb() 之后才可用（import 本模块不会碰磁盘）；
 * 测试里可以 openDb(':memory:') 换成内存库。
 * 别的模块请用 `db.prepare(...)`，不要在别处 new DatabaseSync。
 */
export let db!: DatabaseSync;

/** 每次打开库 +1：调度器据此发现「攒批中途换了号」，避免把旧号的事件写进新号库 */
let generation = 0;
const switchListeners = new Set<(uin: string | null) => void>();

export function dbGeneration(): number {
  return generation;
}

/** 换号时调用（清各模块的内存缓存：群名、Jev 分数、分诊时间…）。回调里抛错只告警。 */
export function onAccountSwitch(cb: (uin: string | null) => void): void {
  switchListeners.add(cb);
}

/** 由 accounts.ts 在切库完成后调用，通知订阅者清缓存（uin=null = 回到兜底库）。 */
export function notifyAccountSwitch(uin: string | null): void {
  for (const cb of switchListeners) {
    try {
      cb(uin);
    } catch (e) {
      console.warn('[db] 换号后的缓存清理出错：', e);
    }
  }
}

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
  message_id   TEXT NOT NULL,
  group_id     TEXT NOT NULL,
  sender_name  TEXT NOT NULL,
  text         TEXT NOT NULL,
  sent_at      INTEGER NOT NULL,
  source       TEXT NOT NULL,            -- MessageSource
  processed    INTEGER NOT NULL DEFAULT 0,   -- C 处理完置 1
  filtered_out INTEGER NOT NULL DEFAULT 0,   -- C 规则过滤掉置 1
  created_at   INTEGER NOT NULL,
  -- 复合主键（schema v2）：NapCat 的 message_id 是本地短 id，不同群可能撞号
  PRIMARY KEY (group_id, message_id)
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
-- ingest 按 message_id 查「这条消息是否已经变成过事件」（老版本清理没留 message_seen）
CREATE INDEX IF NOT EXISTS idx_event_sources_message ON event_sources(message_id);
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
-- 课表：weekday 1=周一…7=周日，start/end 是节次范围（第几节，1–12），weeks 是 JSON 数组如 [3,4,...,16]
CREATE TABLE IF NOT EXISTS courses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  teacher      TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  weekday      INTEGER NOT NULL,
  start_section INTEGER NOT NULL,
  end_section   INTEGER NOT NULL,
  weeks        TEXT NOT NULL
);
-- 每群历史补齐游标（R03）：补拉到哪、是否到顶、被页数上限截断没有，都留痕可展示
CREATE TABLE IF NOT EXISTS group_sync (
  group_id     TEXT PRIMARY KEY,
  last_sync_at INTEGER NOT NULL,
  oldest_at    INTEGER,
  complete     INTEGER NOT NULL DEFAULT 0,
  reason       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 已处理过的消息 id：清理原始消息时留下，防止 30 天刷新把旧消息再处理一遍。
-- group_id='' 的是 v1 老库迁来的（当时不记群），去重时同样认。
CREATE TABLE IF NOT EXISTS message_seen (
  group_id     TEXT NOT NULL DEFAULT '',
  message_id   TEXT NOT NULL,
  sent_at      INTEGER NOT NULL,
  PRIMARY KEY (group_id, message_id)
);
`;

/** 当前 schema 版本（D3）：1 = 老库；2 = (group_id, message_id) 复合主键；3 = courses 按节次范围存（start_section/end_section） */
const SCHEMA_VERSION = 3;

function schemaVersion(): number {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) || 1 : 1;
  } catch {
    return 1; // kv 表都还没有的库按 1 处理
  }
}

/** 老库缺列时补列（CREATE TABLE IF NOT EXISTS 不会给已有表加列） */
function ensureColumn(table: string, col: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/**
 * v1 → v2：messages 与 message_seen 重建成 (group_id, message_id) 复合主键。
 * 老 message_seen 没有 group_id，迁过来的行记 ''（ingest 去重时 '' 同样认，兼容旧记录）。
 */
function migrateToV2(): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE messages_v2 (
        message_id   TEXT NOT NULL,
        group_id     TEXT NOT NULL,
        sender_name  TEXT NOT NULL,
        text         TEXT NOT NULL,
        sent_at      INTEGER NOT NULL,
        source       TEXT NOT NULL,
        processed    INTEGER NOT NULL DEFAULT 0,
        filtered_out INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (group_id, message_id)
      );
      INSERT OR IGNORE INTO messages_v2
        SELECT message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, created_at
        FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_v2 RENAME TO messages;
      CREATE INDEX idx_messages_group_time ON messages(group_id, sent_at);
      CREATE INDEX idx_messages_processed  ON messages(processed);

      CREATE TABLE message_seen_v2 (
        group_id     TEXT NOT NULL DEFAULT '',
        message_id   TEXT NOT NULL,
        sent_at      INTEGER NOT NULL,
        PRIMARY KEY (group_id, message_id)
      );
      INSERT OR IGNORE INTO message_seen_v2 SELECT '' AS group_id, message_id, sent_at FROM message_seen;
      DROP TABLE message_seen;
      ALTER TABLE message_seen_v2 RENAME TO message_seen;
    `);
    db.exec('COMMIT');
  } catch (e) {
    rollbackTx();
    throw e;
  }
}

/**
 * v2 → v3：courses 从「两节一块 block(1–5)」改成「节次范围 start_section/end_section(1–12)」。
 * 旧数据 block b 对应第 2b-1 ~ 2b 节；新库已是新列（无 block 列）则跳过。
 */
function migrateToV3(): void {
  const cols = db.prepare('PRAGMA table_info(courses)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'block')) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE courses_v3 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        teacher       TEXT NOT NULL DEFAULT '',
        location      TEXT NOT NULL DEFAULT '',
        weekday       INTEGER NOT NULL,
        start_section INTEGER NOT NULL,
        end_section   INTEGER NOT NULL,
        weeks         TEXT NOT NULL
      );
      INSERT INTO courses_v3 (id, name, teacher, location, weekday, start_section, end_section, weeks)
        SELECT id, name, teacher, location, weekday,
               MIN(MAX(block * 2 - 1, 1), 12), MIN(MAX(block * 2, 1), 12), weeks
        FROM courses;
      DROP TABLE courses;
      ALTER TABLE courses_v3 RENAME TO courses;
    `);
    db.exec('COMMIT');
  } catch (e) {
    rollbackTx();
    throw e;
  }
}

/** 老库自动升级：补列 + 版本化迁移（D3）。在 db.exec(SCHEMA) 之后调用。 */
function migrate(): void {
  ensureColumn('courses', 'details', "details TEXT NOT NULL DEFAULT '{}'");
  db.exec(`CREATE TABLE IF NOT EXISTS timetable_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
    reason TEXT NOT NULL, snapshot TEXT NOT NULL
  )`);
  ensureColumn('events', 'level', 'level INTEGER NOT NULL DEFAULT 2');
  ensureColumn('events', 'level_locked', 'level_locked INTEGER NOT NULL DEFAULT 0');
  ensureColumn('groups', 'course_name', 'course_name TEXT');
  db.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('memory_enabled', '1')").run();
  if (schemaVersion() < 2) migrateToV2();
  if (schemaVersion() < 3) migrateToV3();
  db.prepare(
    "INSERT INTO kv (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
}

/** B12：嵌套/复用时不在事务里才 BEGIN；调用方成对使用 commitTx / rollbackTx */
export function beginTx(): void {
  if (!db.isTransaction) db.exec('BEGIN IMMEDIATE');
}
export function commitTx(): void {
  if (db.isTransaction) db.exec('COMMIT');
}
/** B12：ROLLBACK 本身也可能抛（连接已坏），不让它盖住原始错误 */
export function rollbackTx(): void {
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } catch {
    // 忽略：回滚失败比原始异常次要
  }
}

/**
 * 打开库并建表（幂等）。启动时由 accounts.ts 的 initAccounts 决定开哪个库，不要直接调这里
 * （accounts.ts 与测试除外）。传 ':memory:' 则是内存库（测试用），DATA_DIR 不会被创建。
 * 重复调用（测试切库 / 换号）时先关掉旧连接，避免句柄泄漏、Windows 上文件被锁。
 */
export function openDb(path: string): void {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  if (db?.isOpen) db.close();
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  migrate();
  generation++;
}
