import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { env } from '../env.js';
import {
  getFastjudgePython,
  getFastjudgeRoot,
  getLocalModelPath,
  localJevAvailable,
  resetLocalJevBackoff,
  spawnEnv,
} from './jev-local.js';

const original = {
  root: env.FASTJUDGE_ROOT,
  model: env.LOCAL_JEV_MODEL_PATH,
  py: env.FASTJUDGE_PYTHON,
};

beforeEach(() => {
  env.FASTJUDGE_ROOT = '';
  env.LOCAL_JEV_MODEL_PATH = '';
  env.FASTJUDGE_PYTHON = '';
  resetLocalJevBackoff();
});

afterEach(() => {
  env.FASTJUDGE_ROOT = original.root;
  env.LOCAL_JEV_MODEL_PATH = original.model;
  env.FASTJUDGE_PYTHON = original.py;
});

describe('jev-local paths (Windows-first, fail-closed)', () => {
  it('仓库根带 classrep-fastjudge 时免配置自动启用（约定路径）', () => {
    // 工作区已随仓库分发：不配置任何 env 也应解析到 <repo>/classrep-fastjudge
    expect(getFastjudgeRoot()).toMatch(/classrep-fastjudge$/);
    expect(getLocalModelPath()).toMatch(/local-jev-v1\.joblib$/);
    expect(localJevAvailable()).toBe(true);
  });

  it('显式 ROOT 指向不存在目录时不可用（fail-closed）', () => {
    env.FASTJUDGE_ROOT = 'definitely-not-here-fastjudge-root';
    expect(getFastjudgeRoot()).toBe('definitely-not-here-fastjudge-root');
    expect(localJevAvailable()).toBe(false);
  });

  it('显式 MODEL 优先于 ROOT 拼接', () => {
    env.LOCAL_JEV_MODEL_PATH = 'D:\\models\\local-jev-v1.joblib';
    expect(getLocalModelPath()).toBe('D:\\models\\local-jev-v1.joblib');
  });

  it('显式 PYTHON 原样返回', () => {
    env.FASTJUDGE_PYTHON = 'D:\\dev\\classrep-fastjudge\\.venv\\Scripts\\python.exe';
    expect(getFastjudgePython()).toBe('D:\\dev\\classrep-fastjudge\\.venv\\Scripts\\python.exe');
  });

  it('未设 PYTHON 且 root 下无 py/.venv 时回落平台默认解释器名（不假装存在）', () => {
    env.FASTJUDGE_ROOT = 'definitely-not-here-fastjudge-root';
    const py = getFastjudgePython();
    expect(py === 'python' || py === 'python3').toBe(true);
  });

  it('root 下有 py/python.exe 时优先于 .venv（打包版开箱即用）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fj-root-'));
    try {
      const isWin = process.platform === 'win32';
      const bundled = join(tmp, 'py', 'python.exe');
      const venvPy = join(tmp, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
      mkdirSync(dirname(bundled), { recursive: true });
      writeFileSync(bundled, '');
      env.FASTJUDGE_ROOT = tmp;
      expect(getFastjudgePython()).toBe(bundled);
      rmSync(bundled);
      mkdirSync(dirname(venvPy), { recursive: true });
      writeFileSync(venvPy, '');
      expect(getFastjudgePython()).toBe(venvPy);
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
    }
  });
});

describe('spawnEnv encoding (zh-CN Windows)', () => {
  it('强制 PYTHONUTF8 / PYTHONIOENCODING=utf-8，不依赖父进程', () => {
    const prevIo = process.env.PYTHONIOENCODING;
    const prevUtf8 = process.env.PYTHONUTF8;
    delete process.env.PYTHONIOENCODING;
    delete process.env.PYTHONUTF8;
    try {
      const e = spawnEnv();
      expect(e.PYTHONUTF8).toBe('1');
      expect(e.PYTHONIOENCODING).toBe('utf-8');
    } finally {
      if (prevIo === undefined) delete process.env.PYTHONIOENCODING;
      else process.env.PYTHONIOENCODING = prevIo;
      if (prevUtf8 === undefined) delete process.env.PYTHONUTF8;
      else process.env.PYTHONUTF8 = prevUtf8;
    }
  });
});
