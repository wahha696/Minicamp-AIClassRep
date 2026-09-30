import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { env } from '../env.js';
import type { Message } from '../types.js';
import {
  getFastjudgePython,
  getFastjudgeRoot,
  getLocalModelPath,
  localJevAvailable,
  localJevReady,
  resetLocalJevBackoff,
  scoreWithLocal,
  spawnEnv,
  stopLocalWorker,
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

// ===== R1：常驻 worker（--serve） =====
// 假 infer：Node 脚本实现同样的「按行 JSON + seq 对账」协议；
// 每次启动向 marker 文件追加一行，据此统计 spawn 次数（复用 vs 重 spawn）。

function makeFakeRoot(mode: 'ok' | 'short'): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fj-fake-'));
  const marker = join(dir, 'spawns.log');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'models'), { recursive: true });
  writeFileSync(join(dir, 'models', 'local-jev-v1.joblib'), 'fake');
  writeFileSync(
    join(dir, 'src', 'infer.py'),
    `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(marker)}, 'spawn\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      const scores = ${mode === 'short' ? '[0.5]' : 'p.candidates.map(() => 0.7)'};
      process.stdout.write(JSON.stringify({ seq: p.seq, scores }) + '\\n');
    } catch { /* 坏行忽略 */ }
  }
});
`,
  );
  return { dir, marker };
}

const msg = (id: string, text: string): Message =>
  ({ message_id: id, group_id: 'g1', group_name: 'g', sender_name: 'a', text, sent_at: 1 }) as Message;

describe('R1：常驻 worker（--serve 行协议）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    stopLocalWorker();
    resetLocalJevBackoff();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  });

  function setup(mode: 'ok' | 'short'): { marker: string } {
    const { dir, marker } = makeFakeRoot(mode);
    dirs.push(dir);
    env.FASTJUDGE_ROOT = dir;
    env.FASTJUDGE_PYTHON = process.execPath; // 用 node 跑假 infer，测试不加载真模型
    return { marker };
  }

  it('两批连续打分复用同一个 worker（模型进程只起一次）', async () => {
    const { marker } = setup('ok');
    const batch = [msg('m1', '明天下午三点开会'), msg('m2', '哈哈')];
    expect(await scoreWithLocal(batch, [], 'g')).toEqual([0.7, 0.7]);
    expect(await scoreWithLocal([msg('m3', 'ddl 明天交作业')], [], 'g')).toEqual([0.7]);
    const spawns = readFileSync(marker, 'utf8').trim().split('\n').length;
    expect(spawns).toBe(1);
  });

  it('worker 崩退/被停后自动重 spawn，打分不丢', async () => {
    const { marker } = setup('ok');
    expect(await scoreWithLocal([msg('m1', '明天考试')], [], 'g')).toEqual([0.7]);
    stopLocalWorker(); // 模拟 worker 死亡
    expect(await scoreWithLocal([msg('m2', '明天考试')], [], 'g')).toEqual([0.7]);
    const spawns = readFileSync(marker, 'utf8').trim().split('\n').length;
    expect(spawns).toBe(2);
  });

  it('响应长度与候选数不符 → 返回 null 并进入 30s 退避（回退 LLM 的老行为不变）', async () => {
    setup('short'); // 假 infer 永远只回 1 个分数
    const batch = [msg('m1', '明天考试'), msg('m2', '记得带学生证')];
    expect(await scoreWithLocal(batch, [], 'g')).toBeNull();
    expect(localJevReady()).toBe(false); // 退避中
  });
});
