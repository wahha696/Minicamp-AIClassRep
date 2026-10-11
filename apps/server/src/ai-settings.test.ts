// 修复计划 3.2 验收：AI 配置 —— llm.json 读写、打码提示、Jev key 可选、保存后热更新（version++）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  getAiSettings,
  getJevConfig,
  getLlmConfig,
  maskKey,
  saveAiSettings,
  setLlmSettingsDir,
  testAiConnection,
} from './ai-settings.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'classrep-ai-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

describe('ai-settings（修复计划 3.2）', () => {
  it('候选 Key 检查不保存、不替换原 Key、不改变流水线配置版本', async () => {
    setLlmSettingsDir(tempDir());
    const before = getLlmConfig();
    const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 403 })).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', request);
    try {
      expect(await testAiConnection('deepseek', 'sk-syntheticcandidate')).toEqual({ deepseek: { ok: false, error: 'Key 无效或被拒绝（HTTP 403）' } });
      expect(getLlmConfig()).toEqual(before);
      expect(request.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer sk-syntheticcandidate' });
      expect(await testAiConnection('deepseek', 'sk-syntheticcandidate')).toEqual({ deepseek: { ok: true } });
      expect(getLlmConfig()).toEqual(before);
      expect(getAiSettings().deepseek.source).not.toBe('web');
    } finally { vi.unstubAllGlobals(); }
  });
  it('没文件：两个 key 都不是网页来源（本机 .env 兜底另算）', () => {
    setLlmSettingsDir(tempDir());
    const s = getAiSettings();
    expect(s.deepseek.provider).toBe('deepseek');
    // 开发机上 .env 可能配了 key → source 可能是 env；绝不是 web
    expect(s.jev.source).not.toBe('web');
    expect(s.deepseek.source).not.toBe('web');
  });

  it('保存 deepseek key：打码提示、source=web、version 递增（热更新）', () => {
    const dir = tempDir();
    setLlmSettingsDir(dir);
    const v0 = getLlmConfig().version;
    saveAiSettings({ deepseek_key: 'sk-abcdef1234567890' });
    const s = getAiSettings();
    expect(s.deepseek.configured).toBe(true);
    expect(s.deepseek.source).toBe('web');
    expect(s.deepseek.key_hint).toBe('sk-****7890'); // 只露前三后四
    expect(getLlmConfig().apiKey).toBe('sk-abcdef1234567890');
    expect(getLlmConfig().version).toBeGreaterThan(v0);
  });

  it('jev key：保存 → getJevConfig 生效；传空串清除网页里的那份', () => {
    setLlmSettingsDir(tempDir());
    saveAiSettings({ jev_key: 'ts-key-abcdef' });
    expect(getJevConfig().apiKey).toBe('ts-key-abcdef');
    expect(getAiSettings().jev.source).toBe('web');
    saveAiSettings({ jev_key: '' });
    // 网页存的清掉后回落 .env / 未配置，总之不再是网页那份
    expect(getAiSettings().jev.source).not.toBe('web');
  });

  it('只存 jev 不存 deepseek：llm.json 里两个字段互不影响', () => {
    const dir = tempDir();
    setLlmSettingsDir(dir);
    saveAiSettings({ deepseek_key: 'sk-1111111111' });
    saveAiSettings({ jev_key: 'ts-2222' });
    const raw = JSON.parse(readFileSync(join(dir, 'llm.json'), 'utf8')) as Record<string, unknown>;
    if (process.platform === 'win32' && raw.api_key === undefined) {
      // Windows + DPAPI：密钥只以密文落盘，明文字段不出现（S06）
      expect(typeof raw.api_key_dpapi).toBe('string');
      expect(String(raw.api_key_dpapi)).not.toContain('sk-1111111111');
      expect(raw.typesafe_api_key_dpapi).toBeTruthy();
    } else {
      expect(raw.api_key).toBe('sk-1111111111');
      expect(raw.typesafe_api_key).toBe('ts-2222');
    }
    expect(getLlmConfig().apiKey).toBe('sk-1111111111');
    expect(getJevConfig().apiKey).toBe('ts-2222');
  });

  it('S06：旧版明文 llm.json 读取后被原地升级为 DPAPI 密文（仅 Windows）', () => {
    const dir = tempDir();
    setLlmSettingsDir(dir);
    writeFileSync(join(dir, 'llm.json'), JSON.stringify({ provider: 'deepseek', api_key: 'sk-plain9999' }), 'utf8');
    expect(getLlmConfig().apiKey).toBe('sk-plain9999'); // 明文照样读得出（兼容）
    if (process.platform === 'win32') {
      const raw = JSON.parse(readFileSync(join(dir, 'llm.json'), 'utf8')) as Record<string, unknown>;
      if (raw.api_key_dpapi !== undefined) {
        // DPAPI 可用 → 明文已从磁盘消失
        expect(raw.api_key).toBeUndefined();
        expect(getLlmConfig().apiKey).toBe('sk-plain9999');
      }
    }
  });

  it('坏掉的 llm.json 按「没存过网页 key」处理，不抛', () => {
    const dir = tempDir();
    setLlmSettingsDir(dir);
    writeFileSync(join(dir, 'llm.json'), '{坏掉的', 'utf8');
    const s = getAiSettings();
    expect(s.deepseek.source).not.toBe('web');
    expect(s.jev.source).not.toBe('web');
  });

  it('R8：protection 如实反映落盘形态（明文文件=plain；DPAPI 密文=dpapi；env 来源=none）', () => {
    const dir = tempDir();
    setLlmSettingsDir(dir);
    writeFileSync(join(dir, 'llm.json'), JSON.stringify({ provider: 'deepseek', api_key: 'sk-plain9999' }), 'utf8');
    if (process.platform === 'win32') {
      // Windows + DPAPI 可用时，首次读取（getAiSettings 内部 readSaved）即原地升级为密文；
      // DPAPI 不可用的 Windows 则保持明文降级态。两种都必须如实上报。
      expect(['plain', 'dpapi']).toContain(getAiSettings().deepseek.protection);
      const raw = JSON.parse(readFileSync(join(dir, 'llm.json'), 'utf8')) as Record<string, unknown>;
      expect(getAiSettings().deepseek.protection).toBe(raw.api_key_dpapi !== undefined ? 'dpapi' : 'plain');
    } else {
      // 非 Windows 没有 DPAPI：旧版明文文件必须能看到降级态
      expect(getAiSettings().deepseek.protection).toBe('plain');
    }
    // 没存过网页 key：env 来源不参与本机落盘保护态
    setLlmSettingsDir(tempDir());
    expect(getAiSettings().deepseek.protection).toBe('none');
  });

  it('自定义 OpenAI 兼容服务：保存 base_url/model，切回 DeepSeek 后清掉', () => {
    setLlmSettingsDir(tempDir());
    saveAiSettings({ llm: { provider: 'custom', api_key: 'custom-key-123456', base_url: 'https://llm.example.test/v1/', model: 'qwen-plus' } });
    expect(getLlmConfig()).toMatchObject({ baseURL: 'https://llm.example.test/v1', apiKey: 'custom-key-123456', model: 'qwen-plus' });
    expect(getAiSettings().deepseek).toMatchObject({ provider: 'custom', base_url: 'https://llm.example.test/v1', model: 'qwen-plus', source: 'web' });
    // 同服务商只改模型可以沿用已保存的 key
    saveAiSettings({ llm: { provider: 'custom', base_url: 'https://llm.example.test/v1', model: 'qwen-max' } });
    expect(getLlmConfig()).toMatchObject({ apiKey: 'custom-key-123456', model: 'qwen-max' });
    // 换服务商必须重新给 key；自定义必须有模型
    expect(() => saveAiSettings({ llm: { provider: 'deepseek' } })).toThrow('API Key');
    expect(() => saveAiSettings({ llm: { provider: 'custom', base_url: 'https://x.test/v1', api_key: 'k-1' } })).toThrow('模型');
    saveAiSettings({ deepseek_key: 'sk-abcdef1234567890' });
    expect(getLlmConfig()).toMatchObject({ baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
    expect(getAiSettings().deepseek).toMatchObject({ provider: 'deepseek', base_url: 'https://api.deepseek.com/v1' });
  });

  it('自定义服务检查：模型留空时取 /models 第一个；没有 /models 时用一次对话验证', async () => {
    setLlmSettingsDir(tempDir());
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', request);
    try {
      const base = { provider: 'custom' as const, api_key: 'custom-key', base_url: 'https://llm.example.test/v1' };
      expect(await testAiConnection('deepseek', base)).toEqual({ deepseek: { ok: true, model: 'model-a' } });
      expect(request.mock.calls[0]?.[0]).toBe('https://llm.example.test/v1/models');
      expect(await testAiConnection('deepseek', { ...base, model: 'm' })).toEqual({ deepseek: { ok: true } });
      expect(request.mock.calls[2]?.[0]).toBe('https://llm.example.test/v1/chat/completions');
      expect(await testAiConnection('deepseek', base)).toEqual({ deepseek: { ok: false, error: '该服务不提供模型列表，请手动填写模型名' } });
      expect(getAiSettings().deepseek.source).not.toBe('web'); // 只检查不保存
    } finally { vi.unstubAllGlobals(); }
  });

  it('maskKey：长 key 露前三后四，短 key 全码，空 key 空串', () => {
    expect(maskKey('sk-abcdef1234567890')).toBe('sk-****7890');
    expect(maskKey('short')).toBe('****');
    expect(maskKey('')).toBe('');
  });
});
