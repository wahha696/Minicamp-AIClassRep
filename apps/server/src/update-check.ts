// 打包版后台检查更新（问题 4）：读 app/version.json → 每 12 小时查一次 GitHub 最新 Release →
// 版本更新就把 ClassRep.zip 下到 data/update/ → 最后写 data/update/pending.json。
// 应用更新发生在下次启动：启动.bat 看到 pending.json 就先跑 app/update.mjs（改名法热替换 runtime）。
// 全程静默失败：更新是锦上添花，绝不能打扰正常使用（所有异常吞掉）。
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, ROOT } from './paths.js';

const VERSION_FILE = join(ROOT, 'app', 'version.json');
const UPDATE_DIR = join(DATA_DIR, 'update');
const CHECK_INTERVAL = 12 * 60 * 60 * 1000; // 12 小时查一次

/** 打包布局（app/version.json 存在）才检查更新；仓库版走 dev.mjs 的 git pull */
export function isPackagedInstall(): boolean {
  return existsSync(VERSION_FILE);
}

/** 启动时调一次，之后每 12 小时一次。任何失败都不抛（更新是锦上添花）。 */
export function startUpdateChecker(): void {
  if (!existsSync(VERSION_FILE)) return; // 仓库布局没有 app/version.json，不查
  const tick = () => {
    checkOnce().catch(() => {});
  };
  tick();
  setInterval(tick, CHECK_INTERVAL).unref();
}

async function checkOnce(): Promise<void> {
  const info = readVersionInfo();
  if (!info?.repo) return;
  if (existsSync(join(UPDATE_DIR, 'pending.json'))) return; // 已有待应用的更新，等重启

  const res = await fetch(`https://api.github.com/repos/${info.repo}/releases/latest`, {
    headers: { 'User-Agent': 'ClassRep-Updater' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return;
  const rel = (await res.json()) as {
    tag_name?: string;
    assets?: Array<{ name: string; browser_download_url: string; size: number }>;
  };
  const latest = rel.tag_name ?? '';
  if (!isNewer(latest, info.version)) return;

  const asset = (rel.assets ?? []).find((a) => a.name === 'ClassRep.zip');
  const manifestAsset = (rel.assets ?? []).find((a) => a.name === 'ClassRep.manifest.json');
  if (!asset || !manifestAsset) return; // release 里没有打包产物/清单，跳过

  // S05：先拿发布清单（发版时算好的 sha256+size），没清单/清单不合法宁可不更
  const mres = await fetch(manifestAsset.browser_download_url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!mres.ok) return;
  const manifest = (await mres.json()) as { version?: string; sha256?: string; size?: number };
  const wantSha = (manifest.sha256 ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wantSha)) return;
  if (manifest.version !== latest.replace(/^v/i, '')) return; // 清单与 tag 对不上，不发

  mkdirSync(UPDATE_DIR, { recursive: true });
  const zipPath = join(UPDATE_DIR, 'ClassRep.zip');
  const tmpPath = `${zipPath}.tmp`;
  const dl = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!dl.ok || !dl.body) return;
  await pipeline(dl.body, createWriteStream(tmpPath));
  // 完整性校验：大小 + SHA-256 必须和发布清单一致，不一致就丢弃（S05）
  const size = statSync(tmpPath).size;
  if (typeof manifest.size === 'number' && size !== manifest.size) {
    rmSyncQuiet(tmpPath);
    console.warn(`[update] ${latest} 包大小不符（${size} != ${manifest.size}），已丢弃`);
    return;
  }
  const gotSha = await sha256File(tmpPath);
  if (gotSha !== wantSha) {
    rmSyncQuiet(tmpPath);
    console.warn(`[update] ${latest} SHA-256 校验失败（${gotSha.slice(0, 12)}… != 清单），已丢弃`);
    return;
  }
  renameSync(tmpPath, zipPath);
  // 下载完成且校验过才写 pending.json —— 写入即代表「下次启动应用更新」；
  // sha256 一并写入，update.mjs 应用前复核（防止落盘后被动手脚）
  writeFileSync(
    join(UPDATE_DIR, 'pending.json'),
    `${JSON.stringify({ zip: zipPath, sha256: wantSha, to: latest, from: info.version, at: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  console.log(`[update] 发现新版本 ${latest}（当前 v${info.version}），已下载并校验 SHA-256，下次启动自动应用`);
}

/** 流式 SHA-256（zip 上百 MB，不一次读进内存/阻塞事件循环） */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), async function* (src) {
    for await (const chunk of src) {
      hash.update(chunk as Buffer);
      yield;
    }
  });
  return hash.digest('hex');
}

function rmSyncQuiet(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 忽略
  }
}

function readVersionInfo(): { version: string; repo: string } | null {
  try {
    return JSON.parse(readFileSync(VERSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 语义化版本比较：v1.2.10 > v1.2.9；解析失败的 tag 一律视为不更新 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
