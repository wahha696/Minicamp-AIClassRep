// ClassRep 免安装包自更新器（问题 4）。打包时被复制为 app\update.mjs，由 启动.bat 在启动前调用：
//   if exist "data\update\pending.json" if exist "app\update.mjs" → runtime\node.exe app\update.mjs
// 流程：读 data\update\pending.json { zip, to } → 解压到 data\update\staging →
//       覆盖安装根（跳过 data/；runtime\node.exe 用「改名 → 拷新 → 失败回滚」热替换）→
//       删 pending 与 staging → 退出 0，启动.bat 接着正常启动（此时已是新版文件）。
// 任何失败：保留 pending.json 与 staging（下次启动重试），退出码非 0（启动.bat 继续用旧版跑）。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 安装根 = app/ 的上一级（打包布局：<root>\app\update.mjs）
const APP_DIR = dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = dirname(APP_DIR);
const STAGING = join(INSTALL_ROOT, 'data', 'update', 'staging');

console.log('[update] 应用待安装的更新...');

// ---------- 1. 读触发文件 ----------
const pendingPath = join(INSTALL_ROOT, 'data', 'update', 'pending.json');
let pending;
try {
  pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
} catch {
  console.error('[update] ❌ 读不到 data\\update\\pending.json，跳过更新（可手动删除该文件）。');
  process.exit(1);
}
const zipPath = pending.zip;
if (!zipPath || !existsSync(zipPath)) {
  console.error(`[update] ❌ 更新包不存在（${zipPath ?? '未指定'}）。删除 pending.json 可跳过本次更新。`);
  process.exit(1);
}

// ---------- 2. 解压 ----------
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });
const tar = spawnSync('tar', ['-x', '-f', zipPath, '-C', STAGING], { stdio: 'ignore', windowsHide: true });
if (tar.status !== 0) {
  console.error('[update] ❌ 解压失败（包损坏？）。保留 pending.json，可重试。');
  process.exit(1);
}
const src = existsSync(join(STAGING, 'ClassRep')) ? join(STAGING, 'ClassRep') : STAGING;
if (!existsSync(join(src, 'app', 'server', 'dist', 'index.js'))) {
  console.error('[update] ❌ 更新包内容不对（缺 app/server/dist/index.js），已中止且不改动现有安装。');
  process.exit(1);
}

// ---------- 3. 覆盖安装（data/ 是用户数据，绝不动） ----------
for (const name of readdirSync(src)) {
  if (name === 'data') continue;
  if (name === 'runtime') {
    swapRuntime(join(src, 'runtime', 'node.exe'), join(INSTALL_ROOT, 'runtime', 'node.exe'));
    continue;
  }
  cpSync(join(src, name), join(INSTALL_ROOT, name), { recursive: true, force: true });
}

// ---------- 4. 收尾：清 staging 与 pending；旧运行时（node.exe.old）下次启动再清 ----------
try {
  rmSync(join(INSTALL_ROOT, 'runtime', 'node.exe.old'), { force: true });
} catch {
  // 可能正被本进程占用，下次启动再清
}
rmSync(pendingPath, { force: true });
rmSync(STAGING, { recursive: true, force: true });
console.log(`[update] ✅ 已更新到 v${pending.to ?? '?'}，继续启动...`);

// ===== helpers =====

/** runtime/node.exe 热替换：Windows 允许给正在运行的 exe 改名，但不允许覆盖/删除。 */
function swapRuntime(srcExe, targetExe) {
  if (!existsSync(srcExe)) {
    console.warn('[update] ⚠️ 更新包里没有 runtime/node.exe，保留现有运行时');
    return;
  }
  const backup = `${targetExe}.old`;
  try {
    rmSync(backup, { force: true });
  } catch {
    // 占用中：留给下次启动清理
  }
  try {
    renameSync(targetExe, backup); // 正在运行的 exe 可以改名
  } catch {
    console.error('[update] ❌ runtime\\node.exe 无法改名（被占用？），更新中止，用旧版继续。');
    process.exit(1);
  }
  try {
    cpSync(srcExe, targetExe, { force: true });
  } catch (e) {
    // 拷新失败 → 回滚改名，保持旧版可用
    try {
      renameSync(backup, targetExe);
    } catch {
      // 极端情况：回滚也失败。下次启动 启动.bat 会因缺 node.exe 自动重新下载。
    }
    console.error(`[update] ❌ 写入新运行时失败：${e?.message ?? e}`);
    process.exit(1);
  }
}
