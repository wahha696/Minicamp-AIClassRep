// 一键启动 / 重启（开发用）：node scripts/dev.mjs，或双击 scripts/dev-start.bat
// 1) 结束占着 8000~8010 端口的旧后端（解决「8000 被占用」）
// 2) 重新打包前端
// 3) 启动后端，几秒后自动打开浏览器；再运行一次就是「重启」
import { execSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = Array.from({ length: 11 }, (_, i) => 8000 + i);
const isWin = process.platform === 'win32';

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
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

console.log('[1/3] 关闭旧的 ClassRep 后端...');
if (isWin) {
  for (const [pid, port] of listeningPids()) {
    if (!isNode(pid)) {
      console.log(`    端口 ${port} 被其他程序占用（PID ${pid}），不是 ClassRep，跳过`);
      continue;
    }
    try {
      sh(`taskkill /PID ${pid} /T /F`);
      console.log(`    已结束占用端口 ${port} 的旧后端（PID ${pid}）`);
    } catch {
      console.log(`    结束 PID ${pid} 失败，可以手动在任务管理器里结束 node.exe`);
    }
  }
}

console.log('[2/3] 打包前端...');
try {
  execSync('pnpm --filter web build', { cwd: ROOT, stdio: 'inherit' });
} catch {
  console.log('\n前端打包失败，请把上面的报错发给开发同学。');
  process.exit(1);
}

console.log('[3/3] 启动后端，几秒后自动打开浏览器...（关闭此窗口 / 按 Ctrl+C 即退出）');
const server = spawn('pnpm', ['--filter', 'server', 'dev'], { cwd: ROOT, stdio: 'inherit', shell: true });

let opened = false;
const timer = setInterval(async () => {
  try {
    const r = await fetch('http://localhost:8000/health');
    if (r.ok && !opened) {
      opened = true;
      clearInterval(timer);
      if (isWin) spawn('cmd', ['/c', 'start', '', 'http://localhost:8000'], { detached: true, stdio: 'ignore' }).unref();
      console.log('\n已打开 http://localhost:8000\n');
    }
  } catch {
    // 还没起来，继续等
  }
}, 1000);
setTimeout(() => clearInterval(timer), 60_000);

server.on('exit', (code) => process.exit(code ?? 0));
