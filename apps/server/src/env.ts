// 读 .env：不装 dotenv，自己读 ROOT/.env 或 ROOT/app/.env。
// 格式 KEY=VALUE 逐行，`#` 开头忽略；**不覆盖已存在的 process.env**。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.js';

function loadEnvFile(): void {
  const candidates = [join(ROOT, '.env'), join(ROOT, 'app', '.env')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (text === '' || text.startsWith('#')) continue;
      const eq = text.indexOf('=');
      if (eq <= 0) continue;
      const key = text.slice(0, eq).trim();
      let value = text.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnvFile();

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
