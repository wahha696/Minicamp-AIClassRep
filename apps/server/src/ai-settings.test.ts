// 修复计划 3.2 验收：AI 配置 —— llm.json 读写、打码提示、Jev key 可选、保存后热更新（version++）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  getAiSettings,
  getJevConfig,
  getLlmConfig,
  maskKey,
  saveAiSettings,
  setLlmSettingsDir,
} from './ai-settings.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'classrep-ai-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('ai-settings（修复计划 3.2）', () => {
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

  it('maskKey：长 key 露前三后四，短 key 全码，空 key 空串', () => {
    expect(maskKey('sk-abcdef1234567890')).toBe('sk-****7890');
    expect(maskKey('short')).toBe('****');
    expect(maskKey('')).toBe('');
  });
});
