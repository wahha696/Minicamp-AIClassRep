// 按账号分库（四问题修复 #1）核心流程冒烟验证（vitest 跑不了的受限环境下用 Node 直跑）。
// 覆盖：切号隔离 / 幂等 / 非法 uin / 登出回兜底 / 账号管理 / 旧库迁移 / initAccounts 挂载。
// 用法：cd apps/server && node --experimental-strip-types --import ./verify/hooks.mjs verify/verify-accounts.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
} from '../src/accounts.ts';
import { db } from '../src/db/index.ts';

let pass = 0;
function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ FAIL: ${name}`);
    process.exitCode = 1;
  }
}

const tempDirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'classrep-verify-'));
  tempDirs.push(dir);
  return dir;
}

// ============ 1. 切号隔离（验收清单第一条） ============
console.log('1) 切号 → 数据隔离 → 切回');
{
  const root = mkdtempSync(join(tmpdir(), 'classrep-verify-'));
  tempDirs.push(root);
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));

  await switchAccount('10001');
  insertMessage('a-1');
  ok(countMessages() === 1, '账号 A 写入 1 条');
  ok(currentAccount() === '10001');

  await switchAccount('10002');
  ok(currentAccount() === '10002' && countMessages() === 0, '换号登录后看不到账号 A 的任何数据');

  await switchAccount('10001');
  ok(countMessages() === 1, '切回账号 A，数据完整');

  // 幂等 + 非法 uin
  const before = countMessages();
  await switchAccount('10001');
  ok(countMessages() === before, '同账号重复 lifecycle 幂等');
  await switchAccount('../etc/passwd');
  ok(currentAccount() === '10001' && !isValidUin('../etc'), '路径穿越 uin 被拒绝');
  ok(isAccountSwitching() === false, '切库窗口结束');
}

// ============ 2. 登出 ============
{
  await closeCurrentAccount();
  ok(currentAccount() === null && db.isOpen, '登出 → 兜底库，连接可用');
  ok(existsSync(accountDbPath('10001')), '登出后账号库文件保留（数据不出本机）');
  await closeCurrentAccount();
  ok(true, '重复登出幂等');
}

// ============ 3. 账号管理 ============
{
  await switchAccount('10003');
  const list = listAccounts();
  ok(list.map((a) => a.uin).sort().join(',') === '10001,10002,10003', 'listAccounts 列出全部账号库');
  ok(list.find((a) => a.current)?.uin === '10003', '标记当前账号');
  await closeCurrentAccount();
  ok(await deleteAccountData('10003'), '删除账号数据');
  ok(!existsSync(accountDbPath('10003')), '账号目录已删除');
  ok(!(await deleteAccountData('../../etc')), '目录穿越删除被拒绝');
  ok(legacyDataExists() === false, '无 legacy 旧库');
}

// ============ 4. 旧单库迁移 ============
console.log('旧单库迁移（升级无感）');
{
  const root = tmpRoot();
  const dataDir = join(root, 'data');
  makeLegacyDb(dataDir);
  writeFileSync(join(dataDir, 'settings.json'), `${JSON.stringify({ uin: '10088' })}\n`, 'utf8');
  const r = migrateLegacyDb({ dataDir, accountsDir: join(root, 'accounts'), settingsDir: dataDir });
  ok(r.moved === true && existsSync(join(root, 'accounts', '10088', 'classrep.db')), '有 uin → 迁进账号目录');
  ok(!existsSync(join(dataDir, 'classrep.db')), '旧位置已移走');
}
{
  const root = tmpRoot();
  const accounts = join(root, 'accounts');
  setAccountsDirForTest(accounts); // legacyDataExists 读的是模块级目录，先对齐
  makeLegacyDb(join(root, 'data'));
  const r = migrateLegacyDb({ dataDir: join(root, 'data'), accountsDir: accounts });
  ok(r.moved === true && existsSync(join(accounts, 'legacy', 'classrep.db')), '无 uin → 迁到 accounts/legacy');
  ok(legacyDataExists() === true, 'legacyDataExists 供前端提示');
}
{
  const root = tmpRoot();
  const accounts = join(root, 'accounts');
  mkdirSync(join(accounts, '10088'), { recursive: true });
  new DatabaseSync(join(accounts, '10088', 'classrep.db')).close();
  makeLegacyDb(join(root, 'data'));
  writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({ uin: '10088' })}\n`, 'utf8');
  const r = migrateLegacyDb({ dataDir: join(root, 'data'), accountsDir: accounts, settingsDir: join(root, 'data') });
  ok(r.moved === false && existsSync(join(root, 'data', 'classrep.db')), '目标账号库已存在：绝不覆盖');
}

// ============ 5. initAccounts 启动流程 ============
console.log('initAccounts（后端启动入口）');
{
  const root = mkdtempSync(join(tmpdir(), 'classrep-verify-init-'));
  tempDirs.push(root);
  await initAccounts({ dataDir: join(root, 'data-none'), accountsDir: join(root, 'accounts'), fallbackDb: join(root, 'fallback.db') });
  ok(currentAccount() === null && db.isOpen, '没登录过 → 打开兜底库');

  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({ uin: '10077' })}\n`, 'utf8');
  await initAccounts({ dataDir: join(root, 'data'), accountsDir: join(root, 'accounts'), settingsDir: join(root, 'data') });
  ok(currentAccount() === '10077', '记住的 uin → 启动直接挂该账号库');
}
{
  const root = mkdtempSync(join(tmpdir(), 'classrep-verify-up-'));
  tempDirs.push(root);
  makeLegacyDb(join(root, 'data'));
  writeFileSync(join(root, 'data', 'settings.json'), `${JSON.stringify({ uin: '10066' })}\n`, 'utf8');
  await initAccounts({ dataDir: join(root, 'data'), accountsDir: join(root, 'accounts'), settingsDir: join(root, 'data') });
  ok(currentAccount() === '10066', '旧库 + 记住的 uin → 迁移后直接挂载');
  const g = db.prepare('SELECT name FROM groups WHERE group_id = ?').get('g1') as { name: string } | undefined;
  ok(g?.name === '高数(2)班', '迁移过来的旧数据可读');
}

console.log(`\nverify-accounts：${process.exitCode ? '存在失败断言 ❌' : `全部通过 ✅（${pass} 项）`}`);
process.exit(process.exitCode ?? 0);

// ===== helpers =====
function insertMessage(id: string): void {
  db.prepare(
    'INSERT INTO messages (message_id, group_id, sender_name, text, sent_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'g1', '张老师', '周一早八高数小测', Date.now(), 'demo', Date.now());
}
function countMessages(): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n ?? 0);
}
function makeLegacyDb(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'classrep.db');
  const old = new DatabaseSync(file);
  old.exec(
    'CREATE TABLE groups (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, adapter TEXT NOT NULL, created_at INTEGER NOT NULL)',
  );
  old.prepare('INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES (?, ?, 1, ?, ?)').run('g1', '高数(2)班', 'demo', Date.now());
  old.close();
}
