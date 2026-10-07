// 采集端进程管理：冲突检测 / spawn / 监控 / 自动重启 / kill 进程树。
// 主人是 A（分工 A3）。依据：架构.md §3 第 3~7 步、§4 状态机；NapCat接口规格.md §1。
// 崩溃计数、spawn 参数等与 A1 实测跑通的 scripts/probe-napcat.mjs 保持一致。
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, NAPCAT_DIR } from '../paths.js';
import { redactSensitive } from '../redact.js';
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

/** 忘掉记住的 QQ 号（退出登录用）：下次 spawn 不带 -q，采集端就会出二维码 */
export function clearUin(settingsDir: string = DATA_DIR): void {
  rmSync(join(settingsDir, 'settings.json'), { force: true });
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
  /** napcat/ 缺少必需文件（克隆不完整等）→ state error「采集组件缺失」，不写配置不 spawn */
  napcatMissing: boolean;
}

const facts: ManagerFacts = {
  qqExe: null,
  pid: null,
  conflictAtBoot: false,
  spawnFailed: false,
  crashLoop: false,
  recentExits: 0,
  napcatMissing: false,
};

/** 采集端必需的文件（修复计划 3.1）：缺任一个就不能 spawn */
export const NAPCAT_REQUIRED = ['NapCatWinBootMain.exe', 'NapCatWinBootHook.dll', 'napcat.mjs', 'qqnt.json'];

export function napcatInstalled(dir: string = NAPCAT_DIR): boolean {
  return NAPCAT_REQUIRED.every((f) => existsSync(join(dir, f)));
}

let child: ChildProcess | null = null;
let respawnTimer: NodeJS.Timeout | null = null;
let exitTimes: number[] = [];
/** 主动 kill 过的进程退出不算崩溃（stopNapcat / killTree / bot_offline 都算主动） */
let killedByUs = true;

const LOG_CAP_BYTES = 10 * 1024 * 1024;

/** 每次 spawn 前检查一次：超过 10MB 就清空（排错只需要最近的日志） */
function capLog(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size > LOG_CAP_BYTES) writeFileSync(path, '');
  } catch {
    // 忽略
  }
}

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
      { encoding: 'utf8', timeout: 8_000, windowsHide: true });
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
  // 还有旧进程就先结束，绝不留两个 NapCat 抢 3001 和 QQ 单实例锁
  if (child !== null) killTree();
  if (!napcatInstalled()) {
    facts.napcatMissing = true;
    facts.pid = null;
    return;
  }
  facts.napcatMissing = false;
  try {
    rmSync(QRCODE_PATH, { force: true });
  } catch {
    // 没有旧码就算了
  }
  const qqExe = findQQExe();
  if (qqExe === null) {
    facts.qqExe = null;
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
    try { appendFileSync(logPath, `[manager] spawn 失败：${redactSensitive(err)}\n`); } catch { /* 忽略 */ }
    return;
  }
  child = c;
  killedByUs = false;
  facts.spawnFailed = false;
  facts.pid = c.pid ?? null;

  // 修复计划 D4：napcat.log 超过上限就截断重写，不再无限增长
  capLog(logPath);
  // Node 的 data chunk 会在任意字节位置切开；逐 chunk 脱敏可能把一枚 token 分成两半而漏掉。
  // 按行缓冲，超长无换行输出也至少保留末尾 1 KiB 与下一块拼接后再判断。
  const pending = { stdout: '', stderr: '' };
  const appendChunk = (stream: keyof typeof pending, chunk: Buffer): void => {
    pending[stream] += chunk.toString('utf8');
    const newline = pending[stream].lastIndexOf('\n');
    if (newline >= 0) {
      try { appendFileSync(logPath, redactSensitive(pending[stream].slice(0, newline + 1))); } catch { /* 排错日志写不进就算了 */ }
      pending[stream] = pending[stream].slice(newline + 1);
    }
    if (pending[stream].length > 16 * 1024) {
      const cut = pending[stream].length - 1024;
      try { appendFileSync(logPath, redactSensitive(pending[stream].slice(0, cut))); } catch { /* 同上 */ }
      pending[stream] = pending[stream].slice(cut);
    }
  };
  const flushPending = (): void => {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (pending[stream] === '') continue;
      try { appendFileSync(logPath, redactSensitive(pending[stream])); } catch { /* 同上 */ }
      pending[stream] = '';
    }
  };
  c.stdout?.on('data', (d: Buffer) => {
    appendChunk('stdout', d);
  });
  c.stderr?.on('data', (d: Buffer) => {
    appendChunk('stderr', d);
  });

  // 监控退出（架构.md §4）：非主动 kill → 1s 后自动重新 spawn（带 -q）；
  // 60s 内退出 ≥3 次 → crashLoop，不再自动重启。
  c.on('exit', () => {
    flushPending();
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
  c.on('error', (err) => {
    flushPending();
    if (child !== c) return;
    // 修复计划 B2：不清 child 的话之后 killTree 拿不到 pid 就跳过，child 永远挂着旧对象
    child = null;
    killedByUs = true;
    facts.spawnFailed = true;
    facts.pid = null;
    try { appendFileSync(logPath, `[manager] 进程错误：${redactSensitive(err)}\n`); } catch { /* 忽略 */ }
  });
}

/**
 * 用户点「关闭电脑版 QQ 并继续 / 重新连接 / 重启采集端」（架构.md §5 POST /api/connect/restart）：
 * killTree → 等 1.5s 让进程树退干净 → taskkill /F /IM QQ.exe（忽略失败）→ 清零崩溃计数 → spawn。
 */
let restarting: Promise<void> | null = null;

/**
 * 修复计划 B1：并发的 restart / logout 复用同一个进行中的 Promise，
 * 否则两边都会 spawn，第一个 NapCat/QQ 变成孤儿，之后谁也杀不掉。
 *
 * 修复计划 S4：只有启动时撞上用户自己开着的电脑版 QQ（conflictAtBoot），
 * 且用户在页面上点了「关闭电脑版 QQ 并继续」（killUserQQ=true）才 taskkill QQ.exe；
 * 普通的「重新连接 / 重启采集端 / 退出登录」只结束我们自己拉起的进程树。
 */
export function restart(opts: { killUserQQ?: boolean } = {}): Promise<void> {
  if (!IS_WINDOWS) return Promise.resolve();
  if (restarting) return restarting;
  restarting = (async () => {
    try {
      const killUserQQ = opts.killUserQQ === true && facts.conflictAtBoot;
      killTree();
      await new Promise((r) => setTimeout(r, 1500));
      if (killUserQQ) {
        try {
          spawnSync('taskkill', ['/F', '/IM', 'QQ.exe'], { stdio: 'ignore', timeout: 10_000 });
        } catch {
          // 忽略失败（QQ 可能本来就没开）
        }
      }
      exitTimes = [];
      facts.crashLoop = false;
      facts.spawnFailed = false;
      facts.recentExits = 0;
      facts.conflictAtBoot = false;
      spawnNapcat(getUin() ?? undefined);
    } finally {
      restarting = null;
    }
  })();
  return restarting;
}

/** startNapcat 的进程侧入口（架构.md §3 第 3~4 步）：QQ 定位 → 冲突检测 → spawn */
export function startManager(): void {
  if (!IS_WINDOWS) return;
  if (!napcatInstalled()) {
    facts.napcatMissing = true;
    return;
  }
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
