// 本地 Scene Extractor：常驻拉起 classrep-extractor 的 scripts/infer_serve.py --serve
// （Unsloth 4bit + LoRA v4-DFG）。prompt / postprocess 全在 Python 侧（prompt_extract +
// strip→time→title→fp→safety），本模块只做 JSONL 协议，把原始 {"events":[...]} 字符串交回。
// EXTRACT_MODE=local 时由 extract.ts 的 extractOnce 分支调用；默认 cloud，互不影响。
// 注意：不 import extract.js（避免与 extract → extract-local 循环依赖）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.js';
import type { Message } from '../types.js';

/** 与 ExtractInput / ActiveEventBrief 对齐的最小结构（避免从 extract.js 拉运行时依赖） */
export interface LocalExtractInput {
  groupId: string;
  groupName: string;
  candidates: Message[];
  context: Message[];
  now: number;
  activeEvents: {
    id: number;
    type: string;
    title: string;
    start_at: number | null;
    end_at: number | null;
    deadline_at: number | null;
    location: string | null;
    action_required: string | null;
    level: number;
  }[];
}

/** 本地提取失败后短暂跳过，避免每批白等 GPU 加载 / 超时 */
export const LOCAL_EXTRACT_BACKOFF_MS = 30_000;

const DEFAULT_ADAPTER = 'runs/qwen3-1.7b-qlora-v4-time';
const DEFAULT_BASE = 'unsloth/Qwen3-1.7B-bnb-4bit';

let localBackoffUntil = 0;

export function getExtractorRoot(): string {
  return env.EXTRACTOR_ROOT.trim();
}

export function getExtractAdapter(): string {
  const explicit = env.EXTRACT_ADAPTER.trim();
  if (explicit) return explicit;
  const root = getExtractorRoot();
  if (!root) return '';
  return join(root, DEFAULT_ADAPTER);
}

export function getExtractBase(): string {
  return env.EXTRACT_BASE.trim() || DEFAULT_BASE;
}

/** Windows: env\Scripts\python.exe；POSIX: env/bin/python；皆无则回落 python/python3 */
export function getExtractorPython(): string {
  const explicit = env.EXTRACTOR_PYTHON.trim();
  if (explicit) return explicit;
  const root = getExtractorRoot();
  if (root) {
    const winPy = join(root, 'env', 'Scripts', 'python.exe');
    const nixPy = join(root, 'env', 'bin', 'python');
    if (process.platform === 'win32') {
      if (existsSync(winPy)) return winPy;
      if (existsSync(nixPy)) return nixPy;
    } else {
      if (existsSync(nixPy)) return nixPy;
      if (existsSync(winPy)) return winPy;
    }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function localExtractAvailable(): boolean {
  const root = getExtractorRoot();
  if (!root) return false;
  const script = join(root, 'scripts', 'infer_serve.py');
  if (!existsSync(script)) return false;
  const adapter = getExtractAdapter();
  if (!adapter || !existsSync(adapter)) return false;
  return true;
}

export function localExtractReady(now = Date.now()): boolean {
  return localExtractAvailable() && now >= localBackoffUntil;
}

export function resetLocalExtractBackoff(): void {
  localBackoffUntil = 0;
}

/** spawn 子进程时只传最小必要环境，避免把 LLM_API_KEY 带进 Python */
export function spawnExtractEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (process.env.PATH) out.PATH = process.env.PATH;
  if (process.env.Path) out.Path = process.env.Path;
  if (process.env.SYSTEMROOT) out.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.SystemRoot) out.SystemRoot = process.env.SystemRoot;
  if (process.env.WINDIR) out.WINDIR = process.env.WINDIR;
  if (process.env.TEMP) out.TEMP = process.env.TEMP;
  if (process.env.TMP) out.TMP = process.env.TMP;
  if (process.env.LANG) out.LANG = process.env.LANG;
  if (process.env.LC_ALL) out.LC_ALL = process.env.LC_ALL;
  if (process.env.PYTHONPATH) out.PYTHONPATH = process.env.PYTHONPATH;
  if (process.env.CUDA_VISIBLE_DEVICES) out.CUDA_VISIBLE_DEVICES = process.env.CUDA_VISIBLE_DEVICES;
  if (process.env.HF_HOME) out.HF_HOME = process.env.HF_HOME;
  if (process.env.HUGGINGFACE_HUB_CACHE) out.HUGGINGFACE_HUB_CACHE = process.env.HUGGINGFACE_HUB_CACHE;
  out.PYTHONUTF8 = '1';
  out.PYTHONIOENCODING = 'utf-8';
  if (process.env.PATHEXT) out.PATHEXT = process.env.PATHEXT;
  if (process.env.COMSPEC) out.COMSPEC = process.env.COMSPEC;
  const adapter = getExtractAdapter();
  const base = getExtractBase();
  if (adapter) out.EXTRACT_ADAPTER = adapter;
  if (base) out.EXTRACT_BASE = base;
  return out;
}

export type LocalServeResult = {
  /** 成功时为 {"events":[...]} 字符串（已过 Python 侧全套 postprocess） */
  json: string | null;
  truncated?: boolean;
  error?: string;
};

interface WorkerReq {
  resolve: (r: LocalServeResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Worker {
  child: ReturnType<typeof spawn>;
  pending: Map<number, WorkerReq>;
  buf: string;
  seq: number;
  dead: boolean;
}

let worker: Worker | null = null;

function failAll(w: Worker, error: string): void {
  for (const [, req] of w.pending) {
    clearTimeout(req.timer);
    req.resolve({ json: null, error });
  }
  w.pending.clear();
}

function handleLine(w: Worker, line: string): void {
  let parsed: {
    seq?: number | null;
    json?: string;
    truncated?: boolean;
    error?: string;
  };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return;
  }
  const seq = parsed.seq;
  if (typeof seq !== 'number') return;
  const req = w.pending.get(seq);
  if (!req) return;
  w.pending.delete(seq);
  clearTimeout(req.timer);
  if (parsed.error) {
    req.resolve({ json: null, error: parsed.error });
    return;
  }
  if (typeof parsed.json !== 'string') {
    req.resolve({ json: null, error: 'bad_output' });
    return;
  }
  req.resolve({ json: parsed.json, truncated: !!parsed.truncated });
}

function spawnWorker(py: string, script: string, root: string, adapter: string, base: string): Worker {
  const child = spawn(
    py,
    [script, '--serve', '--adapter', adapter, '--base', base],
    {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnExtractEnv(),
    },
  );
  const w: Worker = { child, pending: new Map(), buf: '', seq: 0, dead: false };
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    w.buf += chunk;
    let idx: number;
    while ((idx = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, idx).trim();
      w.buf = w.buf.slice(idx + 1);
      if (line) handleLine(w, line);
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    const t = chunk.trim();
    if (!t) return;
    console.warn(`[extract-local] ${t.slice(0, 500)}`);
  });
  const onDead = () => {
    if (w.dead) return;
    w.dead = true;
    failAll(w, 'worker_exit');
    if (worker === w) worker = null;
  };
  child.on('error', onDead);
  child.on('close', onDead);
  return w;
}

/** 停掉常驻 worker（进程退出 / 测试用） */
export function stopLocalExtractWorker(): void {
  const w = worker;
  worker = null;
  if (!w) return;
  w.dead = true;
  failAll(w, 'worker_stop');
  try {
    w.child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

function toSample(input: LocalExtractInput): Record<string, unknown> {
  const msg = (m: Message) => ({
    message_id: m.message_id,
    text: m.text,
    sent_at: m.sent_at,
    sender_name: m.sender_name,
    group_id: m.group_id,
    group_name: m.group_name,
  });
  return {
    group_id: input.groupId,
    group_name: input.groupName,
    now: input.now,
    candidates: input.candidates.map(msg),
    context: input.context.map(msg),
    active_events: input.activeEvents.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      start_at: e.start_at,
      end_at: e.end_at,
      deadline_at: e.deadline_at,
      location: e.location,
      action_required: e.action_required,
      level: e.level,
    })),
  };
}

function runServe(sample: Record<string, unknown>, timeoutMs: number): Promise<LocalServeResult> {
  const root = getExtractorRoot();
  const py = getExtractorPython();
  const adapter = getExtractAdapter();
  const base = getExtractBase();
  if (!root) return Promise.resolve({ json: null, error: 'root_unset' });
  const script = join(root, 'scripts', 'infer_serve.py');
  if (!existsSync(script)) return Promise.resolve({ json: null, error: 'infer_serve.py missing' });
  if (!adapter || !existsSync(adapter)) {
    return Promise.resolve({ json: null, error: 'adapter missing' });
  }

  if (worker === null || worker.dead) {
    worker = spawnWorker(py, script, root, adapter, base);
  }
  const w = worker;

  return new Promise((resolve) => {
    const seq = ++w.seq;
    const timer = setTimeout(() => {
      w.pending.delete(seq);
      resolve({ json: null, error: 'timeout' });
      stopLocalExtractWorker();
    }, timeoutMs);
    w.pending.set(seq, { resolve, timer });
    w.child.stdin!.write(JSON.stringify({ seq, sample }) + '\n', (err) => {
      if (!err) return;
      const req = w.pending.get(seq);
      if (!req) return;
      w.pending.delete(seq);
      clearTimeout(req.timer);
      req.resolve({ json: null, error: 'write' });
      stopLocalExtractWorker();
    });
  });
}

/**
 * 向常驻 infer_serve 发一批样本，拿回原始 JSON 字符串。
 * 失败时触发退避；调用方负责 parseExtraction / llmFailed / 截断拆批。
 */
export async function requestLocalExtract(input: LocalExtractInput): Promise<LocalServeResult> {
  if (input.candidates.length === 0) {
    return { json: JSON.stringify({ events: [] }) };
  }
  if (!localExtractReady()) {
    return { json: null, error: 'not_ready' };
  }
  const timeoutMs = Math.max(env.EXTRACT_TIMEOUT_MS, 30_000);
  const result = await runServe(toSample(input), timeoutMs);
  if (!result.json) {
    localBackoffUntil = Date.now() + LOCAL_EXTRACT_BACKOFF_MS;
  }
  return result;
}
