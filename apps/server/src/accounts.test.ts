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
  accountDbPath,
  closeCurrentAccount,
  currentAccount,
  deleteAccountData,
  initAccounts,
  isAccountSwitching,
  isValidUin,
  legacyDataExists,
  listAccounts,
  migrateLegacyDb,
  setAccountsDirForTest,
  switchAccount,
} from './accounts.js';
import { db } from './db/index.js';

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

  it('删除当前登录账号 → 先切回兜底库再删库', async () => {
    await switchAccount('10003');
    expect(await deleteAccountData('10003')).toBe(true);
    expect(currentAccount()).toBeNull();
    expect(existsSync(accountDbPath('10003'))).toBe(false);
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
