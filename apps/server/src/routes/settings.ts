// /api/settings/*：AI Key（DeepSeek 必填 + Jev 可选）与局域网只读开关。
// 本机才能写（局域网写操作已被 lan-guard 统一 403）；GET 只返回打码后的 key。
import type { Hono } from 'hono';
import {
  getAiSettings,
  getLlmSettings,
  LLM_PROVIDERS,
  saveAiSettings,
  saveLlmSettings,
  testAiConnection,
  type LlmProvider,
} from '../ai-settings.js';
import { llmStats } from '../pipeline/stats.js';
import { lanAddresses } from '../lan-guard.js';
import { currentLanToken, rotateLanToken, setLanEnabled } from '../lan-settings.js';

/** 局域网只读开关：GET 看状态和手机链接；PUT {enabled} 切换；POST /rotate 换 token */
function registerLanRoutes(app: Hono, listeningLan: boolean, port: () => number): void {
  const dto = () => {
    const token = currentLanToken();
    const addrs = lanAddresses();
    return {
      enabled: token !== null,
      // 开关状态和实际监听不一致 = 需要重启后端才生效
      restart_required: (token !== null) !== listeningLan,
      urls: token === null ? [] : addrs.map((a) => `http://${a}:${port()}/?token=${token}`),
    };
  };
  app.get('/api/settings/lan', (c) => c.json(dto()));
  app.put('/api/settings/lan', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof b.enabled !== 'boolean') return c.json({ error: 'enabled 必须是 true/false' }, 400);
    setLanEnabled(b.enabled);
    return c.json(dto());
  });
  app.post('/api/settings/lan/rotate', (c) => {
    rotateLanToken();
    return c.json(dto());
  });
}

const DEEPSEEK_KEY_RE = /^sk-[A-Za-z0-9_-]{8,}$/;

export function registerSettingsRoutes(app: Hono, lan?: { listening: boolean; port: () => number }): void {
  if (lan) registerLanRoutes(app, lan.listening, lan.port);

  // ===== AI 设置（修复计划 3.2）：GET 状态；PUT 保存；POST /test 真实校验 =====

  app.get('/api/settings/ai', (c) => c.json(getAiSettings()));

  // PUT { deepseek_key?: 'sk-...', jev_key?: '...' }：没传的字段不动；jev_key 传空串 = 清除
  app.put('/api/settings/ai', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: '请求格式不对' }, 400);
    }
    const b = (body ?? {}) as { deepseek_key?: unknown; jev_key?: unknown };
    if (b.deepseek_key === undefined && b.jev_key === undefined) {
      return c.json({ error: '没有要保存的内容' }, 400);
    }
    const input: { deepseek_key?: string; jev_key?: string } = {};
    if (b.deepseek_key !== undefined) {
      if (typeof b.deepseek_key !== 'string') return c.json({ error: 'deepseek_key 格式不对' }, 400);
      const key = b.deepseek_key.trim();
      if (!key) return c.json({ error: 'DeepSeek API Key 不能为空' }, 400);
      if (!DEEPSEEK_KEY_RE.test(key)) return c.json({ error: 'API Key 格式不对，应以 sk- 开头' }, 400);
      input.deepseek_key = key;
    }
    if (b.jev_key !== undefined) {
      if (typeof b.jev_key !== 'string') return c.json({ error: 'jev_key 格式不对' }, 400);
      input.jev_key = b.jev_key.trim();
    }
    saveAiSettings(input);
    llmStats.llm = 'ok'; // 换了 key，清掉上一次的失败状态，下次调用再如实更新
    return c.json(getAiSettings());
  });

  // POST /api/settings/ai/test { target?: 'deepseek'|'jev' }：真实调一次（B9：无效 key 不亮绿灯）
  app.post('/api/settings/ai/test', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { target?: unknown } | null;
    const target = b?.target === 'deepseek' || b?.target === 'jev' ? b.target : undefined;
    return c.json(await testAiConnection(target));
  });

  // ===== 兼容旧接口：/api/settings/llm 只剩 DeepSeek（设置页/连接页还在用就继续可用） =====

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
    if (!DEEPSEEK_KEY_RE.test(key)) return c.json({ error: 'API Key 格式不对，应以 sk- 开头' }, 400);
    saveLlmSettings(provider as LlmProvider, key);
    llmStats.llm = 'ok'; // 换了 key，清掉上一次的失败状态，下次调用再如实更新
    return c.json(getLlmSettings());
  });
}
