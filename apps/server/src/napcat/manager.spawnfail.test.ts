// 回归测试：spawn 同步抛错（Windows 上 EPERM——杀软/策略拦截等）不得把服务器进程带崩，
// 只落 facts.spawnFailed → state error（架构.md §4「错误处理不崩溃」）。
// 现象背景：打包版启动时 spawn 抛错曾一路冒到顶层导致进程退出（启动.bat 闪退）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});
// 固定临时目录：manager 自己会 mkdirSync 建日志目录，无需预创建
vi.mock('../paths.js', async () => {
  const { join } = await import('node:path');
  const dir = join(tmpdir(), 'classrep-spawnfail-test');
  return { DATA_DIR: join(dir, 'data'), NAPCAT_DIR: dir, ROOT: dir };
});
vi.mock('./paths.js', async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = join(tmpdir(), 'classrep-spawnfail-test');
  return { QRCODE_PATH: join(dir, 'qrcode.png'), findQQExe: () => 'D:\\QQ.exe' };
});

import { getManagerFacts, NAPCAT_REQUIRED, spawnNapcat } from './manager.js';

const tempRoot = join(tmpdir(), 'classrep-spawnfail-test');
afterEach(() => {
  vi.clearAllMocks();
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

/** 造一个「完整」的 napcat 目录（只需要文件存在） */
function stubNapcat(): void {
  mkdirSync(tempRoot, { recursive: true });
  for (const f of NAPCAT_REQUIRED) writeFileSync(join(tempRoot, f), '');
}

describe('spawnNapcat 缺少采集组件', () => {
  it('napcat 目录不完整 → napcatMissing=true，不调用 spawn', () => {
    expect(() => spawnNapcat()).not.toThrow();
    expect(getManagerFacts().napcatMissing).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('spawnNapcat 同步抛错（回归：启动.bat 闪退）', () => {
  it('spawn 抛 EPERM → 不向外抛，落 spawnFailed=true、pid=null', () => {
    stubNapcat();
    spawnMock.mockImplementation(() => {
      const err = new Error('spawn EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(() => spawnNapcat()).not.toThrow();
    const facts = getManagerFacts();
    expect(facts.spawnFailed).toBe(true);
    expect(facts.pid).toBeNull();
    expect(facts.qqExe).toBe('D:\\QQ.exe'); // findQQExe 已成功，仅 spawn 被拦
  });
});
