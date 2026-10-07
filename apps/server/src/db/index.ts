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
import { redactSensitive } from '../redact.js';

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
      console.warn(`[db] 换号后的缓存清理出错：${redactSensitive(e)}`);
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
  decision_reason TEXT NOT NULL DEFAULT 'pending', -- rule_noise / jev_below_threshold / event_recognized / pending_confirmation / llm_no_event / pipeline_error
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
  manual_locked_fields TEXT NOT NULL DEFAULT '[]', -- 用户手动修正过的业务字段，AI 不再覆盖
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
-- 低置信度的新建/改期/取消先保存为结构化提案，由用户接受或拒绝。
-- 每次新提案会把同事件旧的 pending 提案标为 superseded，历史仍保留可审计。
CREATE TABLE IF NOT EXISTS event_proposals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          INTEGER NOT NULL,
  kind              TEXT NOT NULL,       -- create | update | cancel
  reason            TEXT NOT NULL DEFAULT 'low_confidence', -- low_confidence | manual_lock_conflict
  proposed_changes  TEXT NOT NULL,       -- JSON：Record<字段, {from,to}>
  source_message_ids TEXT NOT NULL DEFAULT '[]',
  confidence        REAL NOT NULL,
  event_fingerprint TEXT,                -- create 提案的原始完整事件快照；人工编辑后仍可稳定识别重放
  base_version      INTEGER NOT NULL,
  base_status       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | superseded
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  UNIQUE(event_id, kind, source_message_ids)
);
CREATE INDEX IF NOT EXISTS idx_event_proposals_event_status
  ON event_proposals(event_id, status, id);
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
-- 课表（PR#31 模型）：weekday 1=周一…7=周日；block 是排序/显示提示（两节一块 1–6）；
-- weeks 是 JSON 数组如 [3,4,...,16]；details 是整门课的 JSON（start_period/end_period 精确节次、
-- 校区、来源、例外等都在这里，列表查询只按 weekday/block 粗筛，展示时读 details）
CREATE TABLE IF NOT EXISTS courses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  teacher      TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  weekday      INTEGER NOT NULL,
  block        INTEGER NOT NULL,
  weeks        TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '{}'
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

/** 当前 schema 版本（D3）：v6 = create 提案原始指纹；v7 = 消息处理决策原因。 */
export const SCHEMA_VERSION = 7;

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
 * v3 → v4：PR#31 合并后的统一课表存储。courses 回到「block + details JSON」形状——
 * block 只用于排序/显示，精确节次等完整信息在 details 里。
 * 两种来源：
 *   · v1/v2 老库（有 block 无 details）：ensureColumn 补 details 即可，不用重建
 *   · v3 迁过的库（start_section/end_section、无 block）：重建表，block 由节次折回，
 *     精确节次写进 details.start_period/end_period 保住原信息
 */
function migrateToV4(): void {
  const cols = db.prepare('PRAGMA table_info(courses)').all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'block')) return; // v1/v2/v4 形状，无需重建
  if (!cols.some((c) => c.name === 'start_section')) return; // 意外形状不动
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE courses_v4 (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        name      TEXT NOT NULL,
        teacher   TEXT NOT NULL DEFAULT '',
        location  TEXT NOT NULL DEFAULT '',
        weekday   INTEGER NOT NULL,
        block     INTEGER NOT NULL,
        weeks     TEXT NOT NULL,
        details   TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO courses_v4 (id, name, teacher, location, weekday, block, weeks, details)
        SELECT id, name, teacher, location, weekday,
               (start_section + 1) / 2, weeks,
               json_object('start_period', start_section, 'end_period', end_section)
        FROM courses;
      DROP TABLE courses;
      ALTER TABLE courses_v4 RENAME TO courses;
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
  ensureColumn('events', 'manual_locked_fields', "manual_locked_fields TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('event_proposals', 'reason', "reason TEXT NOT NULL DEFAULT 'low_confidence'");
  ensureColumn('event_proposals', 'event_fingerprint', 'event_fingerprint TEXT');
  // v5 的 create 提案没有独立快照：升级时只从当前事件行回填一次。之后人工编辑 events
  // 不会再改变这个值；新提案则在 reconcile 创建时直接保存 LLM 的原始完整事件。
  db.exec(`
    UPDATE event_proposals
       SET event_fingerprint = (
         SELECT json_object(
           'type', e.type,
           'title', e.title,
           'description', e.description,
           'start_at', e.start_at,
           'end_at', e.end_at,
           'deadline_at', e.deadline_at,
           'location', e.location,
           'action_required', e.action_required,
           'level', e.level
         )
           FROM events e
          WHERE e.id = event_proposals.event_id
       )
     WHERE kind = 'create' AND event_fingerprint IS NULL
  `);
  ensureColumn('groups', 'course_name', 'course_name TEXT');
  db.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('memory_enabled', '1')").run();
  if (schemaVersion() < 2) migrateToV2();
  // v1→v2 会重建 messages，所以必须在它之后补诊断列。
  ensureColumn('messages', 'decision_reason', "decision_reason TEXT NOT NULL DEFAULT 'pending'");
  if (schemaVersion() < 4) migrateToV4(); // v3 是过渡形状，直接统一到 v4
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
 * 新库先在候选连接上完整建表/迁移，全部成功后才替换全局连接。任何一步失败都关闭候选、
 * 保留旧连接，避免出现“current 仍是 A，但全局 db 已指向半初始化 B”的串号窗口。
 */
export function openDb(path: string): void {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const previous = db;
  const candidate = new DatabaseSync(path);
  try {
    // migrate() 等旧代码通过模块级 live binding 访问 db；初始化全程同步，期间不会让出事件循环。
    db = candidate;
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(SCHEMA);
    migrate();

    // 候选已完整可用，再关闭旧库并提交替换；close 失败同样回滚到旧连接。
    db = previous;
    if (previous?.isOpen) previous.close();
    db = candidate;
  } catch (error) {
    db = previous;
    try {
      if (candidate.isOpen) candidate.close();
    } catch {
      // 候选连接关闭失败不覆盖原始挂库错误；它从未发布给其它异步任务。
    }
    throw error;
  }
  generation++;
}
