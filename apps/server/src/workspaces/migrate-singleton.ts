import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { WorkspaceRegistry, WorkspaceError } from './registry.js';

const tables = ['groups', 'messages', 'events', 'event_sources', 'event_history', 'event_proposals',
  'todos', 'level_feedback', 'level_rules', 'courses', 'group_sync', 'kv', 'pipeline_failures',
  'message_seen', 'wechat_delivery_batches', 'timetable_versions', 'assistant_memories', 'assistant_suppressions', 'course_completions'];

/** The singleton merge runs before openDb migrates the destination. Older targets
 * therefore need these known v11/v12 tables before a newer secondary library can
 * be copied. Never execute schema SQL supplied by the source database. */
function ensureAssistantTables(target: DatabaseSync): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS course_completions (
      completion_key TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL, date TEXT NOT NULL,
      start INTEGER NOT NULL, end INTEGER NOT NULL, done INTEGER NOT NULL CHECK (done IN (0,1)), updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, action TEXT NOT NULL,
      course TEXT NOT NULL DEFAULT '', event_types TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_suppressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT NOT NULL UNIQUE,
      rule_id INTEGER NOT NULL, group_id TEXT NOT NULL, title TEXT NOT NULL,
      course TEXT NOT NULL, sources TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
}

/** Runs before collectors start. Original libraries and checked SQLite snapshots remain on disk. */
export function migrateToSingleton(registry: WorkspaceRegistry, roots: { spaces: string; accounts: string }, backupRoot: string): void {
  const spaces = registry.list();
  if (spaces.length < 2) { registry.singleton(); return; }
  for (const platform of ['qq', 'wechat']) {
    if (registry.bindings().filter(b => b.platform === platform).length > 1) {
      throw new WorkspaceError('WORKSPACE_PLATFORM_BINDING_CONFLICT');
    }
  }
  const target = spaces.find(s => s.storage_kind === 'legacy_qq') ?? spaces[0]!;
  const directory = join(backupRoot, `single-workspace-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  registry.backup(join(directory, 'registry.sqlite3'));
  const registryProof = new DatabaseSync(join(directory, 'registry.sqlite3'), { readOnly: true });
  try {
    if (registryProof.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('WORKSPACE_BACKUP_FAILED');
  } finally { registryProof.close(); }
  const snapshots = new Map<string, string>();
  for (const space of spaces) {
    const path = registry.businessDbPath(space.space_id, roots);
    if (!existsSync(path)) continue;
    const original = new DatabaseSync(path, { readOnly: true });
    try {
      const snapshot = join(directory, `${space.space_id}.sqlite3`);
      original.prepare('VACUUM INTO ?').run(snapshot);
      const proof = new DatabaseSync(snapshot, { readOnly: true });
      try {
        if (proof.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('WORKSPACE_BACKUP_FAILED');
      } finally { proof.close(); }
      snapshots.set(space.space_id, snapshot);
    } finally { original.close(); }
  }
  const targetPath = registry.businessDbPath(target.space_id, roots);
  // Only the target library is changed; secondary originals remain untouched.
  if (!existsSync(targetPath)) throw new Error('WORKSPACE_TARGET_MISSING');
  const destination = new DatabaseSync(targetPath);
  try {
    destination.exec('BEGIN IMMEDIATE');
    ensureAssistantTables(destination);
    for (const space of spaces.filter(s => s.space_id !== target.space_id)) {
      const marker = `singleton_merged:${space.space_id}`;
      if (destination.prepare('SELECT 1 FROM kv WHERE key=?').get(marker)) continue;
      const snapshot = snapshots.get(space.space_id);
      if (snapshot) {
        const source = new DatabaseSync(snapshot, { readOnly: true });
        try { mergeLibrary(destination, source, space.space_id, target.space_id); } finally { source.close(); }
      }
      destination.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run(marker, directory);
    }
    destination.exec('COMMIT');
    // Data commits first; markers make registry-write failure safe to retry.
    registry.consolidate(target.space_id);
  } catch (error) {
    if (destination.isTransaction) destination.exec('ROLLBACK');
    throw error;
  } finally { destination.close(); }
}

function mergeLibrary(target: DatabaseSync, source: DatabaseSync, sourceId: string, targetId: string): void {
  const maps = new Map<string, Map<number, number>>();
  const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name)));
  if ([...sourceTables].some(table => !tables.includes(table))) throw new Error('WORKSPACE_MERGE_SCHEMA_UNSUPPORTED');
  const orphanRules = new Map<number, number>();
  let nextOrphanRule = Number(target.prepare(`SELECT MIN(rule_id) AS lowest FROM assistant_suppressions`).get()?.lowest ?? 0);
  nextOrphanRule = Math.min(nextOrphanRule, 0) - 1;
  for (const table of tables) {
    if (!sourceTables.has(table)) continue;
    const columns = target.prepare(`PRAGMA table_info("${table}")`).all();
    const allowed = new Set(columns.map(column => String(column.name)));
    const primary = columns.filter(column => Number(column.pk) > 0).map(column => String(column.name));
    const ids = new Map<number, number>(); maps.set(table, ids);
    for (const original of source.prepare(`SELECT * FROM "${table}"`).all()) {
      const row = { ...original } as Record<string, SQLInputValue>;
      if (Object.keys(row).some(key => !allowed.has(key))) throw new Error('WORKSPACE_MERGE_SCHEMA_UNSUPPORTED');
      const oldId = typeof row.id === 'number' ? row.id : null;
      if (oldId !== null) delete row.id;
      if (table === 'wechat_delivery_batches' && row.destination === sourceId) row.destination = targetId;
      if (table === 'assistant_suppressions') {
        const oldRule = Number(row.rule_id);
        if (!Number.isSafeInteger(oldRule)) throw new Error('WORKSPACE_MERGE_MEMORY_REFERENCE');
        let mapped = maps.get('assistant_memories')?.get(oldRule);
        // Deleting a preference deliberately preserves historical source evidence.
        // Give such orphan references a negative, non-reusable ID instead of
        // accidentally attributing them to a different rule in the primary DB.
        if (mapped === undefined) {
          mapped = orphanRules.get(oldRule);
          if (mapped === undefined) { mapped = nextOrphanRule--; orphanRules.set(oldRule, mapped); }
        }
        row.rule_id = mapped;
        // This audit fingerprint includes the old rule ID and event type, which
        // cannot be reconstructed from a stored source snapshot. Namespace it
        // by the source library; the per-library transaction marker makes retries
        // idempotent even if registry consolidation fails after the data commit.
        row.dedupe_key = createHash('sha256').update(JSON.stringify(['assistant-migration', sourceId, targetId, row.dedupe_key])).digest('hex');
      }
      if (table === 'kv' && String(row.key).startsWith('wechat_selection_v1:')) {
        const state = JSON.parse(String(row.value));
        if (state.destination !== sourceId || typeof state.account !== 'string') throw new Error('WORKSPACE_MERGE_SELECTION_INVALID');
        state.destination = targetId;
        row.key = 'wechat_selection_v1:' + createHash('sha256').update(JSON.stringify([targetId, state.account])).digest('hex');
        row.value = JSON.stringify(state);
      }
      if ('event_id' in row) {
        const mapped = maps.get('events')?.get(Number(row.event_id));
        if (mapped === undefined) throw new Error('WORKSPACE_MERGE_EVENT_REFERENCE');
        row.event_id = mapped;
      }
      if (table === 'level_rules') {
        row.feedback_ids = JSON.stringify((JSON.parse(String(row.feedback_ids)) as number[]).map(id => {
          const mapped = maps.get('level_feedback')?.get(id);
          if (mapped === undefined) throw new Error('WORKSPACE_MERGE_FEEDBACK_REFERENCE');
          return mapped;
        }));
      }
      if (oldId === null) {
        const existing = target.prepare(`SELECT * FROM "${table}" WHERE ${primary.map(key => `"${key}"=?`).join(' AND ')}`)
          .get(...primary.map(key => row[key]!));
        if (existing) {
          // Workspace preferences use the primary library; both originals are backed up.
          if (table === 'course_completions' || (table === 'kv' && !String(row.key).startsWith('wechat_selection_v1:'))
              || Object.keys(row).every(key => existing[key] === row[key])) continue;
          throw new Error(`WORKSPACE_MERGE_CONFLICT:${table}`);
        }
      }
      const keys = Object.keys(row);
      const result = target.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map(key => row[key]!));
      if (oldId !== null) ids.set(oldId, Number(result.lastInsertRowid));
    }
  }
}
