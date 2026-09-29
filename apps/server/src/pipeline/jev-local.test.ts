import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('未配置 ROOT/MODEL 时 root 空、model 空、不可用', () => {
    expect(getFastjudgeRoot()).toBe('');
    expect(getLocalModelPath()).toBe('');
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

  it('未设 PYTHON 时回落平台默认解释器名（不假装存在 venv）', () => {
    const py = getFastjudgePython();
    expect(py === 'python' || py === 'python3').toBe(true);
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
