// 在网页上配置 AI（连接页「AI 接入」卡片）。
// key 存在 data/llm.json（data/ 不进 git），优先级高于 .env；保存后立即生效，不用重启。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';
import { DATA_DIR } from './paths.js';

/** 目前只支持 DeepSeek；以后加别家在这里加一行 */
export const LLM_PROVIDERS = {
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
} as const;
export type LlmProvider = keyof typeof LLM_PROVIDERS;

interface Saved {
  provider: LlmProvider;
  api_key: string;
}

let dir = DATA_DIR;
/** 测试用：换一个临时目录 */
export function setLlmSettingsDir(d: string): void {
  dir = d;
  cache = undefined;
  version++;
}

let cache: Saved | null | undefined;
/** 每次保存 +1，extract.ts 据此重建 OpenAI 客户端 */
let version = 0;

function file(): string {
  return join(dir, 'llm.json');
}

function readSaved(): Saved | null {
  if (cache !== undefined) return cache;
  cache = null;
  try {
    if (existsSync(file())) {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Saved>;
      if (typeof raw.api_key === 'string' && raw.api_key !== '' && raw.provider && raw.provider in LLM_PROVIDERS) {
        cache = { provider: raw.provider, api_key: raw.api_key };
      }
    }
  } catch {
    // 文件坏了按没配处理
  }
  return cache;
}

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  version: number;
}

/** 当前生效的配置：网页保存的优先，其次 .env */
export function getLlmConfig(): LlmConfig {
  const s = readSaved();
  if (s) {
    const p = LLM_PROVIDERS[s.provider];
    return { baseURL: p.baseURL, apiKey: s.api_key, model: p.model, version };
  }
  return { baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL || 'deepseek-chat', version };
}

/** 给前端看：只露出末 4 位 */
export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '****' : `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export interface LlmSettingsDTO {
  provider: LlmProvider;
  configured: boolean;
  key_hint: string;          // 例如 sk-****367f；没配为 ''
  source: 'web' | 'env' | 'none';
}

export function getLlmSettings(): LlmSettingsDTO {
  const s = readSaved();
  if (s) return { provider: s.provider, configured: true, key_hint: maskKey(s.api_key), source: 'web' };
  if (env.LLM_API_KEY) return { provider: 'deepseek', configured: true, key_hint: maskKey(env.LLM_API_KEY), source: 'env' };
  return { provider: 'deepseek', configured: false, key_hint: '', source: 'none' };
}

export function saveLlmSettings(provider: LlmProvider, apiKey: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(), `${JSON.stringify({ provider, api_key: apiKey }, null, 2)}\n`, 'utf8');
  cache = { provider, api_key: apiKey };
  version++;
}
