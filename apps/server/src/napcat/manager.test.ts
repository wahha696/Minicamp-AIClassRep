// A3 验收：manager.ts 可纯测的部分（spawn 参数、滑动窗口、settings.json 读写）。
// 真实的 spawn/taskkill 行为留到 A7 真机联调（A1 的 probe 脚本已实测过同款逻辑）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNapcatEnv, buildSpawnArgs, getUin, pruneRecent, setUin } from './manager.js';
import { NAPCAT_DIR } from './paths.js';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ClassRep ${prefix} 中文 `));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }
});

describe('buildSpawnArgs（NapCat接口规格.md §1）', () => {
  it('无 uin：两个参数，不出现 -q', () => {
    expect(buildSpawnArgs('D:\\QQ.exe')).toEqual(['D:\\QQ.exe', join(NAPCAT_DIR, 'NapCatWinBootHook.dll')]);
  });

  it('有 uin：追加 -q <uin>（快速登录，失败自动回落二维码）', () => {
    expect(buildSpawnArgs('D:\\QQ.exe', '123456789'))
      .toEqual(['D:\\QQ.exe', join(NAPCAT_DIR, 'NapCatWinBootHook.dll'), '-q', '123456789']);
  });
});

describe('buildNapcatEnv（5 个 NAPCAT_* 环境变量，照抄 napcat-launcher.bat）', () => {
  it('路径正确且 NAPCAT_MAIN_PATH 用正斜杠', () => {
    const env = buildNapcatEnv();
    expect(env.NAPCAT_PATCH_PACKAGE).toBe(join(NAPCAT_DIR, 'qqnt.json'));
    expect(env.NAPCAT_LOAD_PATH).toBe(join(NAPCAT_DIR, 'loadNapCat.js'));
    expect(env.NAPCAT_INJECT_PATH).toBe(join(NAPCAT_DIR, 'NapCatWinBootHook.dll'));
    expect(env.NAPCAT_LAUNCHER_PATH).toBe(join(NAPCAT_DIR, 'NapCatWinBootMain.exe'));
    expect(env.NAPCAT_MAIN_PATH).toBe(join(NAPCAT_DIR, 'napcat.mjs').replaceAll('\\', '/'));
  });
});

describe('pruneRecent（「60s 内退出 ≥3 次」的滑动窗口）', () => {
  it('只保留窗口内的退出时间戳', () => {
    const now = 1_000_000;
    expect(pruneRecent([now - 61_000, now - 59_999, now - 10_000], now, 60_000))
      .toEqual([now - 59_999, now - 10_000]);
  });

  it('恰好 windowMs 前的不算（开区间）', () => {
    const now = 500_000;
    expect(pruneRecent([now - 60_000], now, 60_000)).toEqual([]);
    expect(pruneRecent([now - 59_999], now, 60_000)).toEqual([now - 59_999]);
  });
});

describe('settings.json（data/settings.json，只有 A 读写）', () => {
  it('setUin → getUin 往返，文件内容为 { uin }', () => {
    const dir = tempDir('settings');
    expect(getUin(dir)).toBeUndefined();
    setUin('123456789', dir);
    expect(getUin(dir)).toBe('123456789');
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ uin: '123456789' });
  });

  it('文件不存在或内容损坏时 getUin 返回 undefined 而不抛', () => {
    const dir = tempDir('settings');
    expect(getUin(dir)).toBeUndefined();
    writeFileSync(join(dir, 'settings.json'), '{{{', 'utf8');
    expect(getUin(dir)).toBeUndefined();
  });
});
