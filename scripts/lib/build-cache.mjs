// 前端构建的增量缓存判断（问题 2）：apps/web/dist/index.html 比源码新 → 跳过 vite build。
// dev.mjs 与 bootstrap.mjs 共用。窗口：apps/web 下除 node_modules/dist/.vite 外的全部文件 mtime。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** true = dist 比源码新（或同刻），可以跳过构建 */
export function webBuildFresh(root) {
  const distIndex = join(root, 'apps', 'web', 'dist', 'index.html');
  if (!existsSync(distIndex)) return false;
  return newestMtime(join(root, 'apps', 'web')) <= statSync(distIndex).mtimeMs;
}

/** 目录里（跳过 node_modules/dist/.vite）最新的文件 mtime */
export function newestMtime(dir) {
  let max = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.vite') continue;
      max = Math.max(max, newestMtime(p));
    } else {
      try {
        max = Math.max(max, statSync(p).mtimeMs);
      } catch {
        // 忽略读不到的
      }
    }
  }
  return max;
}
