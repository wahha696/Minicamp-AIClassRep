// AI 配置（修复计划 3.2）：大模型（必填，默认 DeepSeek，可自定义 OpenAI 兼容服务）+ Jev/TypeSafe（可选）。
// 两个 key 都存在 data/llm.json（data/ 不进 git），优先级高于 .env；保存后立即生效（version++），不用重启。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';
import { DATA_DIR } from './paths.js';
import { dpapiAvailable, protectString, unprotectString } from './secure-store.js';
import { localJevAvailable } from './pipeline/jev-local.js';

/** deepseek = 默认；custom = 任意 OpenAI 兼容服务（用户提供 base_url / api_key，模型可留空自动选） */
export const LLM_PROVIDERS = {
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  custom: { name: '自定义（OpenAI 兼容）', baseURL: '', model: '' },
} as const;
export type LlmProvider = keyof typeof LLM_PROVIDERS;

interface Saved {
  provider?: LlmProvider;
  api_key?: string;
  /** 仅 custom：不是密钥，明文存放 */
  base_url?: string;
  model?: string;
  typesafe_api_key?: string;
}

/** 磁盘上的 llm.json：Windows 下密钥以 *_dpapi（DPAPI CurrentUser）存放；明文字段仅作旧版/降级兼容 */
interface SavedFile {
  provider?: LlmProvider;
  base_url?: string;
  model?: string;
  api_key?: string;
  typesafe_api_key?: string;
  api_key_dpapi?: string;
  typesafe_api_key_dpapi?: string;
}

let dir = DATA_DIR;
/** 测试用：换一个临时目录 */
export function setLlmSettingsDir(d: string): void {
  dir = d;
  cache = undefined;
  version++;
}

let cache: Saved | null | undefined;
/** 每次保存 +1，extract.ts / preferences.ts / pet-chat.ts 据此重建 OpenAI 客户端 */
let version = 0;

function file(): string {
  return join(dir, 'llm.json');
}

/** 读取一个密钥字段：优先 DPAPI 密文（解不开=换用户/换机了，回落明文），再回落明文兼容字段 */
function readKey(raw: SavedFile, encField: 'api_key_dpapi' | 'typesafe_api_key_dpapi', plainField: 'api_key' | 'typesafe_api_key'): string | undefined {
  const enc = raw[encField];
  if (typeof enc === 'string' && enc !== '') {
    const plain = unprotectString(enc);
    if (plain !== null && plain !== '') return plain;
    // 解不开不直接用明文兜底字段——明文字段在已经是真明文时本来就该有值
  }
  const plain = raw[plainField];
  return typeof plain === 'string' && plain !== '' ? plain : undefined;
}

function readSaved(): Saved | null {
  if (cache !== undefined) return cache;
  cache = null;
  try {
    if (existsSync(file())) {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<SavedFile>;
      const out: Saved = {};
      const apiKey = readKey(raw, 'api_key_dpapi', 'api_key');
      if (apiKey) {
        out.provider = raw.provider && raw.provider in LLM_PROVIDERS ? raw.provider : 'deepseek';
        out.api_key = apiKey;
        if (out.provider === 'custom') {
          if (typeof raw.base_url === 'string') out.base_url = raw.base_url;
          if (typeof raw.model === 'string') out.model = raw.model;
        }
      }
      const jevKey = readKey(raw, 'typesafe_api_key_dpapi', 'typesafe_api_key');
      if (jevKey) out.typesafe_api_key = jevKey;
      if (out.api_key || out.typesafe_api_key) {
        cache = out;
        // S06：文件里还躺着明文密钥且 DPAPI 可用 → 原地升级成加密存储
        if (dpapiAvailable() && (raw.api_key || raw.typesafe_api_key)) persist(out);
      }
    }
  } catch {
    // 文件坏了按没配处理
  }
  return cache;
}

/** 写盘：DPAPI 可用就只写密文字段（明文绝不落盘），不可用退回明文（README 已声明） */
function persist(s: Saved): void {
  const out: SavedFile = { provider: s.provider };
  if (s.provider === 'custom') { out.base_url = s.base_url; out.model = s.model; }
  if (dpapiAvailable()) {
    if (s.api_key) {
      const enc = protectString(s.api_key);
      if (enc) out.api_key_dpapi = enc;
      else out.api_key = s.api_key; // 加密失败退回明文，不让配置丢失
    }
    if (s.typesafe_api_key) {
      const enc = protectString(s.typesafe_api_key);
      if (enc) out.typesafe_api_key_dpapi = enc;
      else out.typesafe_api_key = s.typesafe_api_key;
    }
  } else {
    if (s.api_key) out.api_key = s.api_key;
    if (s.typesafe_api_key) out.typesafe_api_key = s.typesafe_api_key;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  version: number;
}

/** 当前生效的大模型配置：网页保存的优先，其次 .env */
export function getLlmConfig(): LlmConfig {
  const s = readSaved();
  if (s?.api_key) {
    if (s.provider === 'custom') return { baseURL: s.base_url ?? '', apiKey: s.api_key, model: s.model ?? '', version };
    const p = LLM_PROVIDERS.deepseek;
    return { baseURL: p.baseURL, apiKey: s.api_key, model: p.model, version };
  }
  return { baseURL: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL || 'deepseek-chat', version };
}

export interface JevConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** ENABLE_JEV 总开关（.env）；关掉时即使配了 key 也不调用 */
  enabled: boolean;
}

/** 当前生效的 Jev/TypeSafe 配置：网页保存的优先，其次 .env（热更新，不用重启） */
export function getJevConfig(): JevConfig {
  const s = readSaved();
  return {
    apiKey: s?.typesafe_api_key ?? env.TYPESAFE_API_KEY,
    model: env.JEV_MODEL,
    timeoutMs: env.JEV_TIMEOUT_MS,
    enabled: env.ENABLE_JEV,
  };
}

/** 给前端看：只露出末 4 位 */
export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '****' : `${key.slice(0, 3)}****${key.slice(-4)}`;
}

// ===== 对外 DTO =====

export interface LlmSettingsDTO {
  provider: LlmProvider;
  configured: boolean;
  key_hint: string;          // 例如 sk-****367f；没配为 ''
  source: 'web' | 'env' | 'none';
  /** 实际落盘保护态（R8/P1-06）：dpapi=DPAPI 密文；plain=降级明文（界面必须提示，不许静默降级）；none=未配置 */
  protection: 'dpapi' | 'plain' | 'none';
}

/** 当前 llm.json 的实际保护形态（看磁盘上的字段，不看缓存）：密文字段在 = dpapi；只有明文字段 = plain */
function storedProtection(): LlmSettingsDTO['protection'] {
  try {
    if (!existsSync(file())) return 'none';
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<SavedFile>;
    if (raw.api_key_dpapi) return 'dpapi';
    if (raw.api_key) return 'plain';
    return 'none';
  } catch {
    return 'none';
  }
}

export function getLlmSettings(): LlmSettingsDTO {
  const s = readSaved();
  const protection = storedProtection();
  if (s?.api_key) {
    return { provider: s.provider ?? 'deepseek', configured: true, key_hint: maskKey(s.api_key), source: 'web', protection };
  }
  // .env 里改了 LLM_BASE_URL 也按自定义展示
  if (env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_BASE_URL !== LLM_PROVIDERS.deepseek.baseURL) {
    return { provider: 'custom', configured: true, key_hint: maskKey(env.LLM_API_KEY), source: 'env', protection: 'none' };
  }
  if (env.LLM_API_KEY) return { provider: 'deepseek', configured: true, key_hint: maskKey(env.LLM_API_KEY), source: 'env', protection: 'none' };
  return { provider: 'deepseek', configured: false, key_hint: '', source: 'none', protection: 'none' };
}

export interface AiKeyStatus {
  configured: boolean;
  key_hint: string;
  source: 'web' | 'env' | 'none';
}

export interface AiSettingsDTO {
  /** 字段名沿用 deepseek（兼容旧前端）；实际是当前大模型配置，provider=custom 时带 base_url/model */
  deepseek: AiKeyStatus & { provider: LlmProvider; protection: LlmSettingsDTO['protection']; base_url: string; model: string };
  // enabled = ENABLE_JEV 总开关；mode/local_configured 供前端区分远端/本地/双路展示
  jev: AiKeyStatus & { enabled: boolean; mode: 'jev' | 'local' | 'dual'; local_configured: boolean };
}

/** GET /api/settings/ai：两个 key 的状态（只给打码提示，不回传明文） */
export function getAiSettings(): AiSettingsDTO {
  const s = readSaved();
  const llm = getLlmSettings();
  const mode = env.FASTJUDGE_MODE;
  const local_configured = localJevAvailable();
  const jev: AiSettingsDTO['jev'] = s?.typesafe_api_key
    ? { configured: true, key_hint: maskKey(s.typesafe_api_key), source: 'web', enabled: env.ENABLE_JEV, mode, local_configured }
    : env.TYPESAFE_API_KEY
      ? { configured: true, key_hint: maskKey(env.TYPESAFE_API_KEY), source: 'env', enabled: env.ENABLE_JEV, mode, local_configured }
      : { configured: false, key_hint: '', source: 'none', enabled: env.ENABLE_JEV, mode, local_configured };
  const cfg = getLlmConfig();
  return {
    deepseek: { provider: llm.provider, configured: llm.configured, key_hint: llm.key_hint, source: llm.source, protection: llm.protection,
      base_url: llm.configured ? cfg.baseURL || LLM_PROVIDERS.deepseek.baseURL : '', model: llm.configured ? cfg.model : '' },
    jev,
  };
}

export interface LlmInput {
  provider: LlmProvider;
  /** 省略 = 沿用已保存的 key（仅当服务商不变时） */
  api_key?: string;
  base_url?: string;
  model?: string;
}

/** 去掉末尾的 /，便于拼接 /models、/chat/completions */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 把候选配置补全成完整配置；缺 key 且不能沿用时返回错误文案 */
function resolveLlmInput(input: LlmInput): { baseURL: string; apiKey: string; model: string } | string {
  const cur = readSaved();
  const apiKey = input.api_key ?? (cur?.provider === input.provider || (!cur?.provider && input.provider === 'deepseek') ? getLlmConfig().apiKey : '');
  if (!apiKey) return '请填写 API Key';
  if (input.provider === 'deepseek') return { baseURL: LLM_PROVIDERS.deepseek.baseURL, apiKey, model: LLM_PROVIDERS.deepseek.model };
  const baseURL = normalizeBaseUrl(input.base_url ?? '');
  if (!baseURL) return '请填写接口地址（base_url）';
  return { baseURL, apiKey, model: (input.model ?? '').trim() };
}

/**
 * 保存 key。deepseek_key 传了就必须非空（必填）；jev_key 传空串 = 清除（可选）。
 * llm 用于切换服务商 / 自定义接入；没传的字段保持原值。
 */
export function saveAiSettings(input: { deepseek_key?: string; jev_key?: string; llm?: LlmInput }): void {
  const cur = readSaved() ?? {};
  const next: Saved = { ...cur };
  if (input.deepseek_key !== undefined) {
    next.provider = 'deepseek';
    next.api_key = input.deepseek_key;
    delete next.base_url; delete next.model;
  }
  if (input.llm !== undefined) {
    const r = resolveLlmInput(input.llm);
    if (typeof r === 'string') throw new Error(r);
    if (input.llm.provider === 'custom' && !r.model) throw new Error('请填写模型名');
    next.provider = input.llm.provider;
    next.api_key = r.apiKey;
    if (input.llm.provider === 'custom') { next.base_url = r.baseURL; next.model = r.model; }
    else { delete next.base_url; delete next.model; }
  }
  if (input.jev_key !== undefined) {
    if (input.jev_key === '') delete next.typesafe_api_key;
    else next.typesafe_api_key = input.jev_key;
  }
  persist(next);
  cache = next.api_key || next.typesafe_api_key ? next : null;
  version++;
}

/** 兼容旧调用：只保存 DeepSeek key（Jev key 保持原值） */
export function saveLlmSettings(provider: LlmProvider, apiKey: string): void {
  const cur = readSaved() ?? {};
  const next: Saved = { ...cur, provider, api_key: apiKey };
  persist(next);
  cache = next;
  version++;
}

// ===== /test 真实校验（B9：保存前用真实请求验活，无效 key 不亮绿灯） =====

const TEST_TIMEOUT_MS = 10_000;

export interface LlmTestResult { ok: boolean; error?: string; /** custom 且没填模型时，自动选中的模型 */ model?: string }

async function testDeepseek(candidateKey?: string): Promise<LlmTestResult> {
  const cfg = getLlmConfig();
  if (candidateKey !== undefined) return testLlm({ provider: 'deepseek', api_key: candidateKey });
  if (!cfg.apiKey) return { ok: false, error: '还没填 DeepSeek API Key' };
  return probeLlm(cfg.baseURL || LLM_PROVIDERS.deepseek.baseURL, cfg.apiKey, cfg.model, cfg.baseURL !== '' && cfg.baseURL !== LLM_PROVIDERS.deepseek.baseURL);
}

/** 测一份候选配置（不保存、不改当前配置） */
export async function testLlm(input: LlmInput): Promise<LlmTestResult> {
  const r = resolveLlmInput(input);
  if (typeof r === 'string') return { ok: false, error: r };
  return probeLlm(r.baseURL, r.apiKey, r.model, input.provider === 'custom');
}

/**
 * 先 GET /models 验 key；自定义服务没填模型时取列表第一个。
 * 有的兼容服务不提供 /models（404/405），填了模型时改用一次 1 token 的对话验证。
 */
async function probeLlm(baseURL: string, apiKey: string, model: string, custom: boolean): Promise<LlmTestResult> {
  const label = custom ? '该服务' : 'DeepSeek';
  const headers = { Authorization: `Bearer ${apiKey}` };
  const denied = (status: number) => ({ ok: false, error: `Key 无效或被拒绝（HTTP ${status}）` });
  try {
    const res = await fetch(`${baseURL}/models`, { headers, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) return denied(res.status);
    if (res.ok) {
      if (!custom || model) return { ok: true };
      const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
      const first = body?.data?.find((m) => typeof m.id === 'string')?.id as string | undefined;
      return first ? { ok: true, model: first } : { ok: false, error: '服务没有返回可用模型，请手动填写模型名' };
    }
    if (!custom || (res.status !== 404 && res.status !== 405)) return { ok: false, error: `服务返回 HTTP ${res.status}` };
    if (!model) return { ok: false, error: '该服务不提供模型列表，请手动填写模型名' };
    const chat = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (chat.status === 401 || chat.status === 403) return denied(chat.status);
    return chat.ok ? { ok: true } : { ok: false, error: `服务返回 HTTP ${chat.status}` };
  } catch (e) {
    return { ok: false, error: `连不上${label}：${e instanceof Error ? e.message : String(e)}` };
  }
}

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

async function testJev(): Promise<{ ok: boolean; error?: string }> {
  const cfg = getJevConfig();
  if (!cfg.apiKey) return { ok: false, error: '还没填 Jev API Key' };
  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        state: { group_name: '测试群', previous_messages: [], messages: [{ sender_name: '测试', text: '明天下午三点开会' }] },
        questions: {
          m0: {
            type: 'noul',
            instructions: '`messages[0]` 是否提供可能影响学生日程或待办的具体信息？',
            criteria: { true: '考试、作业、会议、活动、通知的时间地点要求。', false: '纯闲聊、无时间信息。' },
          },
        },
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'Key 无效或被拒绝（HTTP 401）' };
      return { ok: false, error: `服务返回 HTTP ${res.status}` };
    }
    const body = (await res.json()) as { answers?: Record<string, { type?: string; noul?: number }> };
    const a = body?.answers?.m0;
    if (a?.type === 'noul' && typeof a.noul === 'number') return { ok: true };
    return { ok: false, error: '返回格式不对（服务异常）' };
  } catch (e) {
    return { ok: false, error: `连不上 Jev：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** POST /api/settings/ai/test：真实调一次对应服务；target 省略则两个都测 */
export async function testAiConnection(
  target?: 'deepseek' | 'jev',
  candidate?: string | LlmInput,
): Promise<{ deepseek?: LlmTestResult; jev?: { ok: boolean; error?: string } }> {
  const out: { deepseek?: LlmTestResult; jev?: { ok: boolean; error?: string } } = {};
  if (target === undefined || target === 'deepseek') {
    out.deepseek = typeof candidate === 'object' ? await testLlm(candidate) : await testDeepseek(candidate);
  }
  if (target === undefined || target === 'jev') out.jev = await testJev();
  return out;
}
