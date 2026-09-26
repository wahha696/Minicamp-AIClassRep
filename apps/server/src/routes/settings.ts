// /api/settings/llm：连接页「AI 接入」卡片读写 API Key。
// 本机才能写（局域网写操作已被 lan-guard 统一 403）；GET 只返回打码后的 key。
import type { Hono } from 'hono';
import { LLM_PROVIDERS, getLlmSettings, saveLlmSettings, type LlmProvider } from '../llm-settings.js';
import { llmStats } from '../pipeline/stats.js';

export function registerSettingsRoutes(app: Hono): void {
  app.get('/api/settings/llm', (c) => c.json(getLlmSettings()));

  // PUT { provider: 'deepseek', api_key: 'sk-...' } → LlmSettingsDTO
  app.put('/api/settings/llm', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求格式不对' }, 400);
    }
    const b = (body ?? {}) as { provider?: unknown; api_key?: unknown };
    const provider = typeof b.provider === 'string' ? b.provider : 'deepseek';
    if (!(provider in LLM_PROVIDERS)) return c.json({ error: '暂不支持这个 AI 服务商' }, 400);
    const key = typeof b.api_key === 'string' ? b.api_key.trim() : '';
    if (!key) return c.json({ error: 'API Key 不能为空' }, 400);
    if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) return c.json({ error: 'API Key 格式不对，应以 sk- 开头' }, 400);
    saveLlmSettings(provider as LlmProvider, key);
    llmStats.llm = 'ok'; // 换了 key，清掉上一次的失败状态，下次调用再如实更新
    return c.json(getLlmSettings());
  });
}
