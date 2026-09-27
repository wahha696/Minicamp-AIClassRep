// 「杀旧后端 → 起后端 → 轮询 /health → 开浏览器」的共享实现（问题 2）。
// dev.mjs（开发链路，带 git 更新 + watch）与 scripts/bootstrap.mjs（克隆即用链路）都走这里。
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** 后端监听的端口区间（index.ts 从 8000 起顺延到 8010） */
export const PORTS = Array.from({ length: 11 }, (_, i) => 8000 + i);

export function isWindows() {
  return process.platform === 'win32';
}

export function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...opts }).toString();
}

/** netstat 里处于 LISTENING 的 8000~8010 端口 → PID */
export function listeningPids() {
  const pids = new Map();
  let out = '';
  try {
    out = sh('netstat -ano');
  } catch {
    return pids;
  }
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    const port = Number(cols[1].split(':').pop());
    const pid = Number(cols[4]);
    if (PORTS.includes(port) && pid > 0) pids.set(pid, port);
  }
  return pids;
}

/** 只结束 node 进程，别误杀别的程序 */
export function isNodeProcess(pid) {
  try {
    return /node\.exe/i.test(sh(`tasklist /FI "PID eq ${pid}" /NH`));
  } catch {
    return false;
  }
}

/**
 * 以前开的 ClassRep 开发后端（tsx watch / 后台 tsx）。光结束占端口的子进程不够：
 * watch 父进程发现代码变了会立刻再拉起一个，把新后端挤到 8001、8002…，所以要连根结束。
 */
export function staleServerPids() {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*apps*server*tsx*src/index.ts*' } | ForEach-Object { $_.ProcessId }";
  try {
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 20_000,
    }).toString();
    return out.split(/\s+/).map(Number).filter((pid) => pid > 0);
  } catch {
    return [];
  }
}

/** 结束所有旧后端（杀不了的只打日志，不抛错）。 */
export function killOldBackends({ log = console.log } = {}) {
  if (!isWindows()) return;
  for (const pid of staleServerPids()) {
    try {
      sh(`taskkill /PID ${pid} /T /F`);
      log(`    已结束旧的后端进程（PID ${pid}）`);
    } catch {
      // 可能已经跟着父进程一起结束了
    }
  }
  for (const [pid, port] of listeningPids()) {
    if (pid === process.pid) continue;
    if (!isNodeProcess(pid)) {
      log(`    端口 ${port} 被其他程序占用（PID ${pid}），不是 ClassRep，跳过`);
      continue;
    }
    try {
      sh(`taskkill /PID ${pid} /T /F`);
      log(`    已结束占用端口 ${port} 的旧后端（PID ${pid}）`);
    } catch {
      log(`    结束 PID ${pid} 失败，可以手动在任务管理器里结束 node.exe`);
    }
  }
}

export function openBrowser(url) {
  if (!isWindows()) return;
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** 后台模式的日志：写 data/logs/background.log，返回 { log, stdio, path } */
export function openBackgroundLog(root, append) {
  const dir = join(root, 'data', 'logs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'background.log');
  const fd = openSync(path, append ? 'a' : 'w');
  return {
    path,
    fd,
    log: (msg) => writeSync(fd, `${msg}\n`),
    stdio: ['ignore', fd, fd],
  };
}

/**
 * 启动仓库布局的后端进程（不进打包布局，打包布局的 启动.bat 直接跑 dist）。
 *  - background=true：stdio 写进 bg 日志（bg 由 openBackgroundLog 提供），AUTO_EXIT=1（网页全关自动退出），windowsHide；
 *  - watch=true（前台开发）：走 pnpm --filter server dev = tsx watch；
 *  - 默认：node tsx src/index.ts 直跑（无 watch，普通启动），stdio inherit。
 */
export function startServerChild({ root, background = false, watch = false, bg = null }) {
  const serverDir = join(root, 'apps', 'server');
  const tsxCli = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  if (watch && !background) {
    // 原样保留 dev.mjs 的前台行为：pnpm --filter server dev（tsx watch）
    return { child: spawn('pnpm', ['--filter', 'server', 'dev'], { cwd: root, stdio: 'inherit', shell: true }), logFile: null };
  }

  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: serverDir,
    stdio: background && bg ? bg.stdio : 'inherit',
    windowsHide: true,
    env: background ? { ...process.env, AUTO_EXIT: '1' } : process.env,
  });
  return { child, logFile: bg?.path ?? null };
}

/** 依次探测 8000~8010，返回第一个 /health 返回 200 的端口；超时返回 null。 */
export async function findHealthyPort(timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const port of PORTS) {
      try {
        const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(800) });
        if (r.ok) return port;
      } catch {
        // 没起来，继续
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
