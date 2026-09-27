// 下载 node.exe（win-x64）并缓存（问题 2/4 共用）。pack.mjs 的下载逻辑抽到这里：
//   · fetchLatestV24Lts()：查 nodejs.org 上最新的 v24 LTS 版本号；
//   · ensureNodeExe(dest)：dest 缺失或大小不对才下载，成功后落盘。
// 镜像：环境变量 NODE_MIRROR（如 https://npmmirror.com/mirrors/node），默认 nodejs.org。
// 版本兜底：查不到列表时用 NODE_PIN，保证明确可指引手动下载。
import { copyFileSync, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** 钉住的兜底版本（nodejs.org/dist/index.json 拉不到时用；发版时更新一次即可） */
export const NODE_PIN = 'v24.19.0';

const DIST = (process.env.NODE_MIRROR ?? 'https://nodejs.org/dist').replace(/\/+$/, '');

/** 查 nodejs.org 上最新的 v24 LTS 版本号（形如 v24.19.0） */
export async function fetchLatestV24Lts() {
  const res = await fetch(`${DIST}/index.json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`拉取 node 版本列表失败：HTTP ${res.status}`);
  const versions = await res.json();
  const pick = versions.find((v) => typeof v.version === 'string' && v.version.startsWith('v24.') && v.lts);
  if (!pick?.version) throw new Error('找不到 v24 LTS 版本');
  return pick.version;
}

/**
 * 确保 dest 是可用的 win-x64 node.exe：已存在（>50MB）或命中缓存就直接用，否则下载。
 * opts.cacheDir 给了就先在缓存放一份（pack 多次打包不重复下载）。
 */
export async function ensureNodeExe(dest, opts = {}) {
  const log = opts.log ?? (() => {});
  let version = opts.version ?? NODE_PIN;
  if (!opts.version) {
    try {
      version = await fetchLatestV24Lts();
    } catch (e) {
      log(`查询最新 v24 LTS 失败（${errText(e)}），改用钉定版本 ${NODE_PIN}`);
    }
  }
  mkdirSync(dirname(dest), { recursive: true });

  const cached = opts.cacheDir ? join(opts.cacheDir, `node-${version}-win-x64.exe`) : undefined;
  if (cached && usableExe(cached)) {
    if (!sameFile(cached, dest)) copyFileSync(cached, dest);
    return { version, downloaded: false };
  }
  if (cached === undefined && usableExe(dest)) {
    return { version, downloaded: false };
  }

  const url = `${DIST}/${version}/win-x64/node.exe`;
  log(`下载 ${version} win-x64 node.exe（约 80MB，只下载一次）…`);
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`下载 node.exe 失败：HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
  if (!usableExe(dest)) throw new Error(`下载的 node.exe 大小异常（${statSync(dest).size} 字节）`);
  if (cached) copyFileSync(dest, cached);
  return { version, downloaded: true };
}

function usableExe(path) {
  try {
    return existsSync(path) && statSync(path).size > 50 * 1024 * 1024;
  } catch {
    return false;
  }
}

function sameFile(a, b) {
  try {
    return existsSync(a) && existsSync(b) && statSync(a).size === statSync(b).size;
  } catch {
    return false;
  }
}

function errText(e) {
  return e instanceof Error ? e.message : String(e);
}
