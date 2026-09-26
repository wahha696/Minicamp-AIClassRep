// 采集端进程管理：冲突检测 / spawn / 监控 / 自动重启 / kill 进程树。
// 主人是 A（分工 A3）。依据：架构.md §3 第 3~7 步、§4 状态机；NapCat接口规格.md §1。
// 崩溃计数、spawn 参数等与 A1 实测跑通的 scripts/probe-napcat.mjs 保持一致。
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, NAPCAT_DIR } from '../paths.js';
import { findQQExe, QRCODE_PATH } from './paths.js';

export const IS_WINDOWS: boolean = process.platform === 'win32';

/** 架构.md §4：进程 60s 内退出 ≥3 次 → error，不再自动重启 */
export const CRASH_WINDOW_MS = 60_000;
export const CRASH_LIMIT = 3;

// ===== settings.json（data/settings.json，内容 { uin }；只有 A 读写，见分工 A） =====

/** 读 settings.uin；没有/损坏返回 undefined */
export function getUin(settingsDir: string = DATA_DIR): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(settingsDir, 'settings.json'), 'utf8')) as { uin?: unknown };
    return typeof raw.uin === 'string' && raw.uin !== '' ? raw.uin : undefined;
  } catch {
    return undefined;
  }
}

/** 写 settings.uin（onebot.ts 在 lifecycle 拿到 self_id 后调用） */
export function setUin(uin: string, settingsDir: string = DATA_DIR): void {
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), `${JSON.stringify({ uin }, null, 2)}\n`, 'utf8');
}

// ===== 供 state.ts（A5）读取的进程事实 =====

export interface ManagerFacts {
  /** 定位到的 QQ.exe；null = 没装 → state:error「需要先安装 QQ 电脑版」 */
  qqExe: string | null;
  /** NapCatWinBootMain.exe 的 pid；null = 当前没有进程 */
  pid: number | null;
  /** 启动时 QQ.exe 在运行，尚未 spawn → state qq_conflict，等用户点按钮 */
  conflictAtBoot: boolean;
  /** 最近一次 spawn 调用失败（ENOENT 等）→ state error */
  spawnFailed: boolean;
  /** 60s 内意外退出 ≥3 次（反复崩溃）→ 停止自动重启，state error */
  crashLoop: boolean;
  /** 当前 60s 滑动窗口内的意外退出次数 */
  recentExits: number;
}

const facts: ManagerFacts = {
  qqExe: null,
  pid: null,
  conflictAtBoot: false,
  spawnFailed: false,
  crashLoop: false,
  recentExits: 0,
};

let child: ChildProcess | null = null;
let respawnTimer: NodeJS.Timeout | null = null;
let exitTimes: number[] = [];
/** 主动 kill 过的进程退出不算崩溃（stopNapcat / killTree / bot_offline 都算主动） */
let killedByUs = true;

/** 保留 windowMs 内的时间戳（纯函数，导出便于测试） */
export function pruneRecent(stamps: number[], now: number, windowMs: number): number[] {
  return stamps.filter((t) => now - t < windowMs);
}

/**
 * spawn 参数（NapCat接口规格.md §1，与 probe 实测一致）：
 * NapCatWinBootMain.exe <QQ.exe> <NapCatWinBootHook.dll> [-q <uin>]
 */
export function buildSpawnArgs(qqExe: string, uin?: string): string[] {
  return [
    qqExe,
    join(NAPCAT_DIR, 'NapCatWinBootHook.dll'),
    ...(uin ? ['-q', uin] : []),
  ];
}

/** spawn 的 5 个 NAPCAT_* 环境变量（照抄 napcat-launcher.bat，接口规格.md §1） */
export function buildNapcatEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NAPCAT_PATCH_PACKAGE: join(NAPCAT_DIR, 'qqnt.json'),
    NAPCAT_LOAD_PATH: join(NAPCAT_DIR, 'loadNapCat.js'),
    NAPCAT_INJECT_PATH: join(NAPCAT_DIR, 'NapCatWinBootHook.dll'),
    NAPCAT_LAUNCHER_PATH: join(NAPCAT_DIR, 'NapCatWinBootMain.exe'),
    NAPCAT_MAIN_PATH: join(NAPCAT_DIR, 'napcat.mjs').replaceAll('\\', '/'),
  };
}

/**
 * 电脑版 QQ 是否「真的活着」。
 * 已知坑④（需求文档 §8）：tasklist 对提权进程报 Access denied 且列表不可见，
 * 所以优先 PowerShell Get-Process；且 0 线程的 QQ 僵尸进程对象不运行代码、不占单实例锁
 * （§10-1 实测），只统计线程数 > 0 的进程。PowerShell 本身不可用才回落 tasklist。
 */
export function isQQRunning(): boolean {
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `if (Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.Threads.Count -gt 0 }) { 'QQ_LIVE' }`],
      { encoding: 'utf8' });
    if (ps.error === undefined && ps.status === 0) {
      return (ps.stdout ?? '').includes('QQ_LIVE');
    }
  } catch {
    // PowerShell 不可用就走 tasklist
  }
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/NH'], { encoding: 'utf8' });
    return (out.stdout ?? '').includes('QQ.exe');
  } catch {
    return false;
  }
}

/** 结束 NapCat 进程树（taskkill /T /F /PID）。同步、幂等、失败不抛。 */
export function killTree(): void {
  killedByUs = true;
  if (respawnTimer !== null) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const pid = child?.pid;
  if (child !== null && pid !== undefined) {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    } catch {
      // 进程可能已自己退出；结束路径上不抛
    }
    child = null;
    facts.pid = null;
  }
}

/**
 * spawn NapCat（NapCat接口规格.md §1）。先删旧二维码；stdout/stderr 按 UTF-8 追加到
 * data/logs/napcat.log（只用于排错，状态判定不读日志）。重复调用前应先 killTree。
 */
export function spawnNapcat(uin?: string): void {
  if (!IS_WINDOWS) return;
  try {
    rmSync(QRCODE_PATH, { force: true });
  } catch {
    // 没有旧码就算了
  }
  const qqExe = findQQExe();
  if (qqExe === null) {
    facts.pid = null;
    return; // state → error「需要先安装 QQ 电脑版」
  }
  facts.qqExe = qqExe;

  mkdirSync(join(DATA_DIR, 'logs'), { recursive: true });
  const logPath = join(DATA_DIR, 'logs', 'napcat.log');

  let c: ChildProcess;
  try {
    c = spawn(
      join(NAPCAT_DIR, 'NapCatWinBootMain.exe'),
      buildSpawnArgs(qqExe, uin),
      {
        cwd: NAPCAT_DIR,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildNapcatEnv(),
      },
    );
  } catch (err) {
    // Windows 上 spawn 会同步抛错（EPERM：杀软/策略拦截、路径被占用等）。
    // 按架构.md §4 落到 spawnFailed → 页面显示错误状态；绝不能把服务器进程带崩。
    facts.spawnFailed = true;
    facts.pid = null;
    try { appendFileSync(logPath, `[manager] spawn 失败：${String(err)}\n`); } catch { /* 忽略 */ }
    return;
  }
  child = c;
  killedByUs = false;
  facts.spawnFailed = false;
  facts.pid = c.pid ?? null;

  c.stdout?.on('data', (d: Buffer) => {
    try { appendFileSync(logPath, d); } catch { /* 排错日志写不进就算了 */ }
  });
  c.stderr?.on('data', (d: Buffer) => {
    try { appendFileSync(logPath, d); } catch { /* 同上 */ }
  });

  // 监控退出（架构.md §4）：非主动 kill → 1s 后自动重新 spawn（带 -q）；
  // 60s 内退出 ≥3 次 → crashLoop，不再自动重启。
  c.on('exit', () => {
    if (child !== c) return;
    child = null;
    facts.pid = null;
    if (killedByUs) return;
    const now = Date.now();
    exitTimes = pruneRecent(exitTimes, now, CRASH_WINDOW_MS);
    exitTimes.push(now);
    facts.recentExits = exitTimes.length;
    if (exitTimes.length >= CRASH_LIMIT) {
      facts.crashLoop = true;
      return;
    }
    respawnTimer = setTimeout(() => spawnNapcat(getUin() ?? undefined), 1000);
  });
  // spawn 本身失败（ENOENT 等）→ state → error（不会误触发自动重启）
  c.on('error', () => {
    if (child !== c) return;
    facts.spawnFailed = true;
    facts.pid = null;
  });
}

/**
 * 用户点「关闭电脑版 QQ 并继续 / 重新连接 / 重启采集端」（架构.md §5 POST /api/connect/restart）：
 * killTree → 等 1.5s 让进程树退干净 → taskkill /F /IM QQ.exe（忽略失败）→ 清零崩溃计数 → spawn。
 */
export async function restart(): Promise<void> {
  if (!IS_WINDOWS) return;
  killTree();
  await new Promise((r) => setTimeout(r, 1500));
  try {
    spawnSync('taskkill', ['/F', '/IM', 'QQ.exe'], { stdio: 'ignore' });
  } catch {
    // 忽略失败（QQ 可能本来就没开）
  }
  exitTimes = [];
  facts.crashLoop = false;
  facts.conflictAtBoot = false;
  spawnNapcat(getUin() ?? undefined);
}

/** startNapcat 的进程侧入口（架构.md §3 第 3~4 步）：QQ 定位 → 冲突检测 → spawn */
export function startManager(): void {
  if (!IS_WINDOWS) return;
  const qqExe = findQQExe();
  if (qqExe === null) {
    facts.qqExe = null;
    return; // state → error「需要先安装 QQ 电脑版」
  }
  facts.qqExe = qqExe;
  if (isQQRunning()) {
    facts.conflictAtBoot = true; // 等用户点「关闭电脑版 QQ 并继续」（架构.md §4）
    return;
  }
  spawnNapcat(getUin() ?? undefined);
}

/** 供 state.ts（A5）推导连接状态用 */
export function getManagerFacts(): ManagerFacts {
  return {
    ...facts,
    recentExits: pruneRecent(exitTimes, Date.now(), CRASH_WINDOW_MS).length,
  };
}
