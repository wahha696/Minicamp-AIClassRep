// NapCat 采集端运行包自动下载（四问题修复 #3 核心）。/napcat/ 不进 git，克隆后采集端缺失，
// 本脚本从 NapCat 官方 GitHub Releases 下载 Shell 包 → SHA-256 校验 → 解压出组件到 napcat/。
// 触发点：① bootstrap.mjs 首检缺文件自动拉；② 后端 POST /api/setup/fetch-napcat（前端一键按钮）。
// 网络兜底：NAPCAT_MIRROR 环境变量指定加速镜像前缀（拼在完整 GitHub URL 之前），
//   未设置时先直连 GitHub、失败自动换 napcat.version.json 里内置的镜像。
// 用法：
//   node scripts/fetch-napcat.mjs                       napcat/NapCatWinBootMain.exe 已存在则跳过
//   node scripts/fetch-napcat.mjs --force               强制重新下载覆盖
//   node scripts/fetch-napcat.mjs --progress-file <p>   进度 {status,percent,message} 写进该文件
//   node scripts/fetch-napcat.mjs --target <dir>        指定安装目录（默认仓库根 napcat/）
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION_FILE = join(REPO_ROOT, 'napcat.version.json');
const BOOT_EXE = 'NapCatWinBootMain.exe';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
function argValue(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const progressFile = argValue('progress-file');
const target = argValue('target') ?? join(REPO_ROOT, 'napcat');

const log = (...a) => console.log('[fetch-napcat]', ...a);
const fail = (msg) => {
  console.error('[fetch-napcat] ❌', msg);
  writeProgress('error', -1, msg);
  process.exit(1);
};
function writeProgress(status, percent, message) {
  if (!progressFile) return;
  try {
    mkdirSync(dirname(progressFile), { recursive: true });
    writeFileSync(progressFile, `${JSON.stringify({ status, percent, message, at: Date.now() })}\n`, 'utf8');
  } catch { /* 进度写不进不影响主流程 */ }
}

// ---------- 0. 读钉定版本 ----------
if (!existsSync(VERSION_FILE)) fail(`找不到 ${VERSION_FILE}，无法确定要下载的 NapCat 版本`);
const pin = JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
if (!pin?.repo || !pin?.version || !pin?.asset) fail('napcat.version.json 缺 repo/version/asset 字段');

if (existsSync(join(target, BOOT_EXE)) && !force) {
  log(`已存在 ${join(target, BOOT_EXE)}，跳过下载（--force 可强制重下）`);
  writeProgress('done', 100, '采集端组件已就绪');
  process.exit(0);
}

// ---------- 1. 下载（镜像优先级：NAPCAT_MIRROR > 直连 > 内置镜像列表，逐个试） ----------
const sources = [
  ...(process.env.NAPCAT_MIRROR ? [process.env.NAPCAT_MIRROR.replace(/\/+$/, '')] : []),
  '', // 直连 GitHub
  ...(Array.isArray(pin.mirrors) ? pin.mirrors : []),
];
const zipPath = join(mkdtempSync(join(tmpdir(), 'classrep-napcat-')), 'NapCat.Shell.zip');
let lastErr = null;
for (const mirror of [...new Set(sources)]) {
  const url = `${mirror === '' ? '' : mirror + '/'}https://github.com/${pin.repo}/releases/download/${pin.version}/${pin.asset}`;
  const host = mirror === '' ? 'github.com（直连）' : new URL(mirror).host;
  try {
    log(`下载 ${pin.version} ${pin.asset}（约 ${Math.round((pin.size ?? 31e6) / 1e6)}MB）← ${host}`);
    writeProgress('downloading', 0, `开始下载采集端组件（${host}）…`);
    await downloadTo(url, zipPath, (p, m) => writeProgress('downloading', p, m));
    lastErr = null;
    break;
  } catch (e) {
    lastErr = e;
    log(`  该源失败：${e.message}，换下一个源`);
  }
}
if (lastErr) {
  fail(
    `下载 NapCat 组件失败：${lastErr.message}。请检查网络后重试；` +
    `也可手动下载 ${pin.asset}（${pin.repo} 的 ${pin.version} Release），解压到 napcat/ 目录。`,
  );
}

// ---------- 2. 校验 ----------
writeProgress('verifying', 100, '校验文件完整性…');
const got = sha256File(zipPath);
if (pin.sha256 && got !== pin.sha256) {
  fail(`下载文件校验不一致（期望 ${pin.sha256.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）。请重试；反复失败请换网络或设置 NAPCAT_MIRROR 镜像。`);
}
log(`SHA-256 校验通过（${got.slice(0, 12)}…）`);

// ---------- 3. 解压（兼容平铺 / 套一层目录两种布局），覆盖安装但保留运行数据 ----------
const stage = mkdtempSync(join(tmpdir(), 'classrep-napcat-'));
const extractDir = join(stage, 'x');
mkdirSync(extractDir, { recursive: true });
if (!unzip(zipPath, extractDir)) fail('解压失败（需要 Windows 10 1803+ 自带 tar，或其他系统自带 unzip/tar）');
const root = findBootRoot(extractDir);
if (root === null) fail('压缩包里没找到 NapCatWinBootMain.exe（官方包布局可能变了），请把输出发给开发同学');

mkdirSync(target, { recursive: true });
// 运行时生成/账号数据不覆盖：config/（OneBot 配置）、cache/、logs/、loadNapCat.js（启动时生成）
for (const name of readdirSync(root)) {
  if (name === 'config' || name === 'cache' || name === 'logs') continue;
  if (name === 'loadNapCat.js' || name === '_loader_debug.log') continue;
  if (/\.bat$/i.test(name)) continue;
  cpSync(join(root, name), join(target, name), { recursive: true, force: true });
}
if (!existsSync(join(target, BOOT_EXE))) fail('安装完成后仍找不到 NapCatWinBootMain.exe，请把输出发给开发同学');

rmSync(stage, { recursive: true, force: true });
try { rmSync(zipPath, { force: true }); } catch { /* 缓存清不掉不影响 */ }
log(`NapCat ${pin.version} 采集端组件安装完成 → ${target}`);
writeProgress('done', 100, '采集端组件已就绪，请点击「重启采集端」');

// ===== 工具函数 =====

let received = 0;

/** 流式下载 + 进度回调（percent 0~99，按 content-length 算；拿不到长度就不报进度） */
async function downloadTo(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0) || pin.size || 0;
  const fd = openSync(dest, 'w');
  received = 0;
  let lastPct = -1;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      writeSync(fd, value);
      received += value.byteLength;
      if (total > 0) {
        const pct = Math.min(99, Math.floor((received / total) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress?.(pct, `下载中 ${pct}%`);
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  if (total > 0 && received !== total) throw new Error(`下载不完整（${received}/${total} 字节）`);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 解 zip：优先 tar（Win10 1803+ 自带 bsdtar，Linux/macOS 也能解 zip 的实现），失败试 PowerShell */
function unzip(zip, dir) {
  const t = spawnSync('tar', ['-x', '-f', zip, '-C', dir], { stdio: 'ignore', windowsHide: true });
  if (t.status === 0 && existsSync(dir)) return true;
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`],
      { stdio: 'ignore', windowsHide: true });
    return ps.status === 0 && existsSync(dir);
  }
  return false;
}

/** 找压缩包里 NapCatWinBootMain.exe 所在目录（根目录平铺 or 套一层目录都兼容） */
function findBootRoot(dir) {
  let cursor = dir;
  for (let depth = 0; depth < 3; depth++) {
    if (existsSync(join(cursor, BOOT_EXE))) return cursor;
    const entries = readdirSync(cursor).map((n) => join(cursor, n));
    const dirs = entries.filter((p) => statSync(p).isDirectory());
    if (entries.length === 1 && dirs.length === 1) {
      cursor = dirs[0]; // 只有一个子目录：当成包裹层剥掉
      continue;
    }
    for (const p of dirs) {
      if (existsSync(join(p, BOOT_EXE))) return p;
    }
    return null;
  }
  return null;
}
