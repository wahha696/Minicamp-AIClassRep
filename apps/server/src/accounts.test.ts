// 四问题修复 #1 验收（任务清单 #4）：
//   切号 → 数据隔离 → 切回 → 数据还在；退出登录回兜底库；旧单库自动迁移（升级无感）；
//   账号数据管理（列出 / 删除）。全部走临时目录，不碰真实 data/。
// 注：switchAccount 只在「切库前调度器在跑」时才重新 startScheduler，测试里从不 startScheduler，
//     因此不会留下定时器影响 vitest 退出。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accountDataState,
  accountEpoch,
  accountDbPath,
  accountControlUin,
  closeCurrentAccount,
  composeAccountEpoch,
  currentAccount,
  deleteAccountData,
  deleteInactiveAccountData,
  failAccountSession,
  initAccounts,
  isAccountSwitching,
  isValidUin,
  legacyDataExists,
  listAccounts,
  logoutAccountData,
  migrateLegacyDb,
  setAccountsDirForTest,
  switchAccount,
  tryAcquireAccountMutationLease,
} from './accounts.js';
import { db } from './db/index.js';
import { isCleanupPaused } from './jobs/cleanup.js';

const tempDirs: string[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'classrep-accounts-'));
  tempDirs.push(root);
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* 已关就忽略 */
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄延迟，兜底忽略
    }
  }
});

function rootDir(): string {
  return tempDirs.at(-1)!;
}

function countMessages(): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n);
}

function insertMessage(id: string): void {
  db.prepare(
    'INSERT INTO messages (message_id, group_id, sender_name, text, sent_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'g1', '张老师', '周一早八高数小测', Date.now(), 'demo', Date.now());
}

/** 模拟旧版最小 schema 的 data/classrep.db（只有 groups 表 + 一行数据） */
function makeLegacyDb(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'classrep.db');
  const old = new DatabaseSync(file);
  old.exec(
    'CREATE TABLE groups (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, adapter TEXT NOT NULL, created_at INTEGER NOT NULL);',
  );
  old.prepare('INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)').run(
    'g1', '高数(2)班', 'demo', Date.now(),
  );
  old.close();
  return file;
}

describe('按账号分库：切号 → 隔离 → 切回（问题 1 核心验收）', () => {
  it('账号 A 写入 → 换账号 B 登录看不到 A 的任何数据 → 切回 A 数据完整', async () => {
    await switchAccount('10001');
    insertMessage('a-1');
    expect(countMessages()).toBe(1);

    await switchAccount('10002');
    expect(currentAccount()).toBe('10002');
    expect(countMessages()).toBe(0);

    await switchAccount('10001');
    expect(countMessages()).toBe(1);
  });

  it('同一账号重复切换是 no-op（WS 重连会再收 lifecycle）', async () => {
    await switchAccount('10001');
    insertMessage('a-1');
    await switchAccount('10001');
    expect(currentAccount()).toBe('10001');
    expect(countMessages()).toBe(1);
  });

  it('每个账号是独立的库文件', async () => {
    await switchAccount('10001');
    const pathA = accountDbPath('10001');
    await switchAccount('10002');
    expect(accountDbPath('10002')).not.toBe(pathA);
    expect(existsSync(pathA)).toBe(true);
  });

  it('账号 epoch 是不含 UIN 的同一性令牌', async () => {
    await switchAccount('10001');
    const epoch = accountEpoch();
    expect(epoch).toMatch(/^v2:[0-9a-f-]{36}:\d+:\d+$/);
    expect(epoch).not.toContain('10001');
    expect(composeAccountEpoch('process-a', 1, 0)).not.toBe(composeAccountEpoch('process-b', 1, 0));
  });

  it('非合法 uin（含路径穿越）拒绝挂载，保持当前账号', async () => {
    await switchAccount('10001');
    await switchAccount('../evil');
    await switchAccount('1234'); // 少于 5 位
    expect(currentAccount()).toBe('10001');
    expect(isValidUin('12345')).toBe(true);
    expect(isValidUin('123456789012345')).toBe(false);
  });

  it('isAccountSwitching 平时为 false', async () => {
    expect(isAccountSwitching()).toBe(false);
    await switchAccount('10001');
    expect(isAccountSwitching()).toBe(false);
  });

  it('切号排队后拒绝新写 lease，并等待已经开始的写请求释放', async () => {
    await switchAccount('10001');
    const oldEpoch = accountEpoch();
    const lease = tryAcquireAccountMutationLease(oldEpoch);
    expect(lease).not.toBeNull();

    let switched = false;
    const switching = switchAccount('10002').then(() => {
      switched = true;
    });
    // transition 排队时同步关闸，但必须等旧请求的 lease 释放后才能真正换库。
    expect(isAccountSwitching()).toBe(true);
    expect(tryAcquireAccountMutationLease(oldEpoch)).toBeNull();
    await Promise.resolve();
    expect(switched).toBe(false);
    expect(currentAccount()).toBe('10001');

    lease!.release();
    await switching;
    expect(currentAccount()).toBe('10002');
    expect(accountEpoch()).not.toBe(oldEpoch);
    expect(tryAcquireAccountMutationLease(oldEpoch)).toBeNull();
  });

  it('A→B 与紧随其后的 B→A 串行执行，后一个不会被旧的 no-op 判断吞掉', async () => {
    await switchAccount('10001');
    const toB = switchAccount('10002');
    const backToA = switchAccount('10001');
    await Promise.all([toB, backToA]);
    expect(currentAccount()).toBe('10001');
    expect(isAccountSwitching()).toBe(false);
  });

  it('目标账号库损坏导致挂载失败时保留旧句柄但对外拒绝访问，修复后可安全恢复', async () => {
    await switchAccount('10001');
    insertMessage('a-before-failure');
    const epochA = accountEpoch();
    mkdirSync(join(rootDir(), 'accounts', '10002'), { recursive: true });
    writeFileSync(accountDbPath('10002'), 'this is not a sqlite database');

    await expect(switchAccount('10002')).rejects.toThrow();

    expect(currentAccount()).toBe('10001');
    expect(accountDataState()).toBe('error');
    expect(accountEpoch()).not.toBe(epochA);
    expect(countMessages()).toBe(1);
    expect(tryAcquireAccountMutationLease(epochA)).toBeNull();
    expect(isCleanupPaused()).toBe(true);

    rmSync(accountDbPath('10002'), { force: true });
    await switchAccount('10002');
    expect(accountDataState()).toBe('ready');
    expect(isCleanupPaused()).toBe(false);
    expect(currentAccount()).toBe('10002');
    expect(countMessages()).toBe(0);
    await switchAccount('10001');
    expect(countMessages()).toBe(1);
  });
});

describe('退出登录：closeCurrentAccount', () => {
  it('回到兜底库，账号库文件原样保留', async () => {
    await switchAccount('10001');
    insertMessage('m-keep');
    await closeCurrentAccount();
    expect(currentAccount()).toBeNull();
    expect(db.isOpen).toBe(true);
    expect(existsSync(accountDbPath('10001'))).toBe(true);
  });

  it('未登录时重复调用是幂等的', async () => {
    await closeCurrentAccount();
    await closeCurrentAccount();
    expect(currentAccount()).toBeNull();
  });

  it('冻结账号快照后同步关闸并停止采集，旧页面不能退出后来登录的账号', async () => {
    await switchAccount('10001');
    const epochA = accountEpoch();
    const lease = tryAcquireAccountMutationLease(epochA)!;
    let stopped = false;
    let cleared = false;
    const logout = logoutAccountData({
      expectedEpoch: epochA,
      expectedUin: '10001',
      sessionUin: '10001',
      erase: false,
      onAccepted: () => { stopped = true; },
      clearSession: () => { cleared = true; },
    });
    expect(stopped).toBe(true);
    expect(isAccountSwitching()).toBe(true);
    expect(cleared).toBe(false);
    lease.release();
    await expect(logout).resolves.toBe('logged_out');
    expect(cleared).toBe(true);

    await switchAccount('10002');
    await expect(logoutAccountData({
      expectedEpoch: epochA,
      expectedUin: '10001',
      sessionUin: '10002',
      erase: true,
      onAccepted: () => { throw new Error('不应执行'); },
      clearSession: () => { throw new Error('不应执行'); },
    })).resolves.toBe('stale');
    expect(currentAccount()).toBe('10002');
  });

  it('清除会话失败保持 fail closed，并可用新 epoch 安全重试', async () => {
    await switchAccount('10001');
    let fail = true;
    const attempt = (epoch: string) => logoutAccountData({
      expectedEpoch: epoch,
      expectedUin: '10001',
      sessionUin: '10001',
      erase: false,
      onAccepted: () => undefined,
      clearSession: () => {
        if (fail) throw new Error('settings locked');
      },
    });
    await expect(attempt(accountEpoch())).rejects.toThrow('settings locked');
    expect(accountDataState()).toBe('error');
    expect(accountControlUin()).toBe('10001');
    fail = false;
    await expect(attempt(accountEpoch())).resolves.toBe('logged_out');
    expect(accountDataState()).toBe('ready');
    expect(currentAccount()).toBeNull();
  });

  it('身份保存与兜底库同时失败时，不得把旧账号误当成可擦除目标', async () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-identity-failure-'));
    tempDirs.push(root);
    const blocker = join(root, 'blocked-parent');
    writeFileSync(blocker, 'not a directory');
    setAccountsDirForTest(join(root, 'accounts'), join(blocker, 'fallback.db'));
    await switchAccount('10001');

    await expect(failAccountSession(null)).rejects.toThrow();
    expect(accountDataState()).toBe('error');
    expect(accountControlUin()).toBeNull();
    await expect(logoutAccountData({
      expectedEpoch: accountEpoch(),
      expectedUin: '10001',
      sessionUin: '10001',
      erase: true,
      onAccepted: () => undefined,
      clearSession: () => undefined,
    })).resolves.toBe('stale');
    expect(existsSync(accountDbPath('10001'))).toBe(true);
  });
});

describe('账号数据管理', () => {
  it('listAccounts 列出本机账号库并标记当前账号', async () => {
    await switchAccount('10001');
    await switchAccount('10002');
    const list = listAccounts();
    expect(list.map((a) => a.uin).sort()).toEqual(['10001', '10002']);
    expect(list.find((a) => a.uin === '10002')?.current).toBe(true);
    expect(list.every((a) => a.size_bytes >= 0)).toBe(true);
  });

  it('删除非当前账号 → 目录整个消失；再删返回 false', async () => {
    await switchAccount('10001');
    await switchAccount('10002');
    expect(await deleteAccountData('10001')).toBe(true);
    expect(existsSync(accountDbPath('10001'))).toBe(false);
    expect(await deleteAccountData('10001')).toBe(false);
  });

  it('账号管理 API 不能删当前挂载账号，不会切到兜底库', async () => {
    await switchAccount('10003');
    const beforeEpoch = accountEpoch();
    expect(await deleteInactiveAccountData('10003')).toBe('active');
    expect(currentAccount()).toBe('10003');
    expect(accountEpoch()).toBe(beforeEpoch);
    expect(existsSync(accountDbPath('10003'))).toBe(true);
  });

  it('删除当前登录账号 → 先切回兜底库再删库', async () => {
    await switchAccount('10003');
    expect(await deleteAccountData('10003')).toBe(true);
    expect(currentAccount()).toBeNull();
    expect(existsSync(accountDbPath('10003'))).toBe(false);
  });

  it('目标账号挂库失败后执行擦除登出，先恢复 ready 兜底库再删损坏目标', async () => {
    await switchAccount('10001');
    insertMessage('a-stays-isolated');
    mkdirSync(join(rootDir(), 'accounts', '10002'), { recursive: true });
    writeFileSync(accountDbPath('10002'), 'not a sqlite database');

    await expect(switchAccount('10002')).rejects.toThrow();
    expect(currentAccount()).toBe('10001');
    expect(accountDataState()).toBe('error');
    expect(isCleanupPaused()).toBe(true);

    await expect(deleteAccountData('10002')).resolves.toBe(true);
    expect(currentAccount()).toBeNull();
    expect(accountDataState()).toBe('ready');
    expect(isCleanupPaused()).toBe(false);
    expect(existsSync(join(rootDir(), 'accounts', '10002'))).toBe(false);

    await switchAccount('10001');
    expect(countMessages()).toBe(1);
  });

  it('路径穿越一律拒绝', async () => {
    expect(await deleteAccountData('..')).toBe(false);
    expect(await deleteAccountData('10001/../10002')).toBe(false);
  });
});

describe('旧单库一次性迁移（升级无感）', () => {
  it('settings.json 记住了 uin → 迁进 accounts/<uin>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-accounts-mig-'));
    tempDirs.push(root);
    const oldDb = makeLegacyDb(join(root, 'data'));
    writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({ uin: '10088' })}\n`, 'utf8');

    const r = migrateLegacyDb({ dataDir: join(root, 'data'), accountsDir: join(root, 'accounts'), settingsDir: join(root, 'data') });
    expect(r.moved).toBe(true);
    expect(existsSync(oldDb)).toBe(false);
    expect(existsSync(join(root, 'accounts', '10088', 'classrep.db'))).toBe(true);
  });

  it('没有 uin → 迁到 accounts/legacy/，legacyDataExists 为 true', () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-accounts-legacy-'));
    tempDirs.push(root);
    makeLegacyDb(join(root, 'data'));
    const r = migrateLegacyDb({ dataDir: join(root, 'data'), accountsDir: join(root, 'accounts') });
    expect(r.moved).toBe(true);
    expect(existsSync(join(root, 'accounts', 'legacy', 'classrep.db'))).toBe(true);
    // legacyDataExists() 查的是模块级 accountsDir，先把它指到这套临时目录
    setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
    expect(legacyDataExists()).toBe(true);
  });

  it('目标账号库已存在 → 绝不覆盖，旧库原地保留', () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-accounts-keep-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'accounts', '10088'), { recursive: true });
    new DatabaseSync(join(root, 'accounts', '10088', 'classrep.db')).close();
    makeLegacyDb(join(root, 'data'));
    writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({ uin: '10088' })}\n`, 'utf8');

    const r = migrateLegacyDb({ dataDir: join(root, 'data'), accountsDir: join(root, 'accounts'), settingsDir: join(root, 'data') });
    expect(r.moved).toBe(false);
    expect(existsSync(join(root, 'data', 'classrep.db'))).toBe(true); // 原地保留，不覆盖账号库
  });

  it('没有旧库时什么都不做', () => {
    const r = migrateLegacyDb({ dataDir: join(tmpdir(), 'classrep-accounts-empty-x'), accountsDir: join(tmpdir(), 'accounts-empty-x') });
    expect(r.moved).toBe(false);
    expect(r.target).toBeNull();
  });
});

describe('initAccounts（后端启动入口）', () => {
  it('从没登录过（无 settings.json）→ 打开兜底库', async () => {
    await initAccounts({ dataDir: join(rootDir(), 'data-none'), accountsDir: join(rootDir(), 'accounts'), fallbackDb: join(rootDir(), 'fallback.db') });
    expect(currentAccount()).toBeNull();
    expect(db.isOpen).toBe(true);
  });

  it('记住的 uin → 启动直接挂该账号的库', async () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-accounts-init-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({ uin: '10077' })}\n`, 'utf8');
    await initAccounts({ dataDir: join(root, 'data'), accountsDir: join(root, 'accounts'), settingsDir: join(root, 'data') });
    expect(currentAccount()).toBe('10077');
  });

  it('记住的账号库损坏时冷启动仍进入可恢复模式，业务数据保持 fail closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-accounts-init-broken-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'accounts', '10079'), { recursive: true });
    writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({ uin: '10079' })}\n`, 'utf8');
    writeFileSync(join(root, 'accounts', '10079', 'classrep.db'), 'not a sqlite database');
    const fallback = join(root, 'fallback.db');

    await expect(initAccounts({
      dataDir: join(root, 'data'),
      accountsDir: join(root, 'accounts'),
      settingsDir: join(root, 'data'),
      fallbackDb: fallback,
    })).resolves.toBeUndefined();
    expect(currentAccount()).toBeNull();
    expect(accountDataState()).toBe('error');
    expect(isCleanupPaused()).toBe(true);
    expect(db.isOpen).toBe(true);
    expect(existsSync(fallback)).toBe(true);
    expect(tryAcquireAccountMutationLease()).toBeNull();

    // 恢复 API 可删掉损坏账号并重回安全兜底库。
    await expect(deleteAccountData('10079')).resolves.toBe(true);
    expect(accountDataState()).toBe('ready');
    expect(currentAccount()).toBeNull();
    expect(isCleanupPaused()).toBe(false);
  });

  it('旧库 + 记住的 uin → 先迁移再挂载，旧数据无感接上', async () => {
    const root = mkdtempSync(join(tmpdir(), 'classrep-accounts-up-'));
    tempDirs.push(root);
    makeLegacyDb(join(root, 'data'));
    writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({ uin: '10066' })}\n`, 'utf8');
    await initAccounts({ dataDir: join(root, 'data'), accountsDir: join(root, 'accounts'), settingsDir: join(root, 'data') });
    expect(currentAccount()).toBe('10066');
    const g = db.prepare('SELECT name FROM groups WHERE group_id = ?').get('g1') as { name: string } | undefined;
    expect(g?.name).toBe('高数(2)班'); // 迁过来的旧数据可读
  });
});
