// 读 .env：不装 dotenv，自己读 ROOT/.env 或 ROOT/app/.env。
// 格式 KEY=VALUE 逐行，`#` 开头忽略；**不覆盖已存在的 process.env**。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.js';

/** D9：值里 ` #` 之后的内容是行内注释，截掉；引号内的 # 保留 */
function stripComment(raw: string): string {
  let quote = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote !== '') {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && i > 0 && /\s/.test(raw[i - 1]!)) return raw.slice(0, i);
  }
  return raw;
}

/**
 * 解析 .env 文本 → 键值对。
 * 规则：空行与 `#` 开头忽略；按第一个 `=` 切分；键值两端空白去掉；
 * 值两端配对的引号去掉；值中 ` #` 之后是行内注释（引号内的 # 不算）；
 * 没有 `=`、键为空、或引号不配对的行按原样/忽略处理。
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
    let value = stripComment(text.slice(eq + 1)).trim();
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

/** 正数才采用；空串、0、负数、非数字一律回落默认值（TTL=0 会把原始消息全删光） */
function positiveNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 从一组环境变量算出 env（纯函数，测试直接喂对象，不依赖真实 process.env / .env） */
export function buildEnv(src: Record<string, string | undefined>) {
  return {
    LLM_BASE_URL: src.LLM_BASE_URL ?? '',
    LLM_API_KEY: src.LLM_API_KEY ?? '',
    LLM_MODEL: src.LLM_MODEL ?? '',
    ENABLE_JEV: (src.ENABLE_JEV ?? 'true').trim().toLowerCase() === 'true',
    TYPESAFE_API_KEY: src.TYPESAFE_API_KEY ?? '',
    JEV_MODEL: src.JEV_MODEL?.trim() || 'jev-latest',
    JEV_TIMEOUT_MS: positiveNum(src.JEV_TIMEOUT_MS, 3_000),
    // B10：演示模式默认关闭（演示数据会进真实群列表），开发者要用在 .env 里显式开
    DEMO_MODE: (src.DEMO_MODE ?? 'false').trim() === 'true',
    RAW_MSG_TTL_DAYS: positiveNum(src.RAW_MSG_TTL_DAYS, 7),
  };
}

export const env = buildEnv(process.env);
