import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb, SCHEMA_VERSION } from '../db/index.js';
import { WorkspaceRegistry } from './registry.js';
import { migrateToSingleton } from './migrate-singleton.js';

let root: string;
let registry: WorkspaceRegistry;
let targetPath: string;
let sourcePath: string;
const sources = JSON.stringify([{ group_id: 'synthetic-physics', group_name: '人工群', message_id: 'synthetic-msg', sender_name: '人工老师', text: '人工作业通知', sent_at: 1 }]);
function withDb<T>(path: string, work: (conn: DatabaseSync) => T): T {
  const conn = new DatabaseSync(path);
  try { return work(conn); } finally { conn.close(); }
}
function rule(conn: DatabaseSync, id: number, text: string): void {
  conn.prepare(`INSERT INTO assistant_memories(id,text,action,course,event_types,enabled,created_at,updated_at)
    VALUES (?,?,'exclude_calendar','物理','["assignment"]',1,1,1)`).run(id, text);
}
function receipt(conn: DatabaseSync, ruleId: number, key = 'same-artificial-key'): void {
  conn.prepare(`INSERT INTO assistant_suppressions(dedupe_key,rule_id,group_id,title,course,sources,created_at)
    VALUES (?,?,'synthetic-physics','人工作业','物理',?,1)`).run(key, ruleId, sources);
}
function migrate(): void {
  migrateToSingleton(registry, { spaces: join(root, 'spaces'), accounts: join(root, 'accounts') }, join(root, 'backups'));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'classrep-assistant-merge-synthetic-'));
  registry = new WorkspaceRegistry(join(root, 'synthetic.workspace-registry.sqlite3'));
  const target = registry.registerLegacyQq('10001', '人工 QQ 空间');
  const source = registry.createForIdentity({ platform: 'wechat', account_id: 'wxid_synthetic_merge' }, '人工微信空间');
  const roots = { spaces: join(root, 'spaces'), accounts: join(root, 'accounts') };
  targetPath = registry.businessDbPath(target.space_id, roots);
  sourcePath = registry.businessDbPath(source.space_id, roots);
  openDb(targetPath); db.close();
  openDb(sourcePath); db.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (db?.isOpen) db.close();
  registry?.close();
  const rel = relative(realpathSync(tmpdir()), realpathSync(root));
  if (isAbsolute(rel) || !rel.startsWith('classrep-assistant-merge-synthetic-') || rel.includes('..')) throw new Error('SYNTHETIC_CLEANUP_PATH');
  rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
});

describe('singleton assistant memory migration', () => {
  it('creates v12 completion tables before merging into v11 and preserves primary completion decisions', () => {
    withDb(targetPath, c => { c.exec('DROP TABLE course_completions'); c.exec("UPDATE kv SET value='11' WHERE key='schema_version'"); });
    withDb(sourcePath, c => c.prepare('INSERT INTO course_completions VALUES (?,?,?,?,?,?,?)').run('synthetic-key', 'course@date', '2026-09-07', 1, 2, 1, 10));
    migrate();
    openDb(targetPath);
    expect(db.prepare("SELECT value FROM kv WHERE key='schema_version'").get()?.value).toBe('12');
    expect(db.prepare('SELECT done FROM course_completions').get()?.done).toBe(1);
    db.close();
  });
  it('keeps primary completion on duplicate semantic key without blocking migration', () => {
    for (const [path, done, time] of [[targetPath, 0, 5], [sourcePath, 1, 10]] as const)
      withDb(path, c => c.prepare('INSERT INTO course_completions VALUES (?,?,?,?,?,?,?)').run('same-key', 'course@date', '2026-09-07', 1, 2, done, time));
    migrate();
    withDb(targetPath, c => expect(c.prepare('SELECT done,updated_at FROM course_completions').get()).toEqual({ done: 0, updated_at: 5 }));
    withDb(sourcePath, c => expect(c.prepare('SELECT done FROM course_completions').get()?.done).toBe(1));
  });
  it('remaps colliding rule IDs and audit fingerprints without changing source evidence or originals', () => {
    withDb(targetPath, c => { rule(c, 1, '主空间人工偏好'); receipt(c, 1); });
    withDb(sourcePath, c => { rule(c, 1, '次空间人工偏好'); receipt(c, 1); });
    migrate();
    withDb(targetPath, c => {
      const rules = c.prepare('SELECT id,text,enabled FROM assistant_memories ORDER BY id').all();
      expect(rules).toEqual([{ id: 1, text: '主空间人工偏好', enabled: 1 }, { id: 2, text: '次空间人工偏好', enabled: 1 }]);
      const rows = c.prepare('SELECT s.rule_id,s.sources,m.text FROM assistant_suppressions s JOIN assistant_memories m ON m.id=s.rule_id ORDER BY s.id').all();
      expect(rows).toEqual([{ rule_id: 1, sources, text: '主空间人工偏好' }, { rule_id: 2, sources, text: '次空间人工偏好' }]);
      expect(c.prepare('SELECT COUNT(DISTINCT dedupe_key) AS n FROM assistant_suppressions').get()?.n).toBe(2);
    });
    expect(existsSync(sourcePath)).toBe(true);
    withDb(sourcePath, c => { expect(c.prepare('SELECT rule_id,sources FROM assistant_suppressions').get()).toEqual({ rule_id: 1, sources }); });
    expect(registry.list()).toHaveLength(1);
  });

  it('preserves receipts for deleted rules without attributing them to a live target rule', () => {
    withDb(targetPath, c => { rule(c, 1, '不相关人工规则'); receipt(c, -1, 'target-orphan'); });
    withDb(sourcePath, c => { receipt(c, 1, 'source-orphan-a'); receipt(c, 1, 'source-orphan-b'); });
    migrate();
    withDb(targetPath, c => {
      expect(c.prepare('SELECT rule_id FROM assistant_suppressions ORDER BY id').all()).toEqual([{ rule_id: -1 }, { rule_id: -2 }, { rule_id: -2 }]);
      expect(c.prepare('SELECT COUNT(*) AS n FROM assistant_suppressions s JOIN assistant_memories m ON m.id=s.rule_id').get()?.n).toBe(0);
      expect(c.prepare('SELECT sources FROM assistant_suppressions ORDER BY id').all()).toEqual([{ sources }, { sources }, { sources }]);
    });
  });

  it('merges v11 memories into a v10 target before normal openDb migration', () => {
    withDb(targetPath, c => {
      c.exec("DROP TABLE assistant_suppressions; DROP TABLE assistant_memories; UPDATE kv SET value='10' WHERE key='schema_version'");
    });
    withDb(sourcePath, c => { rule(c, 1, '旧目标接收的人工规则'); receipt(c, 1); });
    migrate();
    withDb(targetPath, c => {
      expect(c.prepare("SELECT value FROM kv WHERE key='schema_version'").get()?.value).toBe('10');
      expect(c.prepare('SELECT sources FROM assistant_suppressions').get()?.sources).toBe(sources);
    });
    openDb(targetPath);
    expect(db.prepare("SELECT value FROM kv WHERE key='schema_version'").get()?.value).toBe(String(SCHEMA_VERSION));
    expect(db.prepare('SELECT COUNT(*) AS n FROM assistant_memories').get()?.n).toBe(1);
    expect(db.prepare('SELECT s.sources FROM assistant_suppressions s JOIN assistant_memories m ON m.id=s.rule_id').get()?.sources).toBe(sources);
  });

  it('does not duplicate rules or receipts after a registry failure or repeated startup', () => {
    withDb(sourcePath, c => { rule(c, 1, '人工偏好'); receipt(c, 1); });
    vi.spyOn(registry, 'consolidate').mockImplementationOnce(() => { throw new Error('synthetic registry failure'); });
    expect(migrate).toThrow('synthetic registry failure');
    expect(registry.list()).toHaveLength(2);
    migrate(); migrate();
    withDb(targetPath, c => {
      expect(c.prepare('SELECT COUNT(*) AS n FROM assistant_memories').get()?.n).toBe(1);
      expect(c.prepare('SELECT COUNT(*) AS n FROM assistant_suppressions').get()?.n).toBe(1);
    });
    expect(registry.list()).toHaveLength(1);
  });
});
