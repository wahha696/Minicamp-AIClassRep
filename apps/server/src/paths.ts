// 根目录必须同时满足应用布局边界和启动标记；残缺副本不得继续向上借用另一安装。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isAppBoundary(dir: string): boolean {
  // Source and packaged layouts are both authoritative, even if manifests are missing.
  // The shipped package has app/version.json, not a root package.json.
  if (existsSync(join(dir, 'apps', 'server')) || existsSync(join(dir, 'app', 'server'))
    || existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return !!pkg && typeof pkg === 'object' && 'name' in pkg && pkg.name === 'classrep';
  } catch { return false; }
}

export function findRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (isAppBoundary(dir)) {
      if (existsSync(join(dir, '启动.bat'))) return dir;
      throw new Error(`应用安装不完整：${dir} 缺少「启动.bat」，拒绝使用上级目录的数据；请恢复完整安装文件`);
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // D10：找不到 启动.bat 不再猜布局（上跳 3 级对打包布局 app/server/dist 是错的），直接报错退出
  throw new Error(`找不到「启动.bat」：请从项目根目录启动（当前文件：${fileURLToPath(import.meta.url)}）`);
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
