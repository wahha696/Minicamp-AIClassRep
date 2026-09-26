// 一键启动 / 重启（开发用）
//   node scripts/dev.mjs              前台模式：黑窗口里看日志，关窗口即退出（scripts\dev-start.bat）
//   node scripts/dev.mjs --background 后台模式：不显示窗口，网页全关掉后自动退出（桌面快捷方式走这个）
// 步骤：1) 结束占着 8000~8010 端口的旧后端  2) 重新打包前端  3) 启动后端并自动打开浏览器
// 再运行一次就是「重启」。
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
  const fd = openSync(join(dir, 'background.log'), 'w');
  log = (msg) => writeSync(fd, `${msg}\n`);
  childStdio = ['ignore', fd, fd];
}

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
}

/** netstat 里处于 LISTENING 的 8000~8010 端口 → PID */
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

/** 只结束 node 进程，别误杀别的程序 */
function isNode(pid) {
  try {
    return /node\.exe/i.test(sh(`tasklist /FI "PID eq ${pid}" /NH`));
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (isWin) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

log(`[1/3] 关闭旧的 ClassRep 后端...${background ? '（后台模式）' : ''}`);
if (isWin) {
  for (const [pid, port] of listeningPids()) {
    if (pid === process.pid) continue;
    if (!isNode(pid)) {
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

let opened = false;
const timer = setInterval(async () => {
  try {
    const r = await fetch('http://localhost:8000/health');
    if (r.ok && !opened) {
      opened = true;
      clearInterval(timer);
      openBrowser('http://localhost:8000');
      log('\n已打开 http://localhost:8000\n');
    }
  } catch {
    // 还没起来，继续等
  }
}, 1000);
setTimeout(() => clearInterval(timer), 60_000);

server.on('exit', (code) => {
  log(`后端已退出（${code ?? 0}）`);
  process.exit(code ?? 0);
});
