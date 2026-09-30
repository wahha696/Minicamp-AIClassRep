// ClassRep 免安装包自更新器（问题 4）。打包时被复制为 app\update.mjs，由 启动.bat 在启动前调用：
//   if exist "data\update\pending.json" if exist "app\update.mjs" → runtime\node.exe app\update.mjs
// 流程：读 data\update\pending.json { zip, to } → 解压到 data\update\staging →
//       整树预备到 data\update\new → 逐目录「改名换旧、改名上新」事务化切换（失败整体回滚，
//       runtime\node.exe 单独热替换）→ 清工作树与 pending → 退出 0，启动.bat 接着正常启动。
// 任何失败：保留 pending.json 与 staging（下次启动重试），退出码非 0（启动.bat 继续用旧版跑）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// ---------- 1.5 SHA-256 复核（S05）：pending.json 里的摘要来自发版清单，落盘后必须仍一致 ----------
if (typeof pending.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(pending.sha256)) {
  // 缺校验信息的 pending 不应用（老版本 updater 写的不带 sha256；宁可不更不盲更）
  quarantine(`缺少 sha256 校验信息`);
}
const got = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
if (got !== pending.sha256.toLowerCase()) {
  quarantine(`SHA-256 校验失败（文件可能被篡改或下载损坏）`);
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

// ---------- 3. 事务化覆盖安装（R7 / 旧评 P0-04：任何一步失败整体回滚） ----------
// 3a 预备：把更新内容全量复制到 data/update/new（还没碰安装根，失败直接退出）；
// 3b 切换：逐个顶层目录「旧的改名进 data/update/old → 新的改名进安装根」，记日志；
// 3c 任何一步失败按日志反向改回；runtime\node.exe 仍走热替换（正在运行的 exe 所在目录不整目录 rename）。
// 断电/进程被杀的窗口从「整个复制过程」缩到「每目录两次 rename」（毫秒级）；
// 即便截停在切换中途，pending.json 还在，下次启动会重跑本脚本收敛到完整新版。
const NEWROOT = join(INSTALL_ROOT, 'data', 'update', 'new');
const OLDROOT = join(INSTALL_ROOT, 'data', 'update', 'old');
rmSync(NEWROOT, { recursive: true, force: true });
rmSync(OLDROOT, { recursive: true, force: true });
mkdirSync(NEWROOT, { recursive: true });
mkdirSync(OLDROOT, { recursive: true });

const entries = readdirSync(src).filter((name) => name !== 'data'); // data/ 是用户数据，绝不动
try {
  for (const name of entries) {
    cpSync(join(src, name), join(NEWROOT, name), { recursive: true, force: true });
  }
} catch (e) {
  console.error(`[update] ❌ 预备新文件失败（${e?.message ?? e}）。现有安装未改动，保留 pending.json 可重试。`);
  process.exit(1);
}

const swapped = [];
function rollback() {
  for (const name of swapped.reverse()) {
    try {
      rmSync(join(INSTALL_ROOT, name), { recursive: true, force: true });
      renameSync(join(OLDROOT, name), join(INSTALL_ROOT, name));
    } catch (err) {
      console.error(`[update] ⚠️ 回滚 ${name} 失败：${err?.message ?? err}（可从 ClassRep.zip 手动恢复）`);
    }
  }
}

try {
  for (const name of entries) {
    if (name === 'runtime') continue; // node.exe 正在运行，整目录 rename 不可靠，单独热替换
    if (existsSync(join(INSTALL_ROOT, name))) renameSync(join(INSTALL_ROOT, name), join(OLDROOT, name));
    renameSync(join(NEWROOT, name), join(INSTALL_ROOT, name));
    swapped.push(name);
  }
  swapRuntime(join(NEWROOT, 'runtime', 'node.exe'), join(INSTALL_ROOT, 'runtime', 'node.exe'));
  // 更新包 runtime/ 里除 node.exe 外的文件（目前打包只有 node.exe，防御性补齐）
  const newRuntime = join(NEWROOT, 'runtime');
  if (existsSync(newRuntime)) {
    for (const f of readdirSync(newRuntime)) {
      if (f !== 'node.exe') cpSync(join(newRuntime, f), join(INSTALL_ROOT, 'runtime', f), { recursive: true, force: true });
    }
  }
} catch (e) {
  console.error(`[update] ❌ 切换失败（${e?.message ?? e}），正在整体回滚…`);
  rollback();
  console.error('[update] 已回滚到旧版，保留 pending.json，下次启动重试。');
  process.exit(1);
}

// ---------- 4. 收尾：清 staging/pending/新旧工作树；旧运行时（node.exe.old）下次启动再清 ----------
try {
  rmSync(join(INSTALL_ROOT, 'runtime', 'node.exe.old'), { force: true });
} catch {
  // 可能正被本进程占用，下次启动再清
}
rmSync(pendingPath, { force: true });
rmSync(STAGING, { recursive: true, force: true });
rmSync(NEWROOT, { recursive: true, force: true });
rmSync(OLDROOT, { recursive: true, force: true });
console.log(`[update] ✅ 已更新到 v${pending.to ?? '?'}，继续启动...`);

// ===== helpers =====

/**
 * 校验不过的更新包不应用、也不让 pending.json 留在原地反复重试：
 * pending → pending.failed.json、zip → .zip.bad（留档可查，下次发版会覆盖）。
 */
function quarantine(reason) {
  console.error(`[update] ❌ 更新包校验未通过：${reason}。已隔离，本次用旧版继续启动。`);
  try {
    renameSync(pendingPath, `${pendingPath}.failed.json`);
  } catch {
    rmSync(pendingPath, { force: true });
  }
  try {
    renameSync(zipPath, `${zipPath}.bad`);
  } catch {
    // 改名失败就删掉，绝不留着被下次读到
    rmSync(zipPath, { force: true });
  }
  process.exit(1);
}

/** runtime/node.exe 热替换：Windows 允许给正在运行的 exe 改名，但不允许覆盖/删除。失败抛错由调用方整体回滚（R7）。 */
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
    throw new Error('runtime\\node.exe 无法改名（被占用？）');
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
    throw new Error(`写入新运行时失败：${e?.message ?? e}`);
  }
}
