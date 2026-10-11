// 已验证实例复用、启动新后端、核对本次 /health、打开浏览器的共享实现。
// dev.mjs（开发链路，带 git 更新 + watch）与 scripts/bootstrap.mjs（克隆即用链路）都走这里。
import { execSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

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

/** Compatibility name: only reports occupied ports; never terminates a process. */
export function killOldBackends({ log = console.log } = {}) {
  if (!isWindows()) return;
  for (const [pid, port] of listeningPids()) {
    if (pid === process.pid) continue;
    // A process name or a command-line substring does not prove ownership.
    log(`    端口 ${port} 已占用（PID ${pid}），保留现有程序，新实例将顺延端口`);
  }
}

export function openBrowser(url) {
  if (!isWindows()) return;
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * 启动仓库布局的后端进程（不进打包布局，打包布局的 启动.bat 直接跑 dist）。
 * 始终在启动窗口里前台运行、输出直接显示：关闭窗口 / Ctrl+C 即退出，关网页不影响。
 *  - watch=true（开发）：走 pnpm --filter server dev = tsx watch；
 *  - 默认：node tsx src/index.ts 直跑（无 watch，普通启动）。
 */
export function startServerChild({ root, watch = false }) {
  const serverDir = join(root, 'apps', 'server');
  const tsxCli = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const launchId = randomUUID();
  const childEnv = { ...process.env, CLASSREP_LAUNCH_ID: launchId };

  if (watch) {
    return { child: spawn('pnpm', ['--filter', 'server', 'dev'], { cwd: root, stdio: 'inherit', shell: true, env: childEnv }), launchId };
  }

  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], { cwd: serverDir, stdio: 'inherit', env: childEnv });
  return { child, launchId };
}

export function isClassrepHealth(body, expectedLaunchId) {
  return body !== null && typeof body === 'object' && body.app === 'classrep'
    && typeof body.launch_id === 'string' && body.launch_id.length > 0
    && (!expectedLaunchId || body.launch_id === expectedLaunchId)
    && (body.status === 'ok' || body.status === 'degraded');
}

export function installationId(root) {
  return createHash('sha256').update(realpathSync(root).toLowerCase()).digest('hex');
}

/** Reopening this installation reuses its verified service instead of starting another collector. */
export async function findRunningServer(root) {
  const expected = installationId(root);
  for (const port of PORTS) {
    try {
      const response = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(800) });
      if (!response.ok) continue;
      const body = await response.json();
      if (isClassrepHealth(body) && body.installation_id === expected) return port;
    } catch { /* Unknown/legacy instances remain untouched. */ }
  }
  return null;
}

/** 依次探测 8000~8010，核对产品及本次启动身份；超时返回 null。 */
export async function findHealthyPort(timeoutMs = 60_000, expectedLaunchId) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const port of PORTS) {
      try {
        const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(800) });
        if (r.ok && isClassrepHealth(await r.json(), expectedLaunchId)) return port;
      } catch {
        // 没起来，继续
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
