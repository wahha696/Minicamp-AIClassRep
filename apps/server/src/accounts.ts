// 按账号分库（四问题修复 #1）：本项目里的「账号」= 采集端登录的 QQ 号 uin。
// 一个账号一个 SQLite 库：data/accounts/<uin>/classrep.db。换号 = 换库文件，天然物理隔离：
// 换号登录看不到旧账号任何数据，切回旧号数据完整，删目录即删账号，备份 = 拷目录。
// 挂载点：onebot.ts 的 lifecycle（登录成功的唯一信号）拿到 self_id 后调 switchAccount(uin)；
// 登出（napcat/index.ts 的 logoutNapcat）先 closeCurrentAccount() 回到「无账号」兜底库。
//
// 并发安全：切库前必须「静默流水线」——停调度器、等在途提取批次结束、暂停清理任务，
// 否则半截批次会把旧账号的消息写进新账号的库。切库期间新到的消息由 onebot.ts 攒着，
// 切完按序入库（攒不下就丢，历史补齐会兜回来）。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILE, db, notifyAccountSwitch, openDb } from './db/index.js';
import { pauseCleanup, resumeCleanup } from './jobs/cleanup.js';
import { getUin } from './napcat/manager.js';
import { ACCOUNTS_DIR, DATA_DIR } from './paths.js';
import { quiesceScheduler, startScheduler } from './pipeline/scheduler.js';

/** 未登录时的「无账号」兜底库：就是旧版的 data/classrep.db（演示模式数据落这里）。 */
export const FALLBACK_DB = DB_FILE;
/** 拿不到 uin 的旧库迁到这里，前端提示一次 */
export const LEGACY_UIN = 'legacy';
/** classrep.db 的伴生文件（WAL） */
const DB_SIDECARS = ['', '-wal', '-shm'] as const;

let current: string | null = null;
let accountsDir = ACCOUNTS_DIR;
let fallbackDb = FALLBACK_DB;
let switching = false;

/** 测试用：把账号库目录（和未登录兜底库路径）换到临时目录，不影响真实 data/ */
export function setAccountsDirForTest(dir: string, fallbackDb?: string): void {
  accountsDir = dir;
  if (fallbackDb !== undefined) fallbackDb = fallbackDb;
  current = null;
}

/** 当前挂载的账号；未登录（兜底库）为 null */
export function currentAccount(): string | null {
  return current;
}

/** 正在切库（true 期间 onebot 会把新消息先攒着，切完按序入库） */
export function isAccountSwitching(): boolean {
  return switching;
}

/** QQ 号只能是 5~12 位数字——它要拼进库目录路径，必须挡住目录穿越 */
export function isValidUin(uin: string): boolean {
  return /^\d{5,12}$/.test(uin);
}

export function accountDbPath(uin: string): string {
  return join(accountsDir, uin, 'classrep.db');
}

/**
 * 挂载某账号的库（幂等）。停调度器 → 等在途批次 → openDb（幂等建表 + migrate）→ 恢复调度。
 * 同一账号重复调用（WS 重连会再收 lifecycle）直接返回。
 */
export async function switchAccount(uin: string): Promise<void> {
  if (current === uin && db?.isOpen) return;
  if (!isValidUin(uin)) {
    console.warn(`[accounts] ${uin} 不是合法 QQ 号，忽略切库`);
    return;
  }
  switching = true;
  pauseCleanup();
  try {
    const wasRunning = await quiesceScheduler(); // 停定时器 + 等在途批次（见 scheduler.ts）
    try {
      openDb(accountDbPath(uin)); // 幂等建表 + migrate；ESM 活绑定让所有 import { db } 跟随切换
      current = uin;
      notifyAccountSwitch(uin); // 通知各模块清账号相关的内存缓存（群名、Jev 分数、历史补齐时点…）
      console.log(`[accounts] 已挂载账号 ${uin} 的库（${accountDbPath(uin)}）`);
    } finally {
      if (wasRunning) startScheduler();
    }
  } finally {
    resumeCleanup();
    switching = false;
  }
}

/**
 * 退出登录用：静默流水线后关掉当前账号库，切回「无账号」兜底库。
 * 账号数据完整保留在 data/accounts/<uin>/，换号登录互不可见。
 */
/**
 * 退出登录用：静默流水线后关掉当前账号库，切回「无账号」兜底库。
 * 账号数据完整保留在 data/accounts/<uin>/，换号登录互不可见。
 */
export async function closeCurrentAccount(): Promise<void> {
  if (current === null && !db?.isOpen) return;
  switching = true;
  pauseCleanup();
  try {
    const wasRunning = await quiesceScheduler();
    try {
      openDb(fallbackDb);
      current = null;
      notifyAccountSwitch(null);
    } finally {
      if (wasRunning) startScheduler();
    }
  } finally {
    resumeCleanup();
    switching = false;
  }
}

export interface AccountInfo {
  uin: string;
  current: boolean;
  size_bytes: number;
  updated_at: number;
}

/** 本机已有的账号库，按最近使用排序（账号数据管理 API） */
export function listAccounts(): AccountInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(accountsDir);
  } catch {
    return []; // data/accounts 还没建（从没用过）
  }
  const out: AccountInfo[] = [];
  for (const uin of entries) {
    if (!isValidUin(uin)) continue;
    const dbFile = join(accountsDir, uin, 'classrep.db');
    if (!existsSync(dbFile)) continue;
    let size = 0;
    for (const suffix of DB_SIDECARS) {
      const f = dbFile + suffix;
      if (existsSync(f)) size += statSync(f).size;
    }
    out.push({ uin, current: current === uin, size_bytes: size, updated_at: statSync(dbFile).mtimeMs });
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}

/** 删除某账号的全部数据（连库一起）。删当前登录账号会先切回无账号库。 */
export async function deleteAccountData(uin: string): Promise<boolean> {
  if (!isValidUin(uin)) return false;
  const dir = join(accountsDir, uin);
  if (!existsSync(join(dir, 'classrep.db'))) return false;
  if (current === uin) await closeCurrentAccount();
  rmSync(dir, { recursive: true, force: true });
  console.log(`[accounts] 已删除账号 ${uin} 的本机数据（${dir}）`);
  return true;
}

/** data/accounts/legacy/classrep.db 是否存在（前端提示一次旧数据的新位置） */
export function legacyDataExists(): boolean {
  return existsSync(join(accountsDir, LEGACY_UIN, 'classrep.db'));
}

/**
 * 一次性迁移旧单库：旧版只有 data/classrep.db 单库，数据归属是「这台电脑」。
 * 启动时若它存在：
 *   · settings.json 记住了 uin → 移进 data/accounts/<uin>/，该账号无感接上旧数据；
 *   · 没有 uin（从没登录过，库里只有演示数据）→ 移进 data/accounts/legacy/，前端提示一次；
 *   · 目标库已存在（升级后又产生了演示数据）→ 原地保留，绝不覆盖账号库。
 */
export function migrateLegacyDb(opts?: {
  dataDir?: string;
  accountsDir?: string;
  settingsDir?: string;
}): { moved: boolean; target: string | null } {
  const srcDataDir = opts?.dataDir ?? DATA_DIR;
  const dstAccountsDir = opts?.accountsDir ?? accountsDir;
  const oldDb = join(srcDataDir, 'classrep.db');
  if (!existsSync(oldDb)) return { moved: false, target: null };
  const uin = getUin(opts?.settingsDir ?? srcDataDir) ?? null;
  const targetDir = join(dstAccountsDir, uin ?? LEGACY_UIN);
  const targetDb = join(targetDir, 'classrep.db');
  if (existsSync(targetDb)) return { moved: false, target: targetDb };
  mkdirSync(targetDir, { recursive: true });
  for (const suffix of DB_SIDECARS) {
    const src = oldDb + suffix;
    if (existsSync(src)) renameSync(src, join(targetDir, 'classrep.db' + suffix));
  }
  if (uin === null) {
    console.log('[accounts] 旧版数据库已移动到 data/accounts/legacy/（连接页会提示一次）');
  } else {
    console.log(`[accounts] 旧版数据库已迁移到账号 ${uin}`);
  }
  return { moved: true, target: targetDb };
}

/** 后端启动入口（index.ts 调，代替原来的 openDb()）：迁移旧库 → 挂记住的账号库或兜底库。
 *  参数供测试注入临时目录；生产不传（= 真实 data/ 与账号目录）。 */
export async function initAccounts(opts?: {
  dataDir?: string;
  accountsDir?: string;
  settingsDir?: string;
  fallbackDb?: string;
}): Promise<void> {
  if (opts?.accountsDir !== undefined) accountsDir = opts.accountsDir;
  if (opts?.fallbackDb !== undefined) fallbackDb = opts.fallbackDb;
  const { moved, target } = migrateLegacyDb(opts);
  if (moved && target !== null) console.log(`[accounts] 旧库已迁移 → ${target}`);
  const saved = getUin(opts?.settingsDir ?? opts?.dataDir);
  if (saved !== undefined) {
    await switchAccount(saved);
  } else {
    openDb(opts?.fallbackDb ?? fallbackDb);
  }
}
