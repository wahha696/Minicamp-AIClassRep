// 本地快判：同机拉起 classrep-fastjudge 的 infer.py（jieba+TFIDF+CalibratedLR±规则并联），
// 输入/输出对齐 scoreWithJev → number[] | null。失败或缺模型返回 null，由上层回退 LLM。
// R1：常驻 worker（--serve，模型只加载一次）；崩退/超时自动重 spawn，失败仍走 30s 退避。
// Windows-first：不硬编码 Linux 路径；须显式配置 FASTJUDGE_ROOT / LOCAL_JEV_MODEL_PATH。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.js';
import { ROOT } from '../paths.js';
import type { Message } from '../types.js';

const DEFAULT_MODEL = 'models/local-jev-v1.joblib';

/** 与远端 Jev 同量级：失败后一段时间内跳过本地 spawn，避免每批白等 timeout */
export const LOCAL_JEV_BACKOFF_MS = 30_000;

let localBackoffUntil = 0;

export function getFastjudgeRoot(): string {
  const configured = env.FASTJUDGE_ROOT.trim();
  if (configured) return configured;
  // 免配置约定：把 classrep-fastjudge 放到项目根目录（含 src/infer.py）即自动启用，
  // 不用改 .env；模型默认取 <root>/models/local-jev-v1.joblib，python 探测 .venv。
  const conventional = join(ROOT, 'classrep-fastjudge');
  return existsSync(join(conventional, 'src', 'infer.py')) ? conventional : '';
}

export function getLocalModelPath(): string {
  const explicit = env.LOCAL_JEV_MODEL_PATH.trim();
  if (explicit) return explicit;
  const root = getFastjudgeRoot();
  if (!root) return '';
  return join(root, DEFAULT_MODEL);
}

/** 便携运行时（随包分发 / 首次启动自动供给）：<root>/py/python.exe */
export function getBundledPythonPath(root: string): string {
  return join(root, 'py', 'python.exe');
}

/** bundled py > .venv > 系统 python。打包版没有系统 python 也能跑 */
export function getFastjudgePython(): string {
  const explicit = env.FASTJUDGE_PYTHON.trim();
  if (explicit) return explicit;
  const root = getFastjudgeRoot();
  if (root) {
    const bundled = getBundledPythonPath(root);
    if (existsSync(bundled)) return bundled;
    const winPy = join(root, '.venv', 'Scripts', 'python.exe');
    const nixPy = join(root, '.venv', 'bin', 'python');
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

/** 模型文件存在才算本地已配置（不检查 python/依赖；也不看退避） */
export function localJevAvailable(): boolean {
  const model = getLocalModelPath();
  return model !== '' && existsSync(model);
}

/** 已配置且不在失败退避期内 */
export function localJevReady(now = Date.now()): boolean {
  return localJevAvailable() && now >= localBackoffUntil;
}

/** python 能不能 import 快判依赖（sklearn/jieba/joblib/numpy）；30s 超时按不可用算 */
function pythonUsable(py: string, root: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(py, ['-c', 'import sklearn,jieba,joblib,numpy;print("ok")'], {
      cwd: root, env: spawnEnv(), stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(false); }, 30_000);
    child.stdout.setEncoding('utf8').on('data', (c: string) => { out += c; });
    child.on('error', () => { clearTimeout(timer); done(false); });
    child.on('close', (code) => { clearTimeout(timer); done(code === 0 && out.includes('ok')); });
  });
}

/**
 * 启动时调用：模型已就绪但 python 环境不可用时，后台跑 scripts/fastjudge-setup.mjs 供给
 * （Windows 便携 embed / POSIX venv）。打包版没有 scripts/——环境应随包预装，直接跳过。
 */
export function ensureFastjudgeRuntime(): void {
  const root = getFastjudgeRoot();
  if (!root || !localJevAvailable()) return;
  const py = getFastjudgePython();
  void pythonUsable(py, root)
    .then((ok) => {
      if (ok) return;
      const script = join(ROOT, 'scripts', 'fastjudge-setup.mjs');
      if (!existsSync(script)) return;
      console.warn('[fastjudge] 本地快判 Python 环境缺失，后台供给便携运行时（首次约几分钟）…');
      spawn(process.execPath, [script, '--root', root], { detached: true, stdio: 'ignore' }).unref();
    })
    .catch(() => {});
}

/** 测试用：清掉本地失败退避 */
export function resetLocalJevBackoff(): void {
  localBackoffUntil = 0;
}

/** spawn 子进程时只传最小必要环境，避免把 LLM_API_KEY 等密钥带进 Python */
export function spawnEnv(): NodeJS.ProcessEnv {
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
  // zh-CN Windows 默认 stdin 为 gbk：Node 写 UTF-8 JSON 会被解成乱码，分数静默算错。
  // 必须强制 UTF-8，不能依赖父进程是否碰巧设置了 PYTHONIOENCODING。
  out.PYTHONUTF8 = '1';
  out.PYTHONIOENCODING = 'utf-8';
  // Windows 下 python launcher / 编码常见依赖
  if (process.env.PATHEXT) out.PATHEXT = process.env.PATHEXT;
  if (process.env.COMSPEC) out.COMSPEC = process.env.COMSPEC;
  return out;
}

type InferPayload = {
  group_name: string;
  context: { sender_name: string; text: string }[];
  candidates: { sender_name: string; text: string }[];
};

type InferResult = { scores: number[] | null; error?: string };

// ---------- R1：常驻 worker（--serve） ----------
// 旧实现每次打分都 spawn 新进程（import sklearn 秒级 + joblib.load），与急件 3s 路径不匹配。
// 现在懒启动一个常驻 infer.py --serve 子进程，模型只加载一次；请求按行写 stdin（带 seq），
// 响应按行读回并按 seq 对账（多群并发共享一个 worker，infer 内部串行打分）。
// worker 崩退/超时 → 当批按失败处理（上层 30s 退避 + 回退 LLM），下次调用自动重 spawn。

interface WorkerReq {
  resolve: (r: InferResult) => void;
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
    req.resolve({ scores: null, error });
  }
  w.pending.clear();
}

function handleLine(w: Worker, line: string): void {
  let parsed: { seq?: number | null; scores?: number[] | null; error?: string };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return; // 非 JSON 行（不该出现）：忽略，不打断协议
  }
  const seq = parsed.seq;
  if (typeof seq !== 'number') return;
  const req = w.pending.get(seq);
  if (!req) return; // 已超时
  w.pending.delete(seq);
  clearTimeout(req.timer);
  if (!parsed || !Array.isArray(parsed.scores)) {
    req.resolve({ scores: null, error: parsed?.error || 'bad_output' });
    return;
  }
  req.resolve({ scores: parsed.scores.map((n) => Number(n)) });
}

function spawnWorker(py: string, script: string, model: string): Worker {
  const child = spawn(py, [script, '--model', model, '--serve'], {
    stdio: ['pipe', 'pipe', 'ignore'], // stderr 忽略：jieba 启动日志不进协议，也防缓冲撑大
    env: spawnEnv(),
  });
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
  const onDead = () => {
    if (w.dead) return;
    w.dead = true;
    failAll(w, 'worker_exit');
    if (worker === w) worker = null; // 下次调用重 spawn
  };
  child.on('error', onDead);
  child.on('close', onDead);
  return w;
}

/** 停掉常驻 worker（进程退出 / 测试用）。没有 worker 时是 no-op。 */
export function stopLocalWorker(): void {
  const w = worker;
  worker = null;
  if (!w) return;
  w.dead = true;
  failAll(w, 'worker_stop');
  try {
    w.child.kill('SIGKILL');
  } catch {
    // 已退出
  }
}

function runInfer(payload: InferPayload, timeoutMs: number): Promise<InferResult> {
  const root = getFastjudgeRoot();
  const model = getLocalModelPath();
  const py = getFastjudgePython();
  if (!root) {
    return Promise.resolve({ scores: null, error: 'root_unset' });
  }
  const script = join(root, 'src', 'infer.py');
  if (!existsSync(script)) {
    return Promise.resolve({ scores: null, error: 'infer.py missing' });
  }
  if (!model || !existsSync(model)) {
    return Promise.resolve({ scores: null, error: 'model missing' });
  }

  if (worker === null || worker.dead) worker = spawnWorker(py, script, model);
  const w = worker;

  return new Promise((resolve) => {
    const seq = ++w.seq;
    const timer = setTimeout(() => {
      w.pending.delete(seq);
      resolve({ scores: null, error: 'timeout' });
      // 超时可能意味着 infer 卡死：行协议已不可信，杀掉下次重 spawn（R1 防毒化后续请求）
      stopLocalWorker();
    }, timeoutMs);
    w.pending.set(seq, { resolve, timer });
    // 模型在 serve 循环前就加载好：提前写入的请求排在 stdin 缓冲里，循环开始即被消费
    w.child.stdin!.write(JSON.stringify({ seq, ...payload }) + '\n', (err) => {
      if (!err) return;
      const req = w.pending.get(seq);
      if (!req) return;
      w.pending.delete(seq);
      clearTimeout(req.timer);
      req.resolve({ scores: null, error: 'write' });
      stopLocalWorker(); // EPIPE 等写失败：worker 已不可信
    });
  });
}

/** 与 scoreWithJev 同签名语义：成功 number[]，失败/空候选/退避中 null */
export async function scoreWithLocal(
  candidates: Message[],
  context: Message[],
  groupName: string,
): Promise<number[] | null> {
  if (candidates.length === 0) return null;
  if (!localJevReady()) return null;

  const timeoutMs = Math.max(env.JEV_TIMEOUT_MS, 5_000);
  const result = await runInfer(
    {
      group_name: groupName,
      context: context.map(({ sender_name, text }) => ({ sender_name, text })),
      candidates: candidates.map(({ sender_name, text }) => ({ sender_name, text })),
    },
    timeoutMs,
  );

  if (!result.scores || result.scores.length !== candidates.length) {
    localBackoffUntil = Date.now() + LOCAL_JEV_BACKOFF_MS;
    const why = result.error || (result.scores ? 'length_mismatch' : 'null_scores');
    console.warn(
      `[pipeline] 本地快判失败（${why}），${LOCAL_JEV_BACKOFF_MS / 1000}s 内跳过本地`,
    );
    return null;
  }
  // clamp to [0,1]
  return result.scores.map((s) => Math.min(1, Math.max(0, Number.isFinite(s) ? s : 0)));
}
