// 根目录与各路径。ROOT = 从本文件所在目录往上找、第一个包含「启动.bat」的目录
// （仓库根和压缩包根都有这个文件）。开发时是仓库根，打包后是压缩包根。
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, '启动.bat'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // 兜底：假设入口在 <根>/apps/server/src 或 <根>/app/server
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export const ROOT: string = findRoot();
export const DATA_DIR: string = join(ROOT, 'data');
export const NAPCAT_DIR: string = join(ROOT, 'napcat');
export const MOCK_DIR: string = join(DATA_DIR, 'mock');
/** 按账号分库（问题 1）：每个 QQ 号一个库目录，换号互不可见、删目录即删账号 */
export const ACCOUNTS_DIR: string = join(DATA_DIR, 'accounts');

/** WEB_DIST 取 ROOT/app/web/dist（压缩包）或 ROOT/apps/web/dist（开发）中存在的那个 */
function findWebDist(): string {
  const packed = join(ROOT, 'app', 'web', 'dist');
  if (existsSync(packed)) return packed;
  return join(ROOT, 'apps', 'web', 'dist');
}

export const WEB_DIST: string = findWebDist();
