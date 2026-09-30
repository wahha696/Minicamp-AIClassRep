// pnpm 可用性解析（成熟度评估 D02），bootstrap.mjs 与 dev.mjs 共用：
//   PATH 里的 pnpm（先用 --version 探活，坏掉的 shim 会被跳过）→
//   Node 自带 corepack 装到 <root>/.corepack/bin（免管理员）→
//   最后兜底：下载官方 pnpm dist tarball 到 <root>/.pnpm-dist/，用 node 直接跑 pnpm.cjs。
// 返回 { cmd, args, shell, label } 或 null；调用方 spawn 时用 cmd+args+shell。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export function corepackEnv() {
  return { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
}

const isWin = () => process.platform === 'win32';

export async function resolvePnpm(root, log) {
  const probe = (cmd, args, shell) => {
    try {
      const r = spawnSync(cmd, [...args, '--version'], {
        stdio: 'ignore',
        shell,
        windowsHide: true,
        timeout: 30_000,
        env: { ...process.env, ...corepackEnv() },
      });
      return r.status === 0;
    } catch {
      return false;
    }
  };
  if (probe('pnpm', [], true)) {
    return { cmd: 'pnpm', args: [], shell: true, label: 'PATH 里的 pnpm' };
  }
  // corepack：nodejs.org 发行版自带（<node>/node_modules/corepack）。装到仓库内目录，不动系统。
  const corepackJs = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js');
  if (existsSync(corepackJs)) {
    // corepack enable 会对安装目录 realpathSync，目录不存在直接 ENOENT（全新解压的首跑必中）
    const bin = join(root, '.corepack', 'bin');
    mkdirSync(bin, { recursive: true });
    spawnSync(process.execPath, [corepackJs, 'enable', '--install-directory', bin], {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    });
    const shim = isWin() ? join(bin, 'pnpm.cmd') : join(bin, 'pnpm');
    // 仓库路径可能带空格（如 Desktop\Class Rep），shell 模式下必须整体加引号
    const quoted = `"${shim}"`;
    if (existsSync(shim) && probe(quoted, [], true)) {
      return { cmd: quoted, args: [], shell: true, label: 'corepack 安装的 pnpm（.corepack/bin）' };
    }
  }
  // 兜底：裸 node.exe 没有 corepack——直接下 pnpm dist tarball（D02）
  const cjs = await ensurePnpmDist(root, log);
  if (cjs && probe(process.execPath, [cjs], false)) {
    return { cmd: process.execPath, args: [cjs], shell: false, label: '内置下载的 pnpm（.pnpm-dist）' };
  }
  return null;
}

/**
 * 下载 pnpm-<version>.tgz 解压到 <root>/.pnpm-dist/（版本取 package.json 的 packageManager 字段）。
 * 依次尝试 PNPM_MIRROR → registry.npmjs.org → registry.npmmirror.com；解压靠系统自带 tar。
 * 返回 pnpm.cjs 路径；失败返回 null。
 */
async function ensurePnpmDist(root, log) {
  const dest = join(root, '.pnpm-dist');
  const cjs = join(dest, 'package', 'bin', 'pnpm.cjs');
  if (existsSync(cjs)) return cjs;
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ver = /pnpm@([\d.]+)/.exec(pkg.packageManager ?? '')?.[1] ?? '10.34.5';
  const registries = [
    process.env.PNPM_MIRROR?.trim(),
    'https://registry.npmjs.org',
    'https://registry.npmmirror.com',
  ].filter(Boolean);
  const tgz = join(dest, `pnpm-${ver}.tgz`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  let downloaded = false;
  for (const reg of registries) {
    const url = `${reg}/pnpm/-/pnpm-${ver}.tgz`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024 || buf[0] !== 0x1f || buf[1] !== 0x8b) continue; // gzip 魔数校验
      writeFileSync(tgz, buf);
      downloaded = true;
      log(`    pnpm ${ver} 已下载（${reg}）`);
      break;
    } catch {
      // 换下一个源
    }
  }
  if (!downloaded) {
    rmSync(dest, { recursive: true, force: true });
    return null;
  }
  const tar = spawnSync('tar', ['-xzf', tgz, '-C', dest], { stdio: 'ignore', windowsHide: true });
  rmSync(tgz, { force: true });
  if (tar.status !== 0 || !existsSync(cjs)) {
    rmSync(dest, { recursive: true, force: true });
    return null;
  }
  return cjs;
}
