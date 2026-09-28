// 克隆即用的启动链路（问题 2）：启动.bat 保证 Node 后调这里，五步自检安装 + 启动。
//   [1/5] Node 可用性（node:sqlite，即 ≥22.13；启动.bat 已保证，这里再验一次给友好报错）
//   [2/5] 包管理器与依赖：pnpm 不在 PATH 就用 Node 自带 corepack 装到 .corepack/bin（免管理员），
//         node_modules 落后于 pnpm-lock.yaml 才 install（平时秒过）
//   [3/5] NapCat 采集端运行包：缺失就跑 scripts/fetch-napcat.mjs（官方 Release 自动下载）
//   [4/5] 前端产物：apps/web/dist 缺失或源码比产物新才 vite build（增量缓存，不再每次全量打包）
//   [5/5] 杀旧后端 → tsx 直跑后端 → 轮询 /health → 自动开浏览器（复用 lib/start-server.mjs）
// 参数：--background（后台模式，网页全关自动退出） --force-build（强制重打前端） --force-deps
//       --no-update（dev.mjs 的参数，这里仅为透传兼容，忽略）
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findHealthyPort,
  killOldBackends,
  openBackgroundLog,
  openBrowser,
  startServerChild,
} from './lib/start-server.mjs';
import { webBuildFresh } from './lib/build-cache.mjs';
import { corepackEnv, resolvePnpm } from './lib/pnpm.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const background = argv.includes('--background');
const forceBuild = argv.includes('--force-build');
const forceDeps = argv.includes('--force-deps');

const bgLog = background ? openBackgroundLog(ROOT, false) : null;
const log = bgLog ? bgLog.log : console.log;
const step = (n, msg) => log(`[${n}/5] ${msg}`);

// ---------- [1/5] Node ----------
try {
  await import('node:sqlite');
} catch {
  console.error(`[ClassRep] ❌ 当前 Node ${process.version} 没有 node:sqlite（需要 ≥22.13）。`);
  console.error('   删除仓库下 runtime\\node.exe 后重新双击 启动.bat 可自动下载新版；或自行升级 Node。');
  process.exit(1);
}
step(1, `Node ${process.version} 可用`);

// ---------- [2/5] 包管理器与依赖 ----------
const pnpm = await resolvePnpm(ROOT, log);
if (!pnpm) {
  console.error('[ClassRep] ❌ pnpm 不可用（PATH/corepack/自动下载都失败）。可手动安装：npm i -g pnpm，再重新启动。');
  process.exit(1);
}
if (!depsFresh() || forceDeps) {
  step(2, '安装依赖（首次较慢，之后秒级）…');
  const r = spawnSync(pnpm.cmd, [...pnpm.args, 'install', '--frozen-lockfile'], {
    cwd: ROOT,
    stdio: background ? bgLog.stdio : 'inherit',
    shell: pnpm.shell,
    windowsHide: true,
    env: { ...process.env, ...corepackEnv() },
  });
  if (r.status !== 0) {
    console.error('\n[ClassRep] ❌ 依赖安装失败。请把上面的报错发给开发同学，或手动执行 pnpm install 后重试。');
    process.exit(1);
  }
} else {
  step(2, `依赖已是最新（${pnpm.label}），跳过安装`);
}

// ---------- [3/5] NapCat 采集端运行包（Windows 专用，Linux/Mac 用 Docker 部署，见 deploy/） ----------
if (isWin() && !existsSync(join(ROOT, 'napcat', 'NapCatWinBootMain.exe'))) {
  step(3, '缺 NapCat 运行包（napcat/ 不进 git），自动下载官方 Release（约 30MB）…');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fetch-napcat.mjs')], {
    cwd: ROOT,
    stdio: background ? bgLog.stdio : 'inherit',
    windowsHide: true,
  });
  if (r.status !== 0) {
    log('    ⚠️ 自动下载失败，可稍后在网页连接页点「一键下载 NapCat 组件」重试。');
  } else {
    step(3, 'NapCat 运行包安装完成');
  }
} else {
  step(3, 'NapCat 采集端组件已就绪');
}

// ---------- [4/5] 前端产物（增量构建缓存） ----------
if (!webBuildFresh(ROOT) || forceBuild) {
  step(4, '前端产物缺失或源码有更新，重新构建…');
  const r = spawnSync(pnpm.cmd, [...pnpm.args, '--filter', 'web', 'build'], {
    cwd: ROOT,
    stdio: background ? bgLog.stdio : 'inherit',
    shell: pnpm.shell,
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.error('\n[ClassRep] ❌ 前端构建失败，请把上面的报错发给开发同学。');
    process.exit(1);
  }
} else {
  step(4, '前端产物无变化，跳过构建');
}

// ---------- [5/5] 启动后端 ----------
step(5, '启动后端，几秒后自动打开浏览器…');
killOldBackends({ log });
const { child, logFile } = startServerChild({ root: ROOT, background, bg: bgLog });

const port = await findHealthyPort(90_000);
if (port !== null) {
  openBrowser(`http://localhost:${port}`);
  log(`\n已打开 http://localhost:${port}${logFile ? `\n（后台日志：${logFile}）` : ''}\n`);
} else {
  log('后端 90 秒内没有就绪（可能还在首次启动），可稍后手动打开 http://localhost:8000');
}

child.on('exit', (code) => {
  log(`后端已退出（${code ?? 0}）`);
  process.exit(code ?? 0);
});

// ===== helpers =====

function isWin() {
  return process.platform === 'win32';
}

/** node_modules 比 pnpm-lock.yaml 旧（或不存在）→ 需要安装 */
function depsFresh() {
  const marker = join(ROOT, 'node_modules', '.modules.yaml'); // pnpm install 的产物
  const lock = join(ROOT, 'pnpm-lock.yaml');
  if (!existsSync(marker) || !existsSync(lock)) return false;
  return statSync(marker).mtimeMs >= statSync(lock).mtimeMs;
}
