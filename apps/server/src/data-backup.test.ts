import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accountBackupStatus,
  accountDbPath,
  accountEpoch,
  restoreCurrentAccountBackup,
  runAutomaticBackupNow,
  setAccountsDirForTest,
  switchAccount,
} from './accounts.js';
import {
  createPortableBackup,
  parsePortableBackup,
  validateBackupDatabase,
  writeParsedBackup,
} from './data-backup.js';
import { db } from './db/index.js';

const roots: string[] = [];

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'classrep-data-backup-'));
  roots.push(root);
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  await switchAccount('10001');
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function addMessage(id: string): void {
  db.prepare(
    `INSERT INTO messages
      (message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, created_at)
     VALUES (?, 'g', '老师', '匿名测试通知', 1, 'import', 1, 0, 1)`,
  ).run(id);
}

describe('账号数据备份与恢复', () => {
  it('导出一致性容器，恢复后回到快照内容并保留恢复前数据库', async () => {
    addMessage('before-backup');
    const portable = createPortableBackup();
    const parsed = parsePortableBackup(portable);
    expect(parsed.metadata.database_size).toBe(parsed.database.length);
    expect(parsed.metadata.database_sha256).toMatch(/^[0-9a-f]{64}$/);

    addMessage('after-backup');
    const candidate = join(accountDbPath('10001'), '..', '.restore-upload-test.db');
    writeParsedBackup(portable, candidate);
    const oldEpoch = accountEpoch();
    const result = await restoreCurrentAccountBackup(oldEpoch, candidate);
    expect(result.status).toBe('restored');
    expect(accountEpoch()).not.toBe(oldEpoch);
    expect(db.prepare('SELECT message_id FROM messages ORDER BY message_id').all()).toEqual([
      { message_id: 'before-backup' },
    ]);

    if (result.status !== 'restored') throw new Error('unreachable');
    expect(existsSync(result.safetyBackup)).toBe(true);
    expect(validateBackupDatabase(result.safetyBackup).schemaVersion).toBeGreaterThan(0);
    const safety = new DatabaseSync(result.safetyBackup, { readOnly: true });
    try {
      expect(safety.prepare('SELECT message_id FROM messages ORDER BY message_id').all()).toEqual([
        { message_id: 'after-backup' },
        { message_id: 'before-backup' },
      ]);
    } finally {
      safety.close();
    }
    expect(accountBackupStatus().latest_restore_backup_at).not.toBeNull();
  });

  it('每天首次挂载自动生成快照', () => {
    const dir = join(accountDbPath('10001'), '..', 'backups');
    expect(readdirSync(dir).filter((name) => /^auto-.*\.db$/.test(name))).toHaveLength(1);
  });

  it('发现中断留下的损坏日快照时重新生成，不把“文件存在”当成功', () => {
    const dir = join(accountDbPath('10001'), '..', 'backups');
    const name = readdirSync(dir).find((item) => /^auto-.*\.db$/.test(item));
    expect(name).toBeTruthy();
    const file = join(dir, name!);
    writeFileSync(file, 'partial snapshot');
    expect(runAutomaticBackupNow()).toBe(true);
    expect(validateBackupDatabase(file).schemaVersion).toBeGreaterThan(0);
  });

  it('应用不重启也会在跨天检查时生成新快照', () => {
    const dir = join(accountDbPath('10001'), '..', 'backups');
    expect(runAutomaticBackupNow(Date.UTC(2040, 0, 2, 12))).toBe(true);
    expect(runAutomaticBackupNow(Date.UTC(2040, 0, 3, 12))).toBe(true);
    expect(readdirSync(dir).filter((name) => /^auto-.*\.db$/.test(name))).toHaveLength(3);
  });

  it('容器被篡改时在写入数据库前拒绝', () => {
    const portable = createPortableBackup();
    portable[portable.length - 1] = portable[portable.length - 1]! ^ 1;
    expect(() => parsePortableBackup(portable)).toThrow(/SHA-256/);
    expect(() => writeParsedBackup(portable, join(accountDbPath('10001'), '..', '.bad.db'))).toThrow(/SHA-256/);
  });

  it('高于当前 schema 的数据库拒绝恢复', () => {
    const candidate = join(accountDbPath('10001'), '..', '.future.db');
    const portable = createPortableBackup();
    writeParsedBackup(portable, candidate);
    const future = new DatabaseSync(candidate);
    future.prepare("UPDATE kv SET value = '999' WHERE key = 'schema_version'").run();
    future.close();
    expect(() => validateBackupDatabase(candidate)).toThrow(/更高版本/);
  });

  it('目标账号数据库已损坏时，仍可恢复到该账号，不会改写之前的账号', async () => {
    addMessage('backup-from-a');
    const portable = createPortableBackup();
    const accountA = accountDbPath('10001');
    const brokenB = accountDbPath('20002');
    mkdirSync(join(brokenB, '..'), { recursive: true });
    writeFileSync(brokenB, 'not a sqlite database');
    await expect(switchAccount('20002')).rejects.toThrow();

    const candidate = join(brokenB, '..', '.restore-upload-repair.db');
    writeParsedBackup(portable, candidate);
    const result = await restoreCurrentAccountBackup(accountEpoch(), candidate);
    expect(result.status).toBe('restored');
    expect(db.prepare("SELECT message_id FROM messages WHERE message_id='backup-from-a'").get()).toBeTruthy();

    const untouchedA = new DatabaseSync(accountA, { readOnly: true });
    try {
      expect(untouchedA.prepare("SELECT message_id FROM messages WHERE message_id='backup-from-a'").get()).toBeTruthy();
    } finally {
      untouchedA.close();
    }
  });
});
