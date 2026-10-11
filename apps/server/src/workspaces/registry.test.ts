import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceAccess } from './access.js';
import { WorkspaceRegistry } from './registry.js';

const QQ = { platform: 'qq' as const, account_id: '10001' };
const WX = { platform: 'wechat' as const, account_id: 'wxid_synthetic_A' };
let registry: WorkspaceRegistry;
const folders: string[] = [];
const opened: WorkspaceRegistry[] = [];
function file(): string {
  const folder = mkdtempSync(join(tmpdir(), 'classrep-workspace-synthetic-'));
  folders.push(folder);
  return join(folder, 'catalog.workspace-registry.sqlite3');
}
function open(path: string): WorkspaceRegistry {
  const result = new WorkspaceRegistry(path); opened.push(result); return result;
}
beforeEach(() => { registry = open(':memory:'); });
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
  for (const path of folders.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(path));
    if (!rel.startsWith('classrep-workspace-synthetic-') || rel.includes('..') || isAbsolute(rel)) {
      throw new Error('SYNTHETIC_CLEANUP_PATH');
    }
    rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

describe('空间归属与旧数据登记', () => {
  it('每个空间最多绑定一个 QQ 和一个微信，第二账号不能覆盖', () => {
    const space = registry.createForIdentity(QQ, '人工');
    registry.bindToExisting(WX, space.space_id);
    expect(() => registry.bindToExisting({ ...QQ, account_id: '10002' }, space.space_id)).toThrow('PLATFORM_ALREADY_BOUND');
    expect(() => registry.bindToExisting({ ...WX, account_id: 'wxid_synthetic_B' }, space.space_id)).toThrow('PLATFORM_ALREADY_BOUND');
    expect(registry.bindings()).toHaveLength(2);
  });
  it('自有旧格式补上单平台唯一约束，保留空间 ID 和绑定', () => {
    const path = file();
    const disk = open(path);
    const space = disk.createForIdentity(QQ, '人工');
    disk.bindToExisting(WX, space.space_id); disk.close();
    const old = new DatabaseSync(path);
    old.exec('DROP INDEX workspace_platform_once; PRAGMA user_version=1'); old.close();
    const upgraded = open(path);
    expect(upgraded.find(QQ)).toEqual(space); expect(upgraded.find(WX)).toEqual(space);
    const check = new DatabaseSync(path);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    expect(() => check.prepare('INSERT INTO workspace_bindings VALUES (?,?,?)')
      .run('qq', '10002', space.space_id)).toThrow();
    check.close();
  });
  it('旧格式含多个同平台绑定时拒绝升级，保留文件等待明确处理', () => {
    const path = file();
    const disk = open(path); const space = disk.createForIdentity(QQ, '人工'); disk.close();
    const old = new DatabaseSync(path);
    old.exec('DROP INDEX workspace_platform_once; PRAGMA user_version=1');
    old.prepare('INSERT INTO workspace_bindings VALUES (?,?,?)').run('qq', '10002', space.space_id); old.close();
    const before = readFileSync(path);
    expect(() => open(path)).toThrow('PLATFORM_BINDING_CONFLICT');
    expect(readFileSync(path)).toEqual(before);
  });
  it('未知账号只查询不创建空间，必须明确新建或绑定', () => {
    expect(registry.find(QQ)).toBeNull();
    expect(registry.list()).toEqual([]);
    const access = new WorkspaceAccess(registry);
    expect(() => access.connect(QQ)).toThrow('WORKSPACE_CHOICE_REQUIRED');
    expect(access.snapshot().space_id).toBeNull();
  });
  it('QQ 与微信明确绑定同一空间，任一身份都解析到同一目标', () => {
    const space = registry.createForIdentity(QQ, '人工空间');
    expect(registry.bindToExisting(WX, space.space_id)).toEqual(space);
    expect(registry.find(QQ)).toEqual(registry.find(WX));
    expect(registry.bindings()).toHaveLength(2);
  });
  it('不同账号空间不合并，已有绑定不可覆盖到新空间', () => {
    const first = registry.createForIdentity(QQ, 'A');
    const second = registry.createForIdentity(WX, 'B');
    expect(() => registry.bindToExisting(QQ, second.space_id)).toThrow('ALREADY_BOUND');
    expect(() => registry.createForIdentity(QQ, 'C')).toThrow('ALREADY_BOUND');
    expect(registry.find(QQ)?.space_id).toBe(first.space_id);
    expect(registry.list()).toHaveLength(2);
  });
  it('同一绑定重试幂等，返回副本不能改变归属', () => {
    const space = registry.createForIdentity(QQ, 'A');
    const result = registry.bindToExisting(QQ, space.space_id);
    result.storage_key = '../../wrong';
    expect(registry.find(QQ)).toEqual(space);
  });
  it('登记旧 QQ 时保留原目录引用，多个旧库不合并，不创建业务文件', () => {
    const folder = dirname(file());
    const roots = { accounts: join(folder, 'accounts'), spaces: join(folder, 'spaces') };
    const first = registry.registerLegacyQq(QQ.account_id, '旧 A');
    const second = registry.registerLegacyQq('10002', '旧 B');
    expect(first.space_id).not.toBe(second.space_id);
    expect(registry.businessDbPath(first.space_id, roots)).toBe(join(roots.accounts, QQ.account_id, 'classrep.db'));
    expect(registry.registerLegacyQq(QQ.account_id, '忽略重试改名')).toEqual(first);
    expect(registry.bindToExisting(WX, first.space_id)).toEqual(first);
    expect(existsSync(roots.accounts)).toBe(false);
    expect(existsSync(roots.spaces)).toBe(false);
  });
  it('新空间使用 UUID 目录，平台身份不拼进新路径', () => {
    const roots = { accounts: join(tmpdir(), 'accounts'), spaces: join(tmpdir(), 'spaces') };
    const space = registry.createForIdentity(WX, '人工');
    expect(registry.businessDbPath(space.space_id, roots)).toBe(join(roots.spaces, space.space_id, 'classrep.db'));
    expect(() => registry.businessDbPath('../../wrong', roots)).toThrow('PATH_INVALID');
  });
  it('旧 QQ 已绑定其他新空间时拒绝假装完成旧数据迁移', () => {
    const space = registry.createForIdentity(QQ, 'A');
    expect(() => registry.registerLegacyQq(QQ.account_id, '旧 A')).toThrow('LEGACY_OWNERSHIP_CONFLICT');
    expect(registry.find(QQ)).toEqual(space);
  });
  it('平台命名空间分开，账号值相同也不是相同身份', () => {
    const a = registry.createForIdentity(QQ, 'A');
    const b = registry.createForIdentity({ platform: 'wechat', account_id: QQ.account_id }, 'B');
    expect(a.space_id).not.toBe(b.space_id);
  });
  it('非法身份、空名或不存在的目标不会留下空空间', () => {
    expect(() => registry.createForIdentity({ ...QQ, account_id: '../../x' }, 'A')).toThrow('IDENTITY_INVALID');
    expect(() => registry.createForIdentity(WX, '\ud800')).toThrow('NAME_INVALID');
    expect(() => registry.createForIdentity(WX, '')).toThrow('NAME_INVALID');
    expect(() => registry.bindToExisting(WX, '10000000-0000-4000-8000-000000000000')).toThrow('NOT_FOUND');
    expect(registry.list()).toEqual([]);
  });
  it('关闭重开后空间 ID 与绑定保持不变，微信单独解析无需 QQ 会话', () => {
    const path = file();
    const disk = open(path);
    const space = disk.registerLegacyQq(QQ.account_id, '人工');
    disk.bindToExisting(WX, space.space_id);
    disk.close();
    const reopened = open(path);
    expect(reopened.find(WX)).toEqual(space);
    expect(reopened.bindings()).toHaveLength(2);
  });
  it('拒绝外来 SQLite 文件，写打开前不修改该文件', () => {
    const path = file();
    const foreign = new DatabaseSync(path);
    foreign.exec('CREATE TABLE unrelated (body TEXT); INSERT INTO unrelated VALUES (\'synthetic\')');
    foreign.close();
    const before = readFileSync(path);
    expect(() => open(path)).toThrow('REGISTRY_FORMAT');
    expect(readFileSync(path)).toEqual(before);
  });
  it('不接受默认路径、普通业务库路径或相对路径', () => {
    for (const path of ['catalog.workspace-registry.sqlite3', join(tmpdir(), 'classrep.db')]) {
      expect(() => open(path)).toThrow('EXPLICIT_REGISTRY_REQUIRED');
    }
  });
  it('锁忙拒绝新建，重开后没有半条空间或绑定', () => {
    const path = file();
    const disk = open(path);
    const busy = new DatabaseSync(path);
    busy.exec('BEGIN IMMEDIATE');
    try { expect(() => disk.createForIdentity(WX, '人工')).toThrow('WRITE_FAILED'); }
    finally { busy.exec('ROLLBACK'); busy.close(); }
    expect(disk.list()).toEqual([]);
    expect(disk.bindings()).toEqual([]);
    expect(disk.createForIdentity(WX, '人工').space_id).toBeTruthy();
  });
  it('绑定写入失败时同时回滚新空间，不留下无归属空记录', () => {
    const path = file();
    const disk = open(path);
    const fault = new DatabaseSync(path);
    fault.exec(`CREATE TRIGGER synthetic_fail BEFORE INSERT ON workspace_bindings
      BEGIN SELECT RAISE(ABORT,'synthetic binding failure'); END`);
    try {
      expect(() => disk.createForIdentity(WX, '人工')).toThrow('WRITE_FAILED');
      expect(disk.list()).toEqual([]);
      expect(disk.bindings()).toEqual([]);
    } finally { fault.exec('DROP TRIGGER synthetic_fail'); fault.close(); }
    disk.close();
    expect(open(path).find(WX)).toBeNull();
  });
});

describe('独立平台会话与空间可见性基础', () => {
  it.each([QQ, WX])('单独登录 $platform 即可选择其绑定空间', (input) => {
    const space = registry.createForIdentity(input, '人工');
    const access = new WorkspaceAccess(registry);
    access.connect(input);
    expect(access.snapshot().space_id).toBe(space.space_id);
  });
  it('退出一个平台后另一个仍可用，两端都退出后隐藏空间并保留绑定', () => {
    const space = registry.createForIdentity(QQ, '人工');
    registry.bindToExisting(WX, space.space_id);
    const access = new WorkspaceAccess(registry);
    const qqSession = access.connect(QQ);
    const wxSession = access.connect(WX);
    const before = access.snapshot();
    expect(access.logout('qq', qqSession)).toBe(true);
    expect(access.snapshot().space_id).toBe(space.space_id);
    expect(access.isCurrent(space.space_id, before.epoch)).toBe(false);
    expect(access.snapshot().sessions.map((s) => s.platform)).toEqual(['wechat']);
    access.logout('wechat', wxSession);
    expect(access.snapshot().space_id).toBeNull();
    expect(registry.find(QQ)).toEqual(space);
    access.connect(WX);
    expect(access.snapshot().space_id).toBe(space.space_id);
  });
  it('旧退出请求不能注销重连后的新会话', () => {
    registry.createForIdentity(QQ, '人工');
    const access = new WorkspaceAccess(registry);
    const old = access.connect(QQ);
    const fresh = access.connect(QQ);
    expect(access.logout('qq', old)).toBe(false);
    expect(access.snapshot().sessions[0]?.session_id).toBe(fresh);
  });
  it('不同空间登录需要先受控切换，不能让另一平台静默换到新库', () => {
    const first = registry.createForIdentity(QQ, 'A');
    registry.createForIdentity(WX, 'B');
    const access = new WorkspaceAccess(registry);
    const session = access.connect(QQ);
    expect(() => access.connect(WX)).toThrow('SWITCH_REQUIRED');
    expect(access.snapshot().space_id).toBe(first.space_id);
    access.logout('qq', session);
    access.connect(WX);
    expect(access.snapshot().space_id).not.toBe(first.space_id);
  });
  it('会话只留本进程内存，重建访问上下文不会从绑定表恢复登录', () => {
    registry.createForIdentity(WX, '人工');
    const first = new WorkspaceAccess(registry);
    first.connect(WX);
    first.snapshot().sessions[0]!.account_id = 'mutated';
    expect(first.snapshot().sessions[0]?.account_id).toBe(WX.account_id);
    expect(new WorkspaceAccess(registry).snapshot().space_id).toBeNull();
  });
});
