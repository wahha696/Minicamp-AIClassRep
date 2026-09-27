// @规则 + 网页配置 AI Key 的测试
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getLlmConfig, maskKey, setLlmSettingsDir } from './ai-settings.js';
import { mentionOf } from './napcat/onebot.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { DATA_DIR } from './paths.js';

describe('mentionOf：@ 规则', () => {
  const me = '2096414091';
  const at = (qq: string) => ({ type: 'at', data: { qq } });
  const text = (t: string) => ({ type: 'text', data: { text: t } });

  it('没有 @ → none（视为全体须知）', () => {
    expect(mentionOf([text('明天下午两点A203开会')], me)).toBe('none');
    expect(mentionOf('纯字符串消息', me)).toBe('none');
  });
  it('@全体成员 → all', () => {
    expect(mentionOf([at('all'), text(' 明天交作业')], me)).toBe('all');
  });
  it('@了我 → me；@别人同时也 @了我 → me', () => {
    expect(mentionOf([at(me), text(' 你的表还没交')], me)).toBe('me');
    expect(mentionOf([at('123'), at(me), text(' 来一下')], me)).toBe('me');
  });
  it('只 @了别人 → other（忽略）', () => {
    expect(mentionOf([at('123456'), text(' 你明天去开会')], me)).toBe('other');
    expect(mentionOf([at('1'), at('2')], me)).toBe('other');
  });
  it('还不知道自己的 QQ 号时，@了人一律放行', () => {
    expect(mentionOf([at('123456')], null)).toBe('me');
  });
  it('坏数据不丢消息', () => {
    expect(mentionOf([null, 5, { type: 'at' }], me)).toBe('other');
    expect(mentionOf(undefined, me)).toBe('none');
  });
});

describe('/api/settings/llm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'classrep-llm-'));
  let app: Hono;
  beforeEach(() => {
    setLlmSettingsDir(mkdtempSync(join(dir, 't-')));
    app = new Hono();
    registerSettingsRoutes(app);
  });
  afterAll(() => setLlmSettingsDir(DATA_DIR));

  const put = (body: unknown) =>
    app.request('/api/settings/llm', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('保存后 GET 只返回打码的 key，配置立即生效', async () => {
    const r = await put({ provider: 'deepseek', api_key: ' sk-abcdef1234567890 ' });
    expect(r.status).toBe(200);
    const dto = await r.json();
    expect(dto).toEqual({ provider: 'deepseek', configured: true, key_hint: 'sk-****7890', source: 'web' });
    expect(JSON.stringify(await (await app.request('/api/settings/llm')).json())).not.toContain('abcdef');
    const cfg = getLlmConfig();
    expect(cfg.apiKey).toBe('sk-abcdef1234567890');
    expect(cfg.baseURL).toBe('https://api.deepseek.com/v1');
  });

  it('每次保存 version 变化（extract 据此重建客户端）', async () => {
    const v0 = getLlmConfig().version;
    await put({ provider: 'deepseek', api_key: 'sk-11111111aaaa' });
    expect(getLlmConfig().version).not.toBe(v0);
  });

  it('写进 llm.json', async () => {
    const d = mkdtempSync(join(dir, 'f-'));
    setLlmSettingsDir(d);
    await put({ provider: 'deepseek', api_key: 'sk-22222222bbbb' });
    expect(JSON.parse(readFileSync(join(d, 'llm.json'), 'utf8'))).toEqual({ provider: 'deepseek', api_key: 'sk-22222222bbbb' });
  });

  it('空 key / 格式不对 / 不支持的服务商 → 400 + 中文 error', async () => {
    for (const body of [{ api_key: '' }, { api_key: 'abc' }, { provider: 'openai', api_key: 'sk-12345678abcd' }]) {
      const r = await put(body);
      expect(r.status).toBe(400);
      expect(typeof ((await r.json()) as { error?: unknown }).error).toBe('string');
    }
    const bad = await app.request('/api/settings/llm', { method: 'PUT', body: 'not json' });
    expect(bad.status).toBe(400);
  });

  it('maskKey', () => {
    expect(maskKey('')).toBe('');
    expect(maskKey('sk-short')).toBe('****');
  });
});
