#!/usr/bin/env node
// ClassRep Windows 打包（pnpm pack:win 调用；修复计划第二/三节）。
// 产物：release/ClassRep/（目录）+ release/ClassRep.zip：
//   ClassRep/启动.bat                 ← 仓库根（powershell 调 scripts\bootstrap.ps1）
//   ClassRep/scripts/                 ← bootstrap.ps1 + launcher.mjs + versions.json
//   ClassRep/runtime/node.exe         ← versions.json 里固定的版本（缓存到 release/cache/）
//   ClassRep/napcat/                  ← 仓库根 napcat/，排除规则同 .gitignore（账号数据、非 win32-x64 原生库）
//   ClassRep/app/server/dist/index.js ← pnpm -r build 的 esbuild 产物
//   ClassRep/app/web/dist/            ← pnpm -r build 的 vite 产物
//   ClassRep/data/mock/               ← 仿真剧本（data/mock 本来就进 git）
// 不打 .env.release：API Key 由用户首次启动时在向导页填（修复计划 3.2）。
// 真机验收：没装过 Node 的 Windows 电脑、解压到含中文+空格路径、双击 启动.bat 走完修复计划的目标体验。
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!existsSync(join(REPO, 'napcat', f))) fail(`仓库根 napcat/ 缺 ${f}。napcat 运行包应随仓库提交，请重新克隆完整仓库。`);
}
for (const f of ['bootstrap.ps1', 'launcher.mjs', 'versions.json']) {
  if (!existsSync(join(REPO, 'scripts', f))) fail(`缺 scripts/${f}`);
}

// ---------- 1. 构建（pnpm -r build = esbuild 单文件 + vite build） ----------
log('构建 apps/server（esbuild）与 apps/web（vite）…');
const build = spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm -r build'], { cwd: REPO, stdio: 'inherit' });
if (build.status !== 0) fail('pnpm -r build 失败');
if (!existsSync(join(REPO, 'apps', 'server', 'dist', 'index.js'))) fail('缺 apps/server/dist/index.js');
if (!existsSync(join(REPO, 'apps', 'web', 'dist', 'index.html'))) fail('缺 apps/web/dist/index.html');

// ---------- 2. 清空并搭骨架 ----------
rmSync(outDir, { recursive: true, force: true });
for (const d of ['runtime', 'scripts', join('app', 'server', 'dist'), join('app', 'web'), join('data', 'mock')]) {
  mkdirSync(join(outDir, d), { recursive: true });
}
mkdirSync(cacheDir, { recursive: true });

// ---------- 3. 启动.bat + scripts/（新布局：bat → bootstrap.ps1 → launcher.mjs → app/server/dist） ----------
cpSync(join(REPO, '启动.bat'), join(outDir, '启动.bat'));
for (const f of ['bootstrap.ps1', 'launcher.mjs', 'versions.json']) {
  cpSync(join(REPO, 'scripts', f), join(outDir, 'scripts', f));
}

// ---------- 4. runtime/node.exe（版本固定在 scripts/versions.json，与 bootstrap 下载的一致） ----------
const versions = JSON.parse(readFileSync(join(REPO, 'scripts', 'versions.json'), 'utf8'));
const nodeVer = versions.node.version; // 形如 v24.17.0
const cacheExe = join(cacheDir, `node-${nodeVer}-win-x64.exe`);
if (existsSync(cacheExe) && statSync(cacheExe).size > 50 * 1024 * 1024) {
  log(`命中缓存 release/cache/node-${nodeVer}-win-x64.exe`);
} else {
  log(`下载 ${nodeVer} win-x64 node.exe（~80MB，只下这一次）…`);
  let done = false;
  for (const base of versions.node.mirrors) {
    const exeRes = await fetch(`${base}/${nodeVer}/win-x64/node.exe`).catch(() => null);
    if (exeRes?.ok) {
      writeFileSync(cacheExe, Buffer.from(await exeRes.arrayBuffer()));
      done = true;
      break;
    }
    log(`  ${base} 失败，换下一个镜像…`);
  }
  if (!done) fail('下载 node.exe 失败（两个镜像都不通）');
}
cpSync(cacheExe, join(outDir, 'runtime', 'node.exe'));
log(`runtime/node.exe = ${nodeVer}`);

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

// ---------- 6. app/ 与 data/mock/ ----------
cpSync(join(REPO, 'apps', 'server', 'dist', 'index.js'), join(outDir, 'app', 'server', 'dist', 'index.js'));
cpSync(join(REPO, 'apps', 'web', 'dist'), join(outDir, 'app', 'web', 'dist'), { recursive: true });

const mockSrc = join(REPO, 'data', 'mock');
if (existsSync(mockSrc)) {
  cpSync(mockSrc, join(outDir, 'data', 'mock'), { recursive: true });
}

// ---------- 7. 压缩 release/ClassRep.zip ----------
const zipPath = join(releaseDir, 'ClassRep.zip');
rmSync(zipPath, { force: true });
// Windows 10+ 自带 bsdtar；对中文名（启动.bat）比 Compress-Archive 可靠。
// 输出名用相对路径 + cwd：bsdtar 会把「E:\…」里的盘符冒号当成远程主机名（-f host:path），
// 传绝对路径会报 "Cannot connect to E: resolve failed"
const tar = spawnSync('tar', ['-a', '-c', '-f', 'ClassRep.zip', 'ClassRep'], {
  stdio: 'inherit',
  cwd: releaseDir,
});
if (tar.status !== 0) fail('tar 压缩失败（需要 Windows 10 1803+ 或自行安装 bsdtar）');

log('打包完成 ✅');
log(`  ${outDir}（${mb(dirSize(outDir))}）`);
log(`  ${zipPath}（${mb(statSync(zipPath).size)}）`);
log('验收：在没装过 Node 的 Windows 电脑上解压到含中文+空格路径，双击 启动.bat 走完修复计划的目标体验。');
