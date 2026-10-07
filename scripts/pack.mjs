#!/usr/bin/env node
// ClassRep Windows 打包（pnpm pack:win 调用；修复计划第二/三节 + 分工 A8）。
// 产物：release/ClassRep/（目录）+ release/ClassRep.zip：
//   ClassRep/启动.bat                 ← 仓库根（免安装包布局：直接跑 runtime\node.exe + app\）
//   ClassRep/runtime/node.exe         ← lib/fetch-node.mjs 下载 win-x64 LTS（缓存到 release/cache/）
//   ClassRep/napcat/                  ← 仓库根 napcat/，排除规则同 .gitignore（账号数据、非 win32-x64 原生库）
//   ClassRep/app/server/dist/index.js ← pnpm -r build 的 esbuild 产物
//   ClassRep/app/web/dist/            ← pnpm -r build 的 vite 产物
//   ClassRep/app/update.mjs           ← scripts/update.mjs（下次启动应用自更新包）
//   ClassRep/app/version.json         ← { version, repo }：后端检查更新 / update.mjs 用
//   ClassRep/data/mock/               ← 仿真剧本（data/mock 本来就进 git）
//   ClassRep/classrep-fastjudge/      ← 本地快判：src + models + py/ 便携 python（无 python 无网也能跑）
//                                     排除 .venv（机器绝对路径）、__pycache__、models/best（重复检查点）
// 不打 .env.release：API Key 由用户首次启动时在向导页填（修复计划 3.2），密钥绝不进发布包。
// 真机验收：没装过 Node 的 Windows 电脑、解压到含中文+空格路径、双击 启动.bat 走完修复计划的目标体验。
import { spawnSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureNodeExe } from './lib/fetch-node.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url))); // 仓库根
const releaseDir = join(REPO, 'release');
const outDir = join(releaseDir, 'ClassRep');
const cacheDir = join(releaseDir, 'cache');

const log = (...a) => console.log('[pack]', ...a);
const fail = (msg) => { console.error('[pack] ❌', msg); process.exit(1); };
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

function dirSize(p) {
  let total = 0;
  for (const n of readdirSync(p)) {
    const f = join(p, n);
    total += statSync(f).isDirectory() ? dirSize(f) : statSync(f).size;
  }
  return total;
}

// ---------- 0. 前置检查 ----------
if (process.platform !== 'win32') fail('只能在 Windows 上打包（产物是 .bat + QQ 注入）');
for (const f of ['NapCatWinBootMain.exe', 'NapCatWinBootHook.dll', 'napcat.mjs']) {
  if (!existsSync(join(REPO, 'napcat', f))) {
    fail(`仓库根 napcat/ 缺 ${f}。napcat 运行包随发布包分发；克隆版用户可用「一键下载 NapCat 组件」补齐。`);
  }
}

// ---------- 1. 构建（pnpm -r build = esbuild 单文件 + vite build） ----------
log('构建 apps/server（esbuild）与 apps/web（vite）…');
const build = spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm -r build'], { cwd: REPO, stdio: 'inherit' });
if (build.status !== 0) fail('pnpm -r build 失败');
if (!existsSync(join(REPO, 'apps', 'server', 'dist', 'index.js'))) fail('缺 apps/server/dist/index.js');
if (!existsSync(join(REPO, 'apps', 'web', 'dist', 'index.html'))) fail('缺 apps/web/dist/index.html');

// ---------- 2. 清空并搭骨架 ----------
rmSync(outDir, { recursive: true, force: true });
for (const d of ['runtime', join('app', 'server', 'dist'), join('app', 'web'), join('data', 'mock')]) {
  mkdirSync(join(outDir, d), { recursive: true });
}
mkdirSync(cacheDir, { recursive: true });

// ---------- 3. 启动.bat ----------
cpSync(join(REPO, '启动.bat'), join(outDir, '启动.bat'));
cpSync(join(REPO, '修复升级.bat'), join(outDir, '修复升级.bat'));
cpSync(join(REPO, '修复升级.ps1'), join(outDir, '修复升级.ps1'));
mkdirSync(join(outDir, 'scripts'), { recursive: true });
cpSync(join(REPO, 'scripts', 'windows-acceptance.ps1'), join(outDir, 'scripts', 'windows-acceptance.ps1'));
cpSync(join(REPO, 'Windows真机验收.md'), join(outDir, 'Windows真机验收.md'));

// ---------- 4. runtime/node.exe（lib/fetch-node.mjs：查最新 LTS + 缓存，与 bootstrap 共用） ----------
const { version: nodeVersion } = await ensureNodeExe(join(outDir, 'runtime', 'node.exe'), {
  cacheDir,
  log: (m) => log(m),
});
log(`runtime/node.exe = ${nodeVersion}`);

// ---------- 5. napcat/（排除规则与 .gitignore 一致：账号数据、运行时生成文件、非 win32-x64 原生库） ----------
const napcatSrc = join(REPO, 'napcat');
const napcatOut = join(outDir, 'napcat');
const NAPCAT_TOP_SKIP = new Set(['config', 'cache', 'logs', 'plugins']);
function napcatSkip(rel, name, isDir) {
  const top = rel.split('/')[0];
  if (NAPCAT_TOP_SKIP.has(top)) return true;
  if (rel.includes('/')) return false; // 更深层（native/、node_modules/）只按下面的规则过滤
  if (isDir) return false;
  if (name === 'loadNapCat.js' || name === '_loader_debug.log') return true;
  if (/\.bat$/i.test(name) || /\.db(-.*)?$/i.test(name)) return true; // *.db、*.db-wal、guild*.db*
  return false;
}
function copyNapcat(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const isDir = statSync(s).isDirectory();
    const rel = relative(napcatSrc, s).split(sep).join('/');
    if (napcatSkip(rel, name, isDir)) continue;
    if (rel.startsWith('native/') && /(linux|darwin|arm64)/i.test(rel)) continue;
    if (isDir) copyNapcat(s, join(dst, name));
    else cpSync(s, join(dst, name));
  }
}
copyNapcat(napcatSrc, napcatOut);
if (!existsSync(join(napcatOut, 'NapCatWinBootMain.exe'))) fail('napcat/ 缺 NapCatWinBootMain.exe');

// ---------- 5.5 classrep-fastjudge/（本地快判：源码+模型+便携 python，开箱即用） ----------
// py/ 便携运行时必须随包预装（用户无 python、可能无网）；缺了就现场供给一次。
const fjSrc = join(REPO, 'classrep-fastjudge');
if (existsSync(join(fjSrc, 'src', 'infer.py'))) {
  if (!existsSync(join(fjSrc, 'py', 'python.exe'))) {
    log('classrep-fastjudge/py 便携 Python 缺失，先跑 fastjudge-setup.mjs 供给…');
    const setup = spawnSync(process.execPath, [join(REPO, 'scripts', 'fastjudge-setup.mjs')], {
      cwd: REPO, stdio: 'inherit',
    });
    if (setup.status !== 0) fail('fastjudge-setup.mjs 供给失败（也可手动 node scripts/fastjudge-setup.mjs 后重跑）');
  }
  // R2：文件在 ≠ 可用。打包前必须验证便携 Python 能 import 快判依赖——
  // 打包版没有 scripts/fastjudge-setup.mjs，残缺 py/ 进了包就是静默死亡（只剩 30s 退避日志）。
  const fjPy = join(fjSrc, 'py', 'python.exe');
  const usable = spawnSync(fjPy, ['-c', 'import sklearn,jieba,joblib,numpy;print("ok")'], {
    encoding: 'utf8', timeout: 60_000, cwd: fjSrc,
  });
  if (usable.status !== 0 || !String(usable.stdout).includes('ok')) {
    fail('classrep-fastjudge/py 便携 Python 依赖校验不过（删掉 py/ 后重跑 node scripts/fastjudge-setup.mjs）');
  }
  const FJ_SKIP = new Set(['.venv', '__pycache__', 'best', 'data', 'reports']); // best/ 是 models/ 下重复的训练检查点；data/reports 是本地训练产物（R3）
  function copyFastjudge(src, dst) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) {
      if (FJ_SKIP.has(name)) continue;
      if (name.endsWith('.cache') || name === 'get-pip.py' || name.startsWith('python-') && name.endsWith('.zip')) continue;
      const s = join(src, name);
      if (statSync(s).isDirectory()) copyFastjudge(s, join(dst, name));
      else cpSync(s, join(dst, name));
    }
  }
  copyFastjudge(fjSrc, join(outDir, 'classrep-fastjudge'));
  log(`classrep-fastjudge → 包内（含 py/ 便携运行时 ${mb(dirSize(join(outDir, 'classrep-fastjudge')))}）`);
} else {
  log('⚠️ 缺 classrep-fastjudge/src/infer.py：本包不带本地快判（用户可自行放入项目根目录自动启用）');
}

// ---------- 6. app/ 与 data/mock/ ----------
cpSync(join(REPO, 'apps', 'server', 'dist', 'index.js'), join(outDir, 'app', 'server', 'dist', 'index.js'));
cpSync(join(REPO, 'apps', 'web', 'dist'), join(outDir, 'app', 'web', 'dist'), { recursive: true });

const mockSrc = join(REPO, 'data', 'mock');
if (existsSync(mockSrc)) {
  cpSync(mockSrc, join(outDir, 'data', 'mock'), { recursive: true });
}

// ---------- 6.5 自更新器 + 版本信息（update.mjs 每次启动前由 启动.bat 调用） ----------
// --version <v> 或 PACK_VERSION：CI 里 tag 必须在 zip 之前就写进 version.json（成熟度评估 D04）
cpSync(join(REPO, 'scripts', 'update.mjs'), join(outDir, 'app', 'update.mjs'));
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const argVersionIdx = process.argv.indexOf('--version');
const packVersion = (argVersionIdx >= 0 ? process.argv[argVersionIdx + 1] : process.env.PACK_VERSION ?? '')
  .replace(/^v/i, '');
const version = packVersion || pkg.version || '0.0.0';
let repo = 'wahha696/Minicamp-AIClassRep';
try {
  const url = execSync('git remote get-url origin', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    .toString().trim()
    .replace(/\.git$/, '');
  if (/github\.com[:/].+/.test(url)) {
    repo = url.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
  }
} catch {
  // 没有 git 信息就用默认仓库
}
writeFileSync(
  join(outDir, 'app', 'version.json'),
  `${JSON.stringify({ version, repo, packed_at: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);
log(`app/version.json = v${version}（${repo}）`);

// ---------- 7. 压缩 release/ClassRep.zip ----------
const zipPath = join(releaseDir, 'ClassRep.zip');
rmSync(zipPath, { force: true });
// tar -a 在部分 Windows 环境会把中文名写成 ??，甚至输出名为 .zip 的 TAR。
// 使用 .NET 显式生成 ZIP + UTF-8 文件名，包含隐藏文件，并检查压缩包内的启动入口。
const archive = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(REPO, 'scripts', 'zip-release.ps1'),
  '-SourceDirectory', outDir, '-ArchivePath', zipPath,
], {
  stdio: 'inherit',
  windowsHide: true,
});
if (archive.status !== 0) fail('ZIP 压缩或启动入口校验失败');

// ---------- 8. 发布清单（成熟度评估 S05）：自更新按它校验 SHA-256 + 大小，校验不过不更新 ----------
const zipSize = statSync(zipPath).size;
const zipSha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
const manifestPath = join(releaseDir, 'ClassRep.manifest.json');
writeFileSync(
  manifestPath,
  `${JSON.stringify({ version, zip: 'ClassRep.zip', sha256: zipSha256, size: zipSize }, null, 2)}\n`,
  'utf8',
);
log(`发布清单 ${manifestPath}（sha256=${zipSha256.slice(0, 12)}…）`);

log('打包完成 ✅');
log(`  ${outDir}（${mb(dirSize(outDir))}）`);
log(`  ${zipPath}（${mb(statSync(zipPath).size)}）`);
log('验收：在没装过 Node 的 Windows 电脑上解压到含中文+空格路径，双击 启动.bat 走完修复计划的目标体验。');
