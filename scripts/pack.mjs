#!/usr/bin/env node
// ClassRep Windows 打包（分工 A8，pnpm pack:win 调用）。
// 产物：release/ClassRep/（目录）+ release/ClassRep.zip。布局见架构.md §1：
//   ClassRep/启动.bat
//   ClassRep/runtime/node.exe          ← nodejs.org 下载 win-x64 v24 LTS（缓存到 release/cache/）
//   ClassRep/napcat/                   ← 仓库根 napcat/，排除 config/ cache/ logs/ guild1.db loadNapCat.js *.bat
//   ClassRep/app/server/dist/index.js  ← pnpm -r build 的 esbuild 产物
//   ClassRep/app/web/dist/             ← pnpm -r build 的 vite 产物
//   ClassRep/app/update.mjs            ← scripts/update.mjs（下次启动应用自更新包）
//   ClassRep/app/version.json          ← { version, repo }：后端检查更新 / update.mjs 用
//   ClassRep/app/.env                  ← 仓库根 .env.release（组长私下给，不进 git；缺了告警并跳过）
//   ClassRep/data/mock/                ← 仿真剧本（data/mock 本来就进 git）
// 真机验收：没装过 Node 的 Windows 电脑、解压到含中文+空格路径、双击 启动.bat 走完架构.md §0。
import { spawnSync, execSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
if (!existsSync(join(REPO, 'napcat', 'NapCatWinBootMain.exe'))) {
  fail('仓库根没有 napcat/NapCatWinBootMain.exe。napcat/ 不进 git，请按分工 A 的前提条件准备。');
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

// ---------- 4. runtime/node.exe（lib/fetch-node.mjs：查最新 v24 LTS + 缓存，与 bootstrap 共用） ----------
const { version } = await ensureNodeExe(join(outDir, 'runtime', 'node.exe'), {
  cacheDir,
  log: (m) => log(m),
});
log(`runtime/node.exe = ${version}`);

// ---------- 5. napcat/（排除账号数据与启动脚本，架构.md §1） ----------
const napcatSrc = join(REPO, 'napcat');
const napcatOut = join(outDir, 'napcat');
mkdirSync(napcatOut, { recursive: true });
for (const name of readdirSync(napcatSrc)) {
  if (name === 'config' || name === 'cache' || name === 'logs' || name === 'guild1.db' || name === 'loadNapCat.js') continue;
  if (/\.bat$/i.test(name)) continue;
  cpSync(join(napcatSrc, name), join(napcatOut, name), { recursive: true });
}
if (!existsSync(join(napcatOut, 'NapCatWinBootMain.exe'))) fail('napcat/ 缺 NapCatWinBootMain.exe');

// ---------- 6. app/ 与 data/mock/ ----------
cpSync(join(REPO, 'apps', 'server', 'dist', 'index.js'), join(outDir, 'app', 'server', 'dist', 'index.js'));
cpSync(join(REPO, 'apps', 'web', 'dist'), join(outDir, 'app', 'web', 'dist'), { recursive: true });

const envRelease = join(REPO, '.env.release');
if (existsSync(envRelease)) {
  cpSync(envRelease, join(outDir, 'app', '.env'));
  log('app/.env ← .env.release ✅');
} else {
  console.warn('[pack] ⚠️ 仓库根没有 .env.release（组长私下给，不进 git）。已跳过——包能跑但 LLM 不可用。');
}

const mockSrc = join(REPO, 'data', 'mock');
if (existsSync(mockSrc)) {
  cpSync(mockSrc, join(outDir, 'data', 'mock'), { recursive: true });
}

// ---------- 6.5 自更新器 + 版本信息（问题 4：update.mjs 每次启动前由 启动.bat 调用） ----------
cpSync(join(REPO, 'scripts', 'update.mjs'), join(outDir, 'app', 'update.mjs'));
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
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
  `${JSON.stringify({ version: pkg.version ?? '0.0.0', repo, packed_at: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);
log(`app/version.json = v${pkg.version ?? '0.0.0'}（${repo}）`);

// ---------- 7. 压缩 release/ClassRep.zip ----------
const zipPath = join(releaseDir, 'ClassRep.zip');
rmSync(zipPath, { force: true });
// Windows 10+ 自带 bsdtar；对中文名（启动.bat）比 Compress-Archive 可靠
const tar = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', releaseDir, 'ClassRep'], { stdio: 'inherit' });
if (tar.status !== 0) fail('tar 压缩失败（需要 Windows 10 1803+ 或自行安装 bsdtar）');

log('打包完成 ✅');
log(`  ${outDir}（${mb(dirSize(outDir))}）`);
log(`  ${zipPath}（${mb(statSync(zipPath).size)}）`);
log('A8 验收：在没装过 Node 的 Windows 电脑上解压到含中文+空格路径，双击 启动.bat 走完架构.md §0。');
