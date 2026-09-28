// 本地快判：同机拉起 classrep-fastjudge 的 infer.py（jieba+TFIDF+CalibratedLR±规则并联），
// 输入/输出对齐 scoreWithJev → number[] | null。失败或缺模型返回 null，由上层回退 LLM。
// Windows-first：不硬编码 Linux 路径；须显式配置 FASTJUDGE_ROOT / LOCAL_JEV_MODEL_PATH。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.js';
import type { Message } from '../types.js';

const DEFAULT_MODEL = 'models/local-jev-v1.joblib';

/** 与远端 Jev 同量级：失败后一段时间内跳过本地 spawn，避免每批白等 timeout */
export const LOCAL_JEV_BACKOFF_MS = 30_000;

let localBackoffUntil = 0;

export function getFastjudgeRoot(): string {
  return env.FASTJUDGE_ROOT.trim();
}

export function getLocalModelPath(): string {
  const explicit = env.LOCAL_JEV_MODEL_PATH.trim();
  if (explicit) return explicit;
  const root = getFastjudgeRoot();
  if (!root) return '';
  return join(root, DEFAULT_MODEL);
}

/** Windows: .venv\Scripts\python.exe；POSIX: .venv/bin/python；皆无则回落 python/python3 */
export function getFastjudgePython(): string {
  const explicit = env.FASTJUDGE_PYTHON.trim();
  if (explicit) return explicit;
  const root = getFastjudgeRoot();
  if (root) {
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

/** 测试用：清掉本地失败退避 */
export function resetLocalJevBackoff(): void {
  localBackoffUntil = 0;
}

/** spawn 子进程时只传最小必要环境，避免把 LLM_API_KEY 等密钥带进 Python */
function spawnEnv(): NodeJS.ProcessEnv {
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
  if (process.env.PYTHONIOENCODING) out.PYTHONIOENCODING = process.env.PYTHONIOENCODING;
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

  return new Promise((resolve) => {
    const child = spawn(py, [script, '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv(),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: InferResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ scores: null, error: 'timeout' });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish({ scores: null, error: 'spawn' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout.trim() || '{}') as InferResult;
        if (!parsed || !Array.isArray(parsed.scores)) {
          finish({ scores: null, error: parsed?.error || 'bad_output' });
          return;
        }
        finish({ scores: parsed.scores.map((n) => Number(n)) });
      } catch {
        finish({ scores: null, error: stderr.trim() ? 'stderr' : 'parse' });
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
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
