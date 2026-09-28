// 本地快判：同机拉起 classrep-fastjudge 的 infer.py（jieba+TFIDF+CalibratedLR±规则并联），
// 输入/输出对齐 scoreWithJev → number[] | null。失败或缺模型返回 null，由上层回退 LLM。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.js';
import type { Message } from '../types.js';

const DEFAULT_ROOT = '/workspace/classrep-fastjudge';
const DEFAULT_MODEL = 'models/local-jev-v1.joblib';

export function getFastjudgeRoot(): string {
  return env.FASTJUDGE_ROOT.trim() || DEFAULT_ROOT;
}

export function getLocalModelPath(): string {
  const explicit = env.LOCAL_JEV_MODEL_PATH.trim();
  if (explicit) return explicit;
  return join(getFastjudgeRoot(), DEFAULT_MODEL);
}

export function getFastjudgePython(): string {
  const explicit = env.FASTJUDGE_PYTHON.trim();
  if (explicit) return explicit;
  const venvPy = join(getFastjudgeRoot(), '.venv', 'bin', 'python');
  if (existsSync(venvPy)) return venvPy;
  return 'python3';
}

/** 模型文件存在才算本地可用（不检查 python/依赖，调用失败再回退） */
export function localJevAvailable(): boolean {
  return existsSync(getLocalModelPath());
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
  const script = join(root, 'src', 'infer.py');
  if (!existsSync(script)) {
    return Promise.resolve({ scores: null, error: 'infer.py missing' });
  }
  if (!existsSync(model)) {
    return Promise.resolve({ scores: null, error: 'model missing' });
  }

  return new Promise((resolve) => {
    const child = spawn(py, [script, '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
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

/** 与 scoreWithJev 同签名语义：成功 number[]，失败/空候选 null */
export async function scoreWithLocal(
  candidates: Message[],
  context: Message[],
  groupName: string,
): Promise<number[] | null> {
  if (candidates.length === 0) return null;
  if (!localJevAvailable()) return null;

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
    return null;
  }
  // clamp to [0,1]
  return result.scores.map((s) => Math.min(1, Math.max(0, Number.isFinite(s) ? s : 0)));
}
