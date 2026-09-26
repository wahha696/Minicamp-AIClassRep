// B1 验收：ROOT 定位与派生路径
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATA_DIR, MOCK_DIR, NAPCAT_DIR, ROOT, WEB_DIST } from './paths.js';

/** 从本文件往上找第一个含 pnpm-workspace.yaml 的目录 = 仓库根 */
function repoRootFromHere(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根');
}

describe('paths', () => {
  it('ROOT 是仓库根（含 启动.bat 与 pnpm-workspace.yaml）', () => {
    expect(ROOT).toBe(repoRootFromHere());
    expect(existsSync(join(ROOT, '启动.bat'))).toBe(true);
    expect(existsSync(join(ROOT, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('DATA_DIR / NAPCAT_DIR / MOCK_DIR 都由 ROOT 派生', () => {
    expect(DATA_DIR).toBe(join(ROOT, 'data'));
    expect(NAPCAT_DIR).toBe(join(ROOT, 'napcat'));
    expect(MOCK_DIR).toBe(join(ROOT, 'data', 'mock'));
  });

  it('WEB_DIST 是 app/web/dist 或 apps/web/dist', () => {
    expect([join(ROOT, 'app', 'web', 'dist'), join(ROOT, 'apps', 'web', 'dist')]).toContain(
      WEB_DIST,
    );
  });
});
