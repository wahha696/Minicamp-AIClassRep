// 一键启动 / 重启（开发用）
//   node scripts/dev.mjs              前台模式：黑窗口里看日志，关窗口即退出（scripts\dev-start.bat）
//   node scripts/dev.mjs --background 后台模式：不显示窗口，网页全关掉后自动退出（桌面快捷方式走这个）
// 步骤：0) 在 main 分支上就先从 GitHub 拉最新代码（依赖变了顺便装）  1) 结束占着 8000~8010 端口的旧后端
//       2) 前端产物有更新才重新打包（增量缓存）  3) 启动后端并自动打开浏览器
// 加 --no-update 跳过第 0 步；不在 main 分支（正在开发别的分支）或没网时也会跳过，照常启动。
// 再运行一次就是「重启」。杀后端 / 起后端 / 健康检查共用 scripts/lib/start-server.mjs（bootstrap.mjs 同款）。
import { execSync, spawn, spawnSync } from 'node:child_process';
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const background = process.argv.includes('--background');
const noUpdate = process.argv.includes('--no-update');

// 后台模式没有窗口，输出都写进日志文件，出问题时看 data/logs/background.log
const bgLog = background ? openBackgroundLog(ROOT, !noUpdate) : null; // 更新后重跑时接着写
const log = bgLog ? bgLog.log : ((msg) => console.log(msg));

// pnpm 解析（D02，和 bootstrap.mjs 同一套）：PATH 里的坏 shim 会探活失败自动跳过
// → corepack 装到 .corepack/bin → 再不行自动下载 pnpm dist 到 .pnpm-dist/ 用 node 跑。
// 同学机器上 「npm 里的 pnpm 指到已删除的目录」这种半坏 PATH 就靠这层兜底自愈。
const pnpm = await resolvePnpm(ROOT, log);
/** 跑一个 pnpm 子命令。pnpm 不可用时返回 false（由调用方决定报错口径） */
function runPnpm(args) {
  if (pnpm === null) return false;
  const r = spawnSync(pnpm.cmd, [...pnpm.args, ...args], {
    cwd: ROOT,
    stdio: bgLog ? bgLog.stdio : 'inherit',
    shell: pnpm.shell,
    windowsHide: true,
    env: { ...process.env, ...corepackEnv() },
  });
  return r.status === 0;
}

/** 第 0 步：拉最新 main。返回 true 表示 dev.mjs 自己被更新了，需要用新版重新跑一遍 */
function updateToLatest() {
  const git = (args) => execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60_000 }).toString().trim();
  let branch;
  try {
    branch = git('rev-parse --abbrev-ref HEAD');
  } catch {
    log('[0/3] 不是 git 仓库，跳过更新');
    return false;
  }
  if (branch !== 'main') {
    log(`[0/3] 当前在 ${branch} 分支（开发中），不自动更新`);
    return false;
  }
  const before = git('rev-parse HEAD');
  try {
    git('pull --ff-only --autostash origin main');
  } catch (e) {
    log(`[0/3] 拉取最新版本失败（没网或本地有冲突），用现有版本启动：${String(e.stderr || e.message).split(/\r?\n/)[0]}`);
    return false;
  }
  const after = git('rev-parse HEAD');
  if (before === after) {
    log(`[0/3] 已经是最新版本（${after.slice(0, 7)}）`);
    return false;
  }
  const changed = git(`diff --name-only ${before} ${after}`).split(/\r?\n/);
  log(`[0/3] 已更新到最新版本 ${before.slice(0, 7)} → ${after.slice(0, 7)}（${changed.length} 个文件）`);
  if (changed.some((f) => /(^|\/)(package\.json|pnpm-lock\.yaml)$/.test(f))) {
    log('    依赖有变化，正在安装...');
    if (!runPnpm(['install', '--frozen-lockfile'])) {
      log('    安装依赖失败，继续尝试启动');
    }
  }
  return changed.includes('scripts/dev.mjs');
}

async function start() {
  log(`[1/3] 关闭旧的 ClassRep 后端...${background ? '（后台模式）' : ''}`);
  killOldBackends({ log });

  log('[2/3] 检查前端产物...');
  if (!webBuildFresh(ROOT)) {
    log('    重新打包前端...');
    if (!runPnpm(['--filter', 'web', 'build'])) {
      log('\n前端打包失败，请把上面的报错发给开发同学。');
      if (background) openBrowser(join(ROOT, 'data', 'logs', 'background.log'));
      process.exit(1);
    }
  } else {
    log('    前端产物无变化，跳过打包');
  }

  log('[3/3] 启动后端，几秒后自动打开浏览器...');
  if (!background) log('（关闭此窗口 / 按 Ctrl+C 即退出）');
  // 后台模式：直接 node 跑 tsx（不经 pnpm / cmd）不冒黑窗口；AUTO_EXIT=1 网页全关后自退
  const { child: server, logFile } = startServerChild({ root: ROOT, background, watch: !background, bg: bgLog });
  void logFile;

  const port = await findHealthyPort(60_000);
  if (port !== null) {
    openBrowser(`http://localhost:${port}`);
    log(`\n已打开 http://localhost:${port}\n`);
  } else {
    log('后端 60 秒内没有就绪，可稍后手动打开 http://localhost:8000');
  }

  server.on('exit', (code) => {
    log(`后端已退出（${code ?? 0}）`);
    process.exit(code ?? 0);
  });
}

if (!noUpdate && updateToLatest()) {
  // 启动脚本自己也更新了：用新版重跑一遍（带 --no-update，不会重复拉取）
  log('    启动脚本也更新了，用新版重新启动...');
  const again = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), '--no-update'], {
    cwd: ROOT,
    stdio: background ? 'ignore' : 'inherit',
    windowsHide: true,
  });
  again.on('exit', (code) => process.exit(code ?? 0));
} else {
  start();
}

