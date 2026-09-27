// 一键启动 / 重启（开发用；普通用户请用根目录的 启动.bat → launcher.mjs，跑的是生产构建）
//   node scripts/dev.mjs              前台模式：黑窗口里看日志，关窗口即退出（scripts\dev-start.bat）
//   node scripts/dev.mjs --background 后台模式：不显示窗口，网页全关掉后自动退出
// 步骤：0) 看看 GitHub 上有没有新版本（只提示，不自动拉——拉代码是用户主动行为）
//       1) 结束命令行里带本仓库路径的旧 node 后端（不动别的项目的 node）
//       2) 重新打包前端  3) 启动后端，轮询 8000~8010 找到实际端口后打开浏览器
// 加 --no-update 跳过第 0 步。再运行一次就是「重启」。
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = Array.from({ length: 11 }, (_, i) => 8000 + i);
const isWin = process.platform === 'win32';
const background = process.argv.includes('--background');

// 后台模式没有窗口，输出都写进日志文件，出问题时看 data/logs/background.log
let log = (msg) => console.log(msg);
let childStdio = 'inherit';
if (background) {
  const dir = join(ROOT, 'data', 'logs');
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, 'background.log'), 'a');
  log = (msg) => writeSync(fd, `${msg}\n`);
  childStdio = ['ignore', fd, fd];
}

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
}

/** netstat 里处于 LISTENING 的 8000~8010 端口 → PID（只用于提示端口被谁占了） */
function listeningPids() {
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

/**
 * 命令行里带本仓库路径的 node.exe PID 集合。
 * 老后端可能是 pnpm → tsx watch → node 一串进程，光杀占端口的那个不够（watch 父进程会立刻再拉起），
 * 所以按「命令行包含仓库根路径」整棵识别；别的项目的 node 命令行里没有这个路径，不会被误杀。
 */
function classrepNodePids() {
  const ps = "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | ForEach-Object { $_.ProcessId.ToString() + '`t' + $_.CommandLine }";
  try {
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20_000 }).toString();
    const root = ROOT.toLowerCase().replace(/[/\\]+$/, '');
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const pid = Number(line.slice(0, tab));
      const cmd = line.slice(tab + 1).toLowerCase().replace(/\//g, '\\');
      if (pid > 0 && pid !== process.pid && cmd.includes(root)) pids.add(pid);
    }
    return pids;
  } catch {
    return new Set();
  }
}

/** 第 0 步：只查不拉。远端有新提交时提示一句，拉不拉由用户决定 */
function checkUpdate() {
  const git = (args) => execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 }).toString().trim();
  let branch;
  try {
    branch = git('rev-parse --abbrev-ref HEAD');
  } catch {
    return; // 不是 git 仓库（下的 zip），跳过
  }
  if (branch !== 'main') return; // 正在开发别的分支，不吵
  let behind = 0;
  try {
    git('fetch --quiet origin main');
    behind = Number(git('rev-list --count HEAD..origin/main')) || 0;
  } catch {
    return; // 没网就算了，照常启动
  }
  log(behind > 0
    ? `[0/3] GitHub 上有新版本（落后 ${behind} 个提交）。想更新就运行：git pull`
    : '[0/3] 已经是最新版本');
}

function openBrowser(url) {
  if (isWin) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

if (!process.argv.includes('--no-update')) checkUpdate();
start();

function start() {
log(`[1/3] 关闭旧的 ClassRep 后端...${background ? '（后台模式）' : ''}`);
if (isWin) {
  const mine = classrepNodePids();
  for (const pid of mine) {
    try {
      sh(`taskkill /PID ${pid} /T /F`);
      log(`    已结束旧的后端进程（PID ${pid}）`);
    } catch {
      // 可能已经跟着父进程一起结束了
    }
  }
  for (const [pid, port] of listeningPids()) {
    if (!mine.has(pid) && pid !== process.pid) {
      log(`    端口 ${port} 被其他程序占用（PID ${pid}），不是 ClassRep，跳过后端会自动顺延`);
    }
  }
}

log('[2/3] 打包前端...');
try {
  execSync('pnpm --filter web build', { cwd: ROOT, stdio: childStdio, windowsHide: true });
} catch {
  log('\n前端打包失败，请把上面的报错发给开发同学。');
  if (background) openBrowser(join(ROOT, 'data', 'logs', 'background.log'));
  process.exit(1);
}

log('[3/3] 启动后端，几秒后自动打开浏览器...');
let server;
if (background) {
  // 直接用 node 跑 tsx（不经 pnpm / cmd），这样不会冒出黑窗口；AUTO_EXIT=1 让后端在网页全关后自己退出
  const serverDir = join(ROOT, 'apps', 'server');
  const tsx = join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  server = spawn(process.execPath, [tsx, 'src/index.ts'], {
    cwd: serverDir,
    stdio: childStdio,
    windowsHide: true,
    env: { ...process.env, AUTO_EXIT: '1' },
  });
} else {
  log('（关闭此窗口 / 按 Ctrl+C 即退出）');
  server = spawn('pnpm', ['--filter', 'server', 'dev'], { cwd: ROOT, stdio: 'inherit', shell: true });
}

// 后端在 8000~8010 里顺延挑端口：轮询一圈，哪个 /health 先通就打开哪个
let opened = false;
const timer = setInterval(async () => {
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://localhost:${port}/health`);
      if (!r.ok) continue;
      if (!opened) {
        opened = true;
        clearInterval(timer);
        openBrowser(`http://localhost:${port}`);
        log(`\n已打开 http://localhost:${port}\n`);
      }
      return;
    } catch {
      // 这个端口还没起来，试下一个
    }
  }
}, 1000);
setTimeout(() => clearInterval(timer), 60_000);

server.on('exit', (code) => {
  log(`后端已退出（${code ?? 0}）`);
  process.exit(code ?? 0);
});
}
