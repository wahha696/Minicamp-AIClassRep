// 读 .env：不装 dotenv，自己读 ROOT/.env 或 ROOT/app/.env。
// 格式 KEY=VALUE 逐行，`#` 开头忽略；**不覆盖已存在的 process.env**。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.js';

/**
 * 解析 .env 文本 → 键值对。
 * 规则：空行与 `#` 开头忽略；按第一个 `=` 切分；键值两端空白去掉；
 * 值两端配对的引号去掉；没有 `=`、键为空、或引号不配对的行按原样/忽略处理。
 */
export function parseEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq <= 0) continue;
    const key = text.slice(0, eq).trim();
    if (key === '') continue;
    let value = text.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 把 .env 写进 process.env，已存在的键不动（真实环境变量优先） */
export function applyEnvFile(file: string): void {
  if (!existsSync(file)) return;
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(raw))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** 开发时放仓库根，打包后在 app/.env；两个都有就都读，先读到的键优先 */
function loadEnvFiles(): void {
  applyEnvFile(join(ROOT, '.env'));
  applyEnvFile(join(ROOT, 'app', '.env'));
}

loadEnvFiles();

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  LLM_BASE_URL: process.env.LLM_BASE_URL ?? '',
  LLM_API_KEY: process.env.LLM_API_KEY ?? '',
  LLM_MODEL: process.env.LLM_MODEL ?? '',
  DEMO_MODE: (process.env.DEMO_MODE ?? 'true') === 'true',
  RAW_MSG_TTL_DAYS: num(process.env.RAW_MSG_TTL_DAYS, 7),
};
