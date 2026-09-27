// 一键启动（由根目录 启动.bat → scripts/bootstrap.ps1 调用；修复计划第二节）。
//   1. 发布包（有 app/server/dist/index.js）：直接启动，不装不编译。
//   2. 克隆的仓库：依赖或代码变了就 corepack pnpm install + build（用户不用装 pnpm），再启动。
//   3. 启动 node <server> ，后端自己挑端口、打开浏览器；关掉窗口 = 退出。
// 用法：node scripts/launcher.mjs [--rebuild]
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'data');
const STAMP = join(DATA, '.build-stamp');
const forceRebuild = process.argv.includes('--rebuild');

const say = (m) => console.log(m);
const die = (m) => {
  console.error(`\n❌ ${m}\n`);
  process.exit(1);
};

// ---------- 0. Node 版本（bootstrap 已筛过，这里兜底给直接 node 运行的人） ----------
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 15)) {
  die(`需要 Node.js 22.15 以上，当前是 ${process.version}。删掉 runtime 文件夹后重新双击 启动.bat 会自动下载合适的版本。`);
}

// ---------- 1. 发布包：直接跑 ----------
const packedServer = join(ROOT, 'app', 'server', 'dist', 'index.js');
if (existsSync(packedServer)) {
  run(packedServer);
} else {
  // ---------- 2. 克隆的仓库：按需安装 + 构建 ----------
  const devServer = join(ROOT, 'apps', 'server', 'dist', 'index.js');
  const webIndex = join(ROOT, 'apps', 'web', 'dist', 'index.html');
  const want = sourceHash();
  const have = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : '';
  const needBuild = forceRebuild || want !== have || !existsSync(devServer) || !existsSync(webIndex);
  if (needBuild) {
    say(have === '' ? '首次启动：正在准备运行环境（安装依赖 + 构建，约 1~3 分钟，只需一次）...' : '检测到代码更新，正在重新构建...');
    pnpm(['install', '--frozen-lockfile'], '安装依赖失败。请检查网络后重新双击 启动.bat（国内网络可以多试一次）。');
    pnpm(['-r', 'build'], '构建失败，请把上面的报错发给开发同学。');
    mkdirSync(DATA, { recursive: true });
    writeFileSync(STAMP, want);
    say('✅ 准备完成\n');
  }
  run(devServer);
}

/** 用 Node 自带的 corepack 跑 pnpm（版本由 package.json 的 packageManager 锁定），用户不需要全局装 pnpm */
function pnpm(args, failMsg) {
  const corepack = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js');
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_HOME: join(ROOT, '.corepack') };
  // 国内网络：官方 registry 连不上时，第二次用 npmmirror 重试（corepack 下载 pnpm 本身也走这个）
  const attempts = [{}, { npm_config_registry: 'https://registry.npmmirror.com', COREPACK_NPM_REGISTRY: 'https://registry.npmmirror.com' }];
  for (const extra of attempts) {
    const r = existsSync(corepack)
      ? spawnSync(process.execPath, [corepack, 'pnpm', ...args], { cwd: ROOT, stdio: 'inherit', env: { ...env, ...extra } })
      : spawnSync('pnpm', args, { cwd: ROOT, stdio: 'inherit', env: { ...env, ...extra }, shell: true });
    if (r.status === 0) return;
    if (extra.npm_config_registry === undefined) say('\n  第一次失败，换国内镜像重试...\n');
  }
  die(failMsg);
}

/** 决定要不要重新构建：lockfile + 所有源码的修改时间和大小（比 git 依赖少，下 zip 也能用） */
function sourceHash() {
  const h = createHash('sha256');
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
  for (const f of files) {
    const p = join(ROOT, f);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  for (const dir of ['apps/server/src', 'apps/web/src', 'apps/web/index.html', 'apps/server/package.json', 'apps/web/package.json', 'apps/server/build.mjs', 'apps/web/vite.config.ts', 'shared']) {
    walk(join(ROOT, dir), (p, st) => h.update(`${p}|${st.size}|${st.mtimeMs}\n`));
  }
  return h.digest('hex');
}

function walk(p, fn) {
  if (!existsSync(p)) return;
  const st = statSync(p);
  if (st.isFile()) return fn(p, st);
  for (const n of readdirSync(p)) {
    if (n === 'node_modules' || n === 'dist') continue;
    walk(join(p, n), fn);
  }
}

/** 启动后端；Ctrl+C / 关窗口时后端自己收 SIGINT/SIGHUP 结束采集端 */
function run(entry) {
  say('正在启动 AI 课代表，稍后会自动打开浏览器（关闭此窗口即退出）\n');
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CLASSREP_OPEN_BROWSER: '1' },
  });
  const forward = (sig) => () => { try { child.kill(sig); } catch { /* 已退出 */ } };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGHUP', forward('SIGHUP'));
  child.on('exit', (code) => process.exit(code ?? 0));
}
