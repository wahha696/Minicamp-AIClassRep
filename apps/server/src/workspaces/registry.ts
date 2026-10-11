// Local ownership metadata. Login proof and runtime DB transitions are separate.
import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const APP_ID = 0x43525350;
const SINGLE_PLATFORM_INDEX = 'CREATE UNIQUE INDEX workspace_platform_once ON workspace_bindings(space_id,platform)';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TABLES = {
  workspaces: `CREATE TABLE workspaces (
    space_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
    storage_kind TEXT NOT NULL CHECK(storage_kind IN ('new','legacy_qq')),
    storage_key TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(storage_kind,storage_key))`,
  workspace_bindings: `CREATE TABLE workspace_bindings (
    platform TEXT NOT NULL CHECK(platform IN ('qq','wechat')),
    account_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES workspaces(space_id),
    PRIMARY KEY(platform,account_id))`,
};

export type Platform = 'qq' | 'wechat';
export interface PlatformIdentity { platform: Platform; account_id: string }
export interface Workspace {
  space_id: string;
  name: string;
  storage_kind: 'new' | 'legacy_qq';
  storage_key: string;
  created_at: number;
}
export class WorkspaceError extends Error {
  constructor(code: string) { super(code); this.name = 'WorkspaceError'; }
}

function identity(input: PlatformIdentity): void {
  if (!input || !['qq', 'wechat'].includes(input.platform) || typeof input.account_id !== 'string'
      || (input.platform === 'qq' ? !/^\d{5,12}$/.test(input.account_id)
        : !input.account_id || input.account_id.trim() !== input.account_id
          || input.account_id.includes('\0') || Buffer.byteLength(input.account_id) > 256
          || Buffer.from(input.account_id).toString('utf8') !== input.account_id)) {
    throw new WorkspaceError('WORKSPACE_IDENTITY_INVALID');
  }
}
function name(input: string): void {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')
      || Buffer.byteLength(input) > 256 || Buffer.from(input).toString('utf8') !== input) {
    throw new WorkspaceError('WORKSPACE_NAME_INVALID');
  }
}

/** Caller must verify the platform login identity; a binding is not authentication. */
export class WorkspaceRegistry {
  private readonly connection: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') {
      if (!isAbsolute(file) || file.startsWith('\\\\') || !file.endsWith('.workspace-registry.sqlite3')) {
        throw new WorkspaceError('WORKSPACE_EXPLICIT_REGISTRY_REQUIRED');
      }
      const state = lstatSync(file, { throwIfNoEntry: false });
      if (state) {
        if (!state.isFile() || state.isSymbolicLink()) {
          throw new WorkspaceError('WORKSPACE_REGISTRY_FORMAT');
        }
        // Read only the header before opening a writable SQLite handle, including recovery.
        const handle = openSync(file, 'r');
        const header = Buffer.alloc(100);
        let bytes: Buffer;
        try { bytes = header.subarray(0, readSync(handle, header, 0, 100, 0)); }
        finally { closeSync(handle); }
        if (bytes.length && (bytes.length !== 100
            || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0'
            || bytes.readUInt32BE(68) !== APP_ID || ![1, 2].includes(bytes.readUInt32BE(60)))) {
          throw new WorkspaceError('WORKSPACE_REGISTRY_FORMAT');
        }
      }
    }
    try { this.connection = new DatabaseSync(file); }
    catch { throw new WorkspaceError('WORKSPACE_REGISTRY_OPEN_FAILED'); }
    try {
      const conn = this.connection;
      conn.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY');
      const objects = conn.prepare('SELECT type,name,sql FROM sqlite_master').all();
      const version = Number(conn.prepare('PRAGMA user_version').get()?.user_version);
      if (objects.length) {
        const tables = objects.filter((o) => o.type === 'table');
        const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
        if (tables.length !== 2 || tables.some((o) => typeof o.name !== 'string'
              || !(o.name in TABLES) || typeof o.sql !== 'string'
              || normalize(o.sql) !== normalize(TABLES[o.name as keyof typeof TABLES]))
            || objects.some((o) => o.type !== 'table' && !(o.type === 'index' && o.sql === null
              && typeof o.name === 'string' && o.name.startsWith('sqlite_autoindex_'))
              && !(version === 2 && o.type === 'index' && o.name === 'workspace_platform_once'
                && typeof o.sql === 'string' && normalize(o.sql) === normalize(SINGLE_PLATFORM_INDEX)))
            || (version === 2 && !objects.some((o) => o.name === 'workspace_platform_once'))
            || conn.prepare('PRAGMA application_id').get()?.application_id !== APP_ID
            || ![1, 2].includes(version)) {
          throw new WorkspaceError('WORKSPACE_REGISTRY_FORMAT');
        }
      } else if (conn.prepare('PRAGMA application_id').get()?.application_id !== 0
          || conn.prepare('PRAGMA user_version').get()?.user_version !== 0) {
        throw new WorkspaceError('WORKSPACE_REGISTRY_FORMAT');
      }
      if (objects.length && conn.prepare(`SELECT 1 FROM workspace_bindings
        GROUP BY space_id,platform HAVING count(*)>1 LIMIT 1`).get()) {
        throw new WorkspaceError('WORKSPACE_PLATFORM_BINDING_CONFLICT');
      }
      conn.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
      if (!objects.length) this.transaction(() => {
        for (const sql of Object.values(TABLES)) conn.exec(sql);
        conn.exec(SINGLE_PLATFORM_INDEX);
        conn.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=2`);
      });
      else if (version === 1) this.transaction(() => {
        conn.exec(SINGLE_PLATFORM_INDEX);
        conn.exec('PRAGMA user_version=2');
      });
      if (conn.prepare('PRAGMA quick_check').all().some((o) => o.quick_check !== 'ok')
          || conn.prepare('PRAGMA foreign_key_check').all().length) {
        throw new WorkspaceError('WORKSPACE_REGISTRY_FORMAT');
      }
      for (const workspace of this.list()) this.validateWorkspace(workspace);
      for (const binding of this.bindings()) identity(binding);
    } catch (error) {
      this.connection.close();
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('WORKSPACE_REGISTRY_OPEN_FAILED');
    }
  }

  private transaction<T>(work: () => T): T {
    let started = false;
    try {
      this.connection.exec('BEGIN IMMEDIATE');
      started = true;
      const result = work();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      if (started && this.connection.isTransaction) this.connection.exec('ROLLBACK');
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('WORKSPACE_REGISTRY_WRITE_FAILED');
    }
  }
  private validateWorkspace(workspace: Workspace): void {
    name(workspace.name);
    if (!UUID.test(workspace.space_id) || !Number.isSafeInteger(workspace.created_at)
        || workspace.created_at < 0 || (workspace.storage_kind === 'new'
          ? workspace.storage_key !== workspace.space_id
          : workspace.storage_kind !== 'legacy_qq' || !/^\d{5,12}$/.test(workspace.storage_key))) {
      throw new WorkspaceError('WORKSPACE_REGISTRY_FORMAT');
    }
  }
  private add(input: PlatformIdentity, label: string, legacy = false): Workspace {
    const space: Workspace = { space_id: randomUUID(), name: label,
      storage_kind: legacy ? 'legacy_qq' : 'new', storage_key: '', created_at: Date.now() };
    space.storage_key = legacy ? input.account_id : space.space_id;
    this.connection.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)').run(
      space.space_id, space.name, space.storage_kind, space.storage_key, space.created_at);
    this.connection.prepare('INSERT INTO workspace_bindings VALUES (?,?,?)').run(
      input.platform, input.account_id, space.space_id);
    return space;
  }

  list(): Workspace[] {
    return this.connection.prepare('SELECT * FROM workspaces ORDER BY created_at,space_id').all() as unknown as Workspace[];
  }
  bindings(): (PlatformIdentity & { space_id: string })[] {
    return this.connection.prepare('SELECT * FROM workspace_bindings ORDER BY platform,account_id').all() as unknown as (PlatformIdentity & { space_id: string })[];
  }
  /** One local workspace owns the data; platform logins are connections within it. */
  singleton(): Workspace {
    const spaces = this.list();
    if (spaces.length > 1) throw new WorkspaceError('WORKSPACE_MIGRATION_REQUIRED');
    if (spaces[0]) return spaces[0];
    return this.transaction(() => {
      const space: Workspace = { space_id: randomUUID(), name: '我的空间', storage_kind: 'new',
        storage_key: '', created_at: Date.now() };
      space.storage_key = space.space_id;
      this.connection.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)').run(
        space.space_id, space.name, space.storage_kind, space.storage_key, space.created_at);
      return space;
    });
  }
  connectToSingleton(input: PlatformIdentity): Workspace {
    identity(input);
    const space = this.singleton();
    return this.transaction(() => {
      this.connection.prepare('DELETE FROM workspace_bindings WHERE platform=?').run(input.platform);
      this.connection.prepare('INSERT INTO workspace_bindings VALUES (?,?,?)').run(input.platform, input.account_id, space.space_id);
      return space;
    });
  }
  rename(spaceId: string, label: string): Workspace {
    name(label);
    if (!this.get(spaceId)) throw new WorkspaceError('WORKSPACE_NOT_FOUND');
    return this.transaction(() => {
      this.connection.prepare('UPDATE workspaces SET name=? WHERE space_id=?').run(label.trim(), spaceId);
      return this.get(spaceId)!;
    });
  }
  consolidate(targetId: string): void {
    if (!this.get(targetId)) throw new WorkspaceError('WORKSPACE_NOT_FOUND');
    this.transaction(() => {
      for (const platform of ['qq', 'wechat']) {
        const bindings = this.bindings().filter(b => b.platform === platform);
        if (bindings.length > 1) throw new WorkspaceError('WORKSPACE_PLATFORM_BINDING_CONFLICT');
      }
      this.connection.prepare('UPDATE workspace_bindings SET space_id=?').run(targetId);
      this.connection.prepare('DELETE FROM workspaces WHERE space_id<>?').run(targetId);
      this.connection.prepare('UPDATE workspaces SET name=? WHERE space_id=?').run('我的空间', targetId);
    });
  }
  get(spaceId: string): Workspace | null {
    if (!UUID.test(spaceId)) throw new WorkspaceError('WORKSPACE_NOT_FOUND');
    const result = this.connection.prepare('SELECT * FROM workspaces WHERE space_id=?').get(spaceId) as unknown as Workspace | undefined;
    if (result) this.validateWorkspace(result);
    return result ?? null;
  }
  find(input: PlatformIdentity): Workspace | null {
    identity(input);
    const result = (this.connection.prepare(`SELECT w.* FROM workspaces w JOIN workspace_bindings b
      ON w.space_id=b.space_id WHERE b.platform=? AND b.account_id=?`)
      .get(input.platform, input.account_id) as unknown as Workspace | undefined) ?? null;
    if (result) this.validateWorkspace(result);
    return result;
  }
  /** No automatic create-or-bind: UI must obtain an explicit choice for an unknown identity. */
  createForIdentity(input: PlatformIdentity, label: string): Workspace {
    identity(input); name(label);
    return this.transaction(() => {
      if (this.find(input)) throw new WorkspaceError('WORKSPACE_IDENTITY_ALREADY_BOUND');
      return this.add(input, label);
    });
  }
  bindToExisting(input: PlatformIdentity, spaceId: string): Workspace {
    identity(input);
    if (!UUID.test(spaceId)) throw new WorkspaceError('WORKSPACE_NOT_FOUND');
    return this.transaction(() => {
      const existing = this.find(input);
      if (existing) {
        if (existing.space_id !== spaceId) throw new WorkspaceError('WORKSPACE_IDENTITY_ALREADY_BOUND');
        return existing;
      }
      const target = this.connection.prepare('SELECT * FROM workspaces WHERE space_id=?').get(spaceId) as unknown as Workspace | undefined;
      if (!target) throw new WorkspaceError('WORKSPACE_NOT_FOUND');
      this.validateWorkspace(target);
      if (this.connection.prepare('SELECT 1 FROM workspace_bindings WHERE space_id=? AND platform=?')
        .get(spaceId, input.platform)) throw new WorkspaceError('WORKSPACE_PLATFORM_ALREADY_BOUND');
      this.connection.prepare('INSERT INTO workspace_bindings VALUES (?,?,?)').run(input.platform, input.account_id, spaceId);
      return target;
    });
  }
  /** Registers original QQ ownership only. Never opens, copies, moves or merges its business DB. */
  registerLegacyQq(uin: string, label: string): Workspace {
    const input: PlatformIdentity = { platform: 'qq', account_id: uin };
    identity(input); name(label);
    return this.transaction(() => {
      const existing = this.find(input);
      if (existing) {
        if (existing.storage_kind !== 'legacy_qq' || existing.storage_key !== uin) {
          throw new WorkspaceError('WORKSPACE_LEGACY_OWNERSHIP_CONFLICT');
        }
        return existing;
      }
      return this.add(input, label, true);
    });
  }
  businessDbPath(spaceId: string, roots: { spaces: string; accounts: string }): string {
    if (!UUID.test(spaceId) || !isAbsolute(roots.spaces) || !isAbsolute(roots.accounts)) {
      throw new WorkspaceError('WORKSPACE_PATH_INVALID');
    }
    const space = this.connection.prepare('SELECT * FROM workspaces WHERE space_id=?').get(spaceId) as unknown as Workspace | undefined;
    if (!space) throw new WorkspaceError('WORKSPACE_NOT_FOUND');
    this.validateWorkspace(space);
    return join(space.storage_kind === 'legacy_qq' ? roots.accounts : roots.spaces, space.storage_key, 'classrep.db');
  }
  close(): void { if (this.connection.isOpen) this.connection.close(); }
  backup(path: string): void { this.connection.prepare('VACUUM INTO ?').run(path); }
}
