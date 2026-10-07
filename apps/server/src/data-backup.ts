import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, SCHEMA_VERSION } from './db/index.js';

export const BACKUP_MAGIC = 'CLASSREP_BACKUP_V1';
export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

export interface BackupMetadata {
  format: 1;
  created_at: string;
  schema_version: number;
  database_size: number;
  database_sha256: string;
}

export interface ParsedBackup {
  metadata: BackupMetadata;
  database: Buffer;
}

function sqliteVersion(database: DatabaseSync): number {
  try {
    const row = database.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as
      | { value?: unknown }
      | undefined;
    const version = Number(row?.value ?? 1);
    return Number.isInteger(version) && version > 0 ? version : 1;
  } catch {
    return 1;
  }
}

/** SQLite 自己生成一致性快照；不能用 fs.copyFile 复制正在 WAL 写入的数据库。 */
export function snapshotDatabase(destination: string, source: DatabaseSync = db): void {
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { force: true });
  source.prepare('VACUUM INTO ?').run(destination);
}

export function createPortableBackup(source: DatabaseSync = db): Buffer {
  const file = join(tmpdir(), `classrep-backup-${randomUUID()}.db`);
  try {
    snapshotDatabase(file, source);
    const database = readFileSync(file);
    if (database.length > MAX_BACKUP_BYTES) {
      throw new Error('账号数据库超过 256 MB，无法生成可恢复备份');
    }
    const metadata: BackupMetadata = {
      format: 1,
      created_at: new Date().toISOString(),
      schema_version: sqliteVersion(source),
      database_size: database.length,
      database_sha256: createHash('sha256').update(database).digest('hex'),
    };
    return Buffer.concat([
      Buffer.from(`${BACKUP_MAGIC}\n${JSON.stringify(metadata)}\n`, 'utf8'),
      database,
    ]);
  } finally {
    rmSync(file, { force: true });
  }
}

export function parsePortableBackup(input: Uint8Array): ParsedBackup {
  if (input.byteLength === 0 || input.byteLength > MAX_BACKUP_BYTES) {
    throw new Error('备份文件为空或超过 256 MB');
  }
  const buffer = Buffer.from(input);
  const first = buffer.indexOf(0x0a);
  const second = first < 0 ? -1 : buffer.indexOf(0x0a, first + 1);
  if (first < 0 || second < 0 || first > 64 || second - first > 8192) {
    throw new Error('不是 ClassRep 备份文件');
  }
  if (buffer.subarray(0, first).toString('utf8') !== BACKUP_MAGIC) {
    throw new Error('备份格式不受支持');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(buffer.subarray(first + 1, second).toString('utf8'));
  } catch {
    throw new Error('备份元数据损坏');
  }
  const item = raw as Partial<BackupMetadata> | null;
  const database = buffer.subarray(second + 1);
  if (
    item === null || item.format !== 1 || typeof item.created_at !== 'string' ||
    !Number.isInteger(item.schema_version) || typeof item.database_size !== 'number' ||
    typeof item.database_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.database_sha256)
  ) {
    throw new Error('备份元数据不完整');
  }
  if (item.database_size !== database.length) throw new Error('备份数据库大小不匹配');
  const actual = createHash('sha256').update(database).digest('hex');
  if (actual !== item.database_sha256.toLowerCase()) throw new Error('备份 SHA-256 校验失败');
  return { metadata: item as BackupMetadata, database };
}

const REQUIRED_TABLES = ['events', 'groups', 'messages', 'courses', 'todos', 'kv'] as const;

/** 在替换当前账号数据库之前，用独立只读连接验证候选文件。 */
export function validateBackupDatabase(file: string): { schemaVersion: number; size: number } {
  if (!statSync(file).isFile() || statSync(file).size === 0) throw new Error('备份数据库为空');
  const candidate = new DatabaseSync(file, { readOnly: true });
  try {
    const check = candidate.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined;
    if (check?.quick_check !== 'ok') throw new Error('数据库完整性检查失败');
    const tables = new Set(
      (candidate.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    const missing = REQUIRED_TABLES.filter((name) => !tables.has(name));
    if (missing.length) throw new Error(`备份缺少必要数据表：${missing.join('、')}`);
    const schemaVersion = sqliteVersion(candidate);
    if (schemaVersion > SCHEMA_VERSION) {
      throw new Error(`备份来自更高版本（schema ${schemaVersion}），请先升级 ClassRep`);
    }
    return { schemaVersion, size: statSync(file).size };
  } finally {
    candidate.close();
  }
}

export function writeParsedBackup(input: Uint8Array, destination: string): BackupMetadata {
  const parsed = parsePortableBackup(input);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, parsed.database, { flag: 'wx' });
  try {
    validateBackupDatabase(destination);
    return parsed.metadata;
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
}
