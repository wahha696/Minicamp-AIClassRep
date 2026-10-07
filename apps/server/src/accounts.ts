// 按账号分库（四问题修复 #1）：本项目里的「账号」= 采集端登录的 QQ 号 uin。
// 一个账号一个 SQLite 库：data/accounts/<uin>/classrep.db。换号 = 换库文件，天然物理隔离：
// 换号登录看不到旧账号任何数据，切回旧号数据完整，删目录即删账号，备份 = 拷目录。
// 挂载点：onebot.ts 的 lifecycle（登录成功的唯一信号）拿到 self_id 后调 switchAccount(uin)；
// 登出（napcat/index.ts 的 logoutNapcat）先 closeCurrentAccount() 回到「无账号」兜底库。
//
// 并发安全：切库前必须「静默流水线」——停调度器、等在途提取批次结束、暂停清理任务，
// 否则半截批次会把旧账号的消息写进新账号的库。切库期间新到的消息由 onebot.ts 攒着，
// 切完按序入库（攒不下就丢，历史补齐会兜回来）。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DB_FILE, db, dbGeneration, notifyAccountSwitch, openDb } from './db/index.js';
import { snapshotDatabase, validateBackupDatabase } from './data-backup.js';
import { pauseCleanup, resumeCleanup } from './jobs/cleanup.js';
import { getUin } from './napcat/manager.js';
import { ACCOUNTS_DIR, DATA_DIR } from './paths.js';
import { redactSensitive } from './redact.js';

/** 未登录时的「无账号」兜底库：就是旧版的 data/classrep.db（演示模式数据落这里）。 */
export const FALLBACK_DB = DB_FILE;
/** 拿不到 uin 的旧库迁到这里，前端提示一次 */
export const LEGACY_UIN = 'legacy';
/** classrep.db 的伴生文件（WAL） */
const DB_SIDECARS = ['', '-wal', '-shm'] as const;
const AUTO_BACKUP_KEEP = 7;
const AUTO_BACKUP_CHECK_MS = 60 * 60 * 1000;

let current: string | null = null;
let accountsDir = ACCOUNTS_DIR;
let fallbackDb = FALLBACK_DB;
let switching = false;
let accessBlocked = false;
/** 最近一次挂库失败时真正尝试登录的账号；此时 current 仍是旧库，不能拿它做擦除目标。 */
let blockedAccount: string | null = null;
let accessEpoch = 0;
let schedulerResumePending = false;
let transitionTail: Promise<void> = Promise.resolve();
let queuedTransitions = 0;
let activeMutationLeases = 0;
let automaticBackupTimer: ReturnType<typeof setInterval> | null = null;
/** 防止服务重启后 generation/accessEpoch 从相同初值开始，令旧浏览器页面的 epoch 意外复活。 */
const processAccountNonce = randomUUID();
const mutationLeaseWaiters = new Set<() => void>();
const transitionIdleWaiters = new Set<() => void>();

/** 测试用：把账号库目录（和未登录兜底库路径）换到临时目录，不影响真实 data/ */
export function setAccountsDirForTest(dir: string, fallbackPath?: string): void {
  accountsDir = dir;
  if (fallbackPath !== undefined) fallbackDb = fallbackPath;
  current = null;
  accessBlocked = false;
  blockedAccount = null;
  accessEpoch++;
  schedulerResumePending = false;
  resumeCleanup();
}

/** 当前挂载的账号；未登录（兜底库）为 null */
export function currentAccount(): string | null {
  return current;
}

/** 正在切库（true 期间 onebot 会把新消息先攒着，切完按序入库） */
export function isAccountSwitching(): boolean {
  return switching;
}

export type AccountDataState = 'ready' | 'switching' | 'error';

/** 账号业务数据是否可以对当前网页公开；切库中或挂库失败时一律 fail closed。 */
export function accountDataState(): AccountDataState {
  if (switching) return 'switching';
  return accessBlocked ? 'error' : 'ready';
}

/** 等当前已排队的账号操作全部结束；OneBot 用它避免后续删除/登出操作让切库缓冲永远没人冲刷。 */
export function waitForAccountTransitions(): Promise<void> {
  if (!switching) return Promise.resolve();
  return new Promise((resolve) => transitionIdleWaiters.add(resolve));
}

/**
 * 当前账号数据的短生命周期标识。数据库每次重新挂载都会换 generation，因此即使 A→B→A，
 * 旧页面拿到的 epoch 也不会重新有效。它不是鉴权凭据，只用于拒绝跨换号的读取和迟到写请求。
 */
export function accountEpoch(): string {
  // 这只是同一性令牌，不是账号标识或鉴权凭据。不把 UIN 编进返回值，
  // 避免在 A→B 切换/挂库失败窗口向 B 的连接页暴露旧 A 的 QQ 号。
  return composeAccountEpoch(processAccountNonce, dbGeneration(), accessEpoch);
}

/** 导出纯组合函数便于验证：不同服务进程 nonce 下，相同数据库代次也绝不相等。 */
export function composeAccountEpoch(processNonce: string, generation: number, epoch: number): string {
  return `v2:${processNonce}:${generation}:${epoch}`;
}

export interface AccountMutationLease {
  readonly epoch: string;
  /** lease 发放后是否仍处于同一账号、同一数据库代次，且尚未开始切换。 */
  isCurrent(): boolean;
  /** 幂等释放；HTTP 中间件必须在 finally 中调用。 */
  release(): void;
}

/**
 * 给账号数据库读写请求使用的闸门。切号一旦排队就不再发新 lease；切号会等已发 lease 全部释放。
 * expectedEpoch 由旧页面请求头传入；不匹配或正在切号均返回 null，由路由统一返回 409。
 * 账号切换、登出、删除账号这类会主动触发 transition 的接口不能持有此 lease，避免自等死。
 */
export function tryAcquireAccountMutationLease(expectedEpoch?: string): AccountMutationLease | null {
  if (accountDataState() !== 'ready') return null;
  const epoch = accountEpoch();
  if (expectedEpoch !== undefined && expectedEpoch !== epoch) return null;
  activeMutationLeases++;
  let released = false;
  return {
    epoch,
    isCurrent: () => !released && accountDataState() === 'ready' && accountEpoch() === epoch,
    release: () => {
      if (released) return;
      released = true;
      activeMutationLeases--;
      if (activeMutationLeases === 0) {
        for (const resolve of mutationLeaseWaiters) resolve();
        mutationLeaseWaiters.clear();
      }
    },
  };
}

function waitForMutationLeases(): Promise<void> {
  if (activeMutationLeases === 0) return Promise.resolve();
  return new Promise((resolve) => mutationLeaseWaiters.add(resolve));
}

/** 所有挂库、回退兜底库和账号目录删除都从同一队列串行执行。 */
function finishAccountTransition(): void {
  queuedTransitions--;
  if (queuedTransitions === 0) {
    switching = false;
    // 挂库失败后全局 db 仍指向旧账号。HTTP、OneBot、调度器都已 fail closed，
    // 清理定时器也必须保持暂停，不能在“当前登录 B、旧 A 库仍挂着”的错误状态下改 A。
    // 后续成功 switch/close 会把 accessBlocked 清掉，并由它自己的 finally 恢复清理。
    if (!accessBlocked) resumeCleanup();
    for (const resolve of transitionIdleWaiters) resolve();
    transitionIdleWaiters.clear();
  }
}

function enqueueAccountTransition<T>(work: () => Promise<T>, onQueued?: () => void): Promise<T> {
  queuedTransitions++;
  switching = true; // 排队即关闸，不能让新写请求在等待期间插进来
  pauseCleanup();
  // 登出需要在等待旧 HTTP lease 之前就断开 OneBot。回调与上面的关闸同步执行，
  // 因而迟到 lifecycle 没有机会插到“校验账号”和“停止采集”之间。
  try {
    onQueued?.();
  } catch (error) {
    finishAccountTransition();
    return Promise.reject(error);
  }
  const result = transitionTail.then(async () => {
    await waitForMutationLeases();
    return work();
  });
  transitionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(finishAccountTransition);
}

/** QQ 号只能是 5~12 位数字——它要拼进库目录路径，必须挡住目录穿越 */
export function isValidUin(uin: string): boolean {
  return /^\d{5,12}$/.test(uin);
}

export function accountDbPath(uin: string): string {
  return join(accountsDir, uin, 'classrep.db');
}

function backupsDir(uin: string): string {
  return join(accountsDir, uin, 'backups');
}

/** 每个账号每天第一次挂载后做一致性快照，保留最近 7 份。失败只告警，不阻断登录。 */
function ensureDailyBackup(uin: string, now = Date.now()): void {
  const dir = backupsDir(uin);
  const day = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // Asia/Shanghai 日期
  const target = join(dir, `auto-${day}.db`);
  if (existsSync(target)) {
    try {
      validateBackupDatabase(target);
      return;
    } catch {
      // 上次进程中断可能留下了不完整文件；不能把“文件存在”当作备份成功。
      rmSync(target, { force: true });
    }
  }
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    mkdirSync(dir, { recursive: true });
    snapshotDatabase(temporary);
    validateBackupDatabase(temporary);
    renameSync(temporary, target);
    const autos = readdirSync(dir).filter((name) => /^auto-\d{4}-\d{2}-\d{2}\.db$/.test(name)).sort().reverse();
    for (const old of autos.slice(AUTO_BACKUP_KEEP)) rmSync(join(dir, old), { force: true });
  } catch (error) {
    rmSync(temporary, { force: true });
    console.warn(`[accounts] 自动备份失败：${redactSensitive(error)}`);
  }
}

/**
 * 立即检查今日快照。lease 保证 VACUUM INTO 期间不会切到另一个账号库。
 * 返回 false 只表示当前未登录、正在切号或处于 fail-closed 状态。
 */
export function runAutomaticBackupNow(now = Date.now()): boolean {
  const lease = tryAcquireAccountMutationLease();
  if (!lease) return false;
  try {
    const uin = current;
    if (uin === null || !lease.isCurrent()) return false;
    ensureDailyBackup(uin, now);
    return true;
  } finally {
    lease.release();
  }
}

/** 常驻运行时每小时检查一次，跨天不重启也不会漏掉自动备份。 */
export function startAutomaticBackupScheduler(): void {
  if (automaticBackupTimer !== null) return;
  automaticBackupTimer = setInterval(() => runAutomaticBackupNow(), AUTO_BACKUP_CHECK_MS);
  automaticBackupTimer.unref();
}

export interface AccountBackupStatus {
  automatic_count: number;
  latest_automatic_at: number | null;
  latest_restore_backup_at: number | null;
}

export function accountBackupStatus(): AccountBackupStatus {
  if (current === null) return { automatic_count: 0, latest_automatic_at: null, latest_restore_backup_at: null };
  let names: string[];
  const dir = backupsDir(current);
  try { names = readdirSync(dir); } catch { names = []; }
  const mtimes = (prefix: string) => names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
    .map((name) => statSync(join(dir, name)).mtimeMs)
    .sort((a, b) => b - a);
  const auto = mtimes('auto-');
  const restore = mtimes('pre-restore-');
  return {
    automatic_count: auto.length,
    latest_automatic_at: auto[0] ?? null,
    latest_restore_backup_at: restore[0] ?? null,
  };
}

/**
 * 挂载某账号的库（幂等）。停调度器 → 等在途批次 → openDb（幂等建表 + migrate）→ 恢复调度。
 * 同一账号重复调用（WS 重连会再收 lifecycle）直接返回。
 */
export function switchAccount(uin: string): Promise<void> {
  if (!isValidUin(uin)) {
    console.warn('[accounts] 收到不合法的账号标识，忽略切库');
    return Promise.resolve();
  }
  // 没有别的 transition 排队时，同号 lifecycle 才能安全地直接 no-op。
  if (queuedTransitions === 0 && current === uin && db?.isOpen && !accessBlocked) return Promise.resolve();
  return enqueueAccountTransition(async () => {
    // 必须在队列内再次判断：排队期间前一个 transition 可能已经挂到了这个账号。
    if (current === uin && db?.isOpen && !accessBlocked) return;
    // 动态 import 断开 accounts → scheduler → extract → preferences → accounts 的加载环；
    // 否则测试 mock 与生产启动都可能在模块尚未初始化完时拿到半成品绑定。
    const { quiesceScheduler, resumeScheduler } = await import('./pipeline/scheduler.js');
    const wasRunning = await quiesceScheduler(); // 停定时器 + 等在途批次（见 scheduler.ts）
    const shouldResume = wasRunning || schedulerResumePending;
    try {
      openDb(accountDbPath(uin)); // 幂等建表 + migrate；ESM 活绑定让所有 import { db } 跟随切换
      current = uin;
      accessBlocked = false;
      blockedAccount = null;
      schedulerResumePending = false;
      notifyAccountSwitch(uin); // 通知各模块清账号相关的内存缓存（群名、Jev 分数、历史补齐时点…）
      ensureDailyBackup(uin);
      console.log('[accounts] 已挂载当前登录账号的数据库');
      resumeScheduler(shouldResume);
    } catch (error) {
      // openDb 原子保留旧连接，但 selfId/登录会话已经可能变成目标账号；旧数据不得再经 API 暴露。
      accessBlocked = true;
      blockedAccount = uin;
      accessEpoch++;
      schedulerResumePending = shouldResume;
      throw error;
    }
  });
}

export type RestoreAccountBackupResult =
  | { status: 'restored'; safetyBackup: string }
  | { status: 'stale' };

/**
 * 用已验证的 SQLite 候选文件替换当前账号库。调用方必须把候选放在当前账号目录内，保证改名原子。
 * 切换前 checkpoint + 关闭句柄；原库永久保留为 pre-restore 快照。任何失败都恢复原库并重新挂载。
 */
export function restoreCurrentAccountBackup(expectedEpoch: string, candidate: string): Promise<RestoreAccountBackupResult> {
  // 挂库失败时 current 可能仍指向旧 A，而 blockedAccount 才是当前登录且需修复的 B。
  // 只使用控制面权威账号，避免“修复 B”误替换 A。
  const targetUin = accountControlUin();
  if (targetUin === null || switching || accountEpoch() !== expectedEpoch) {
    return Promise.resolve({ status: 'stale' });
  }
  const accountDir = join(accountsDir, targetUin);
  const resolvedCandidate = resolve(candidate);
  if (dirname(resolvedCandidate) !== resolve(accountDir) || !existsSync(resolvedCandidate)) {
    return Promise.reject(new Error('恢复候选文件不在当前账号目录'));
  }
  validateBackupDatabase(resolvedCandidate);

  return enqueueAccountTransition<RestoreAccountBackupResult>(async () => {
    if (accountControlUin() !== targetUin || accountEpoch() !== expectedEpoch) return { status: 'stale' };
    const { quiesceScheduler, resumeScheduler } = await import('./pipeline/scheduler.js');
    const wasRunning = await quiesceScheduler();
    const shouldResume = wasRunning || schedulerResumePending;
    const database = accountDbPath(targetUin);
    const safetyDir = backupsDir(targetUin);
    mkdirSync(safetyDir, { recursive: true });
    const safety = join(safetyDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    let candidateMoved = false;
    try {
      // 正常恢复时这是目标库；挂库失败时可能是 fallback/旧账号库。
      // 只做 checkpoint+关句柄，后面的文件操作始终限定到 targetUin 目录。
      if (db?.isOpen) {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
      }
      for (const suffix of DB_SIDECARS) {
        const source = database + suffix;
        if (existsSync(source)) renameSync(source, safety + suffix);
      }
      renameSync(resolvedCandidate, database);
      candidateMoved = true;
      openDb(database); // 允许旧 schema 在恢复时走正常迁移
      current = targetUin;
      accessBlocked = false;
      blockedAccount = null;
      schedulerResumePending = false;
      notifyAccountSwitch(targetUin);
      ensureDailyBackup(targetUin);
      resumeScheduler(shouldResume);
      return { status: 'restored', safetyBackup: safety };
    } catch (error) {
      try { if (db?.isOpen) db.close(); } catch { /* 继续恢复原库 */ }
      try {
        if (candidateMoved && existsSync(database)) {
          renameSync(database, join(accountDir, `failed-restore-${Date.now()}.db`));
        }
        for (const suffix of DB_SIDECARS) {
          if (existsSync(safety + suffix)) {
            rmSync(database + suffix, { force: true });
            renameSync(safety + suffix, database + suffix);
          }
        }
        openDb(database);
        current = targetUin;
        accessBlocked = false;
        blockedAccount = null;
        schedulerResumePending = false;
        notifyAccountSwitch(targetUin);
        resumeScheduler(shouldResume);
      } catch (rollbackError) {
        accessBlocked = true;
        blockedAccount = targetUin;
        accessEpoch++;
        schedulerResumePending = shouldResume;
        throw new Error(`恢复失败且原库回滚未完成：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw error;
    }
  });
}

/**
 * 退出登录用：静默流水线后关掉当前账号库，切回「无账号」兜底库。
 * 账号数据完整保留在 data/accounts/<uin>/，换号登录互不可见。
 */
async function closeCurrentAccountNow(): Promise<void> {
  if (current === null && db?.isOpen && !accessBlocked) return;
  const { quiesceScheduler, resumeScheduler } = await import('./pipeline/scheduler.js');
  const wasRunning = await quiesceScheduler();
  const shouldResume = wasRunning || schedulerResumePending;
  try {
    openDb(fallbackDb);
    current = null;
    accessBlocked = false;
    blockedAccount = null;
    schedulerResumePending = false;
    notifyAccountSwitch(null);
    resumeScheduler(shouldResume);
  } catch (error) {
    accessBlocked = true;
    // 普通 A 登出时 fallback 打不开，A 仍是可安全重试的权威目标；若此前是 B 挂库失败，
    // blockedAccount 已是 B，不能退回仍由 current 持有句柄的旧 A。
    blockedAccount ??= current;
    accessEpoch++;
    schedulerResumePending = shouldResume;
    throw error;
  }
}

export function closeCurrentAccount(): Promise<void> {
  if (queuedTransitions === 0 && current === null && db?.isOpen && !accessBlocked) return Promise.resolve();
  return enqueueAccountTransition(closeCurrentAccountNow);
}

/**
 * 登录身份无法可靠持久化时使用：关到兜底库后仍保持 fail closed，直到用户明确退出或重连。
 * target 传 null，避免把磁盘中陈旧账号误当成当前会话的破坏性操作目标。
 */
export function failAccountSession(target: string | null = null): Promise<void> {
  return enqueueAccountTransition(async () => {
    try {
      await closeCurrentAccountNow();
    } finally {
      // close 本身失败时会暂时把旧 current 记成恢复目标；身份持久化失败的真正目标仍未知，
      // 必须覆盖它，绝不能让随后“擦除旧 A”被误认为安全。
      accessBlocked = true;
      blockedAccount = target;
      accessEpoch++;
    }
  });
}

/**
 * 当前控制面真正对应的账号。正常时是已挂载库；挂库失败时是失败目标，绝不能退回旧 current，
 * 否则“退出并删除 B”会误删仍留在 current 中的 A。
 */
export function accountControlUin(): string | null {
  return accessBlocked ? blockedAccount : current;
}

/** 控制请求的 epoch 与权威账号必须同时匹配；切库排队后立即失效。 */
export function accountControlContextMatches(expectedEpoch: string, expectedUin: string | null): boolean {
  if (switching || accountEpoch() !== expectedEpoch) return false;
  if (expectedUin !== null && !isValidUin(expectedUin)) return false;
  return accountControlUin() === expectedUin;
}

export type LogoutAccountResult = 'logged_out' | 'stale';

/**
 * 原子退出：同步核对页面快照并关写闸，立即停止采集，再等待在途请求并切回兜底库。
 * erase 的目录只取权威账号，绝不取可能写失败/陈旧的 settings.uin。
 */
export function logoutAccountData(opts: {
  expectedEpoch: string;
  expectedUin: string;
  /** settings 中本次请求看到的账号；普通退出可清掉它，擦除还必须匹配权威账号。 */
  sessionUin: string | null;
  erase: boolean;
  onAccepted: () => void;
  clearSession: () => void;
}): Promise<LogoutAccountResult> {
  const { expectedEpoch, expectedUin, sessionUin, erase, onAccepted, clearSession } = opts;
  if (!isValidUin(expectedUin) || switching || accountEpoch() !== expectedEpoch || sessionUin !== expectedUin) {
    return Promise.resolve('stale');
  }
  // 非破坏性退出可以清理一个仅残留在 settings 的会话；擦除必须证明目录属于当前权威账号。
  if (erase && accountControlUin() !== expectedUin) return Promise.resolve('stale');
  if (!erase && accountControlUin() !== expectedUin && accountControlUin() !== null) {
    return Promise.resolve('stale');
  }

  return enqueueAccountTransition<LogoutAccountResult>(async () => {
    await closeCurrentAccountNow();
    try {
      // 擦除先删目录、最后才清会话；任一步失败都保留可重试的账号身份，绝不误报成功。
      if (erase) {
        const dir = join(accountsDir, expectedUin);
        rmSync(dir, { recursive: true, force: true });
        console.log('[accounts] 已退出并删除当前账号的本机数据');
      }
      clearSession();
    } catch (error) {
      accessBlocked = true;
      blockedAccount = expectedUin;
      accessEpoch++;
      throw error;
    }
    return 'logged_out';
  }, onAccepted);
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
export function deleteAccountData(uin: string): Promise<boolean> {
  if (!isValidUin(uin)) return Promise.resolve(false);
  return enqueueAccountTransition(async () => {
    const dir = join(accountsDir, uin);
    const existed = existsSync(dir);
    // 登录会话可能已是 B，但 B 挂库失败时 current 仍指向旧 A。
    // 此时“退出并删除 B”也必须先挂回 fallback，否则 accessBlocked、旧 A 句柄、
    // scheduler/cleanup 的静默状态都会永久残留。一并允许清理“目录/库本身已损坏”的目标。
    if (current === uin || accessBlocked) await closeCurrentAccountNow();
    if (!existed) return false;
    rmSync(dir, { recursive: true, force: true });
    console.log('[accounts] 已删除账号的本机数据');
    return true;
  });
}

export type DeleteInactiveAccountResult = 'deleted' | 'not_found' | 'active';

/**
 * 账号管理页专用：只删除与当前 NapCat 会话无关的账号。
 * 检查和删除放在同一个 transition 内，避免路由先检查、后排队期间恰好登录该账号的竞态。
 * 内部的“退出并删除本号数据”继续调用 deleteAccountData，只有它可以删当前号。
 */
export function deleteInactiveAccountData(uin: string): Promise<DeleteInactiveAccountResult> {
  if (!isValidUin(uin)) return Promise.resolve('not_found');
  return enqueueAccountTransition(async () => {
    if (current === uin || getUin() === uin) return 'active';
    const dir = join(accountsDir, uin);
    if (!existsSync(join(dir, 'classrep.db'))) return 'not_found';
    rmSync(dir, { recursive: true, force: true });
    console.log('[accounts] 已删除非活动账号的本机数据');
    return 'deleted';
  });
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
    console.log('[accounts] 旧版数据库已迁移到当前账号');
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
  if (moved && target !== null) console.log('[accounts] 旧库迁移完成');
  const saved = getUin(opts?.settingsDir ?? opts?.dataDir);
  if (saved !== undefined) {
    try {
      await switchAccount(saved);
    } catch (error) {
      // 冷启动时保存的账号库若损坏/无权限，不能让 HTTP 服务根本起不来：
      // 用安全 fallback 提供连接页与账号删除等恢复入口，但继续 accessBlocked，
      // 所有业务数据 API/OneBot/调度均 fail closed，绝不把 fallback 当成该账号数据。
      console.error(`[accounts] 启动时无法挂载记住的账号，已进入可恢复模式：${redactSensitive(error)}`);
      current = null;
      try {
        openDb(opts?.fallbackDb ?? fallbackDb);
        notifyAccountSwitch(null);
      } catch (fallbackError) {
        // 连 fallback 也打不开时仍让服务启动；全局恢复路由不依赖业务库。
        console.error(`[accounts] 恢复用兜底库也无法挂载：${redactSensitive(fallbackError)}`);
      }
      accessBlocked = true;
      accessEpoch++;
      pauseCleanup();
    }
  } else {
    openDb(opts?.fallbackDb ?? fallbackDb);
    current = null;
    accessBlocked = false;
    schedulerResumePending = false;
  }
}
