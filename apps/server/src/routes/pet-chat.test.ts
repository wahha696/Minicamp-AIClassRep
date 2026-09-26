// /api/pet/chat 的测试：解析/裁剪、人设消息组装、假 LLM 的成功与失败路径、HTTP 壳。
// 不联网：LLM 一律用 fake client 注入。
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { buildPetMessages, parsePetChatBody, petChatReply, registerPetChatRoutes } from './pet-chat.js';

/** 只会按脚本回答/抛错的假 LLM 客户端（形状与 extract.ts 的 LlmClient 一致） */
function fakeClient(reply: string | Error) {
  return {
    chat: {
      completions: {
        create: async () => {
          if (reply instanceof Error) throw reply;
          return { choices: [{ message: { content: reply } }] };
        },
      },
    },
  };
}
type FakeClient = ReturnType<typeof fakeClient>;
const asDeps = (f: ReturnType<typeof fakeClient>) => ({ client: f as unknown as NonNullable<Parameters<typeof petChatReply>[1]>['client'] });

describe('parsePetChatBody：解析与裁剪', () => {
  it('正常消息 + 历史角色映射（bot → assistant）+ 上下文', () => {
    const p = parsePetChatBody({
      message: '明天有什么事',
      history: [
        { role: 'user', text: '你好' },
        { role: 'bot', text: '你好呀' },
      ],
      context: { summary: '今天 2 件事', connect: 'online', events: [{ title: '高数课', time: '14:00', status: 'active' }] },
    });
    expect(p).toEqual({
      message: '明天有什么事',
      history: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '你好呀' },
      ],
      context: { summary: '今天 2 件事', connect: 'online', events: [{ title: '高数课', time: '14:00', status: 'active' }] },
    });
  });

  it('空 message / 非对象 → null', () => {
    expect(parsePetChatBody({ message: '   ' })).toBeNull();
    expect(parsePetChatBody({})).toBeNull();
    expect(parsePetChatBody(null)).toBeNull();
    expect(parsePetChatBody('hi')).toBeNull();
  });

  it('坏历史条目被丢弃，好条目保留', () => {
    const p = parsePetChatBody({ message: 'hi', history: [null, 5, { role: 'weird', text: 'x' }, { role: 'user', text: '在吗' }] });
    expect(p?.history).toEqual([{ role: 'user', text: '在吗' }]);
  });

  it('超长裁剪：message 300、历史 12 条、事件 8 条', () => {
    const p = parsePetChatBody({
      message: '啊'.repeat(500),
      history: Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `m${i}` })),
      context: { events: Array.from({ length: 20 }, (_, i) => ({ title: `事件${i}`, time: '', status: '' })) },
    });
    expect(p?.message.length).toBe(300);
    expect(p?.history.length).toBe(12);
    expect(p?.history.at(-1)?.text).toBe('m29');
    expect(p?.context.events?.length).toBe(8);
  });

  it('没有 title 的事件被过滤掉', () => {
    const p = parsePetChatBody({ message: 'hi', context: { events: [{ title: '', time: 'x', status: 'y' }, { title: '体育课', time: '', status: '' }] } });
    expect(p?.context.events).toEqual([{ title: '体育课', time: '', status: '' }]);
  });
});

describe('buildPetMessages：人设与顺序', () => {
  it('system 在最前、历史居中、user 在最后；不出现采集端品牌词', () => {
    const msgs = buildPetMessages('在吗', [{ role: 'user', text: '你好' }], { summary: '今天 1 件事' });
    expect(msgs[0]!.role).toBe('system');
    expect(msgs.at(-1)).toEqual({ role: 'user', content: '在吗' });
    expect(msgs[1]).toEqual({ role: 'user', content: '你好' });
    for (const m of msgs) expect(String(m.content).toLowerCase()).not.toContain('napcat');
  });

  it('没有任何现场数据时提示（暂无）', () => {
    const msgs = buildPetMessages('嗨', [], {});
    expect(String((msgs[0] as { content: string }).content)).toContain('（暂无）');
  });
});

describe('petChatReply：成功与失败路径', () => {
  it('注入假客户端 → 返回文本', async () => {
    const r = await petChatReply({ message: '讲个笑话', context: { summary: '今天 2 件事' } }, asDeps(fakeClient('今天两件事，好好冲！')));
    expect(r).toEqual({ ok: true, text: '今天两件事，好好冲！' });
  });

  it('LLM 抛错 / 空回答 → 502；缺 message → 400', async () => {
    expect(await petChatReply({ message: '你好' }, asDeps(fakeClient(new Error('boom'))))).toMatchObject({ ok: false, status: 502 });
    expect(await petChatReply({ message: '你好' }, asDeps(fakeClient('')))).toMatchObject({ ok: false, status: 502 });
    expect(await petChatReply({})).toMatchObject({ ok: false, status: 400 });
  });
});

describe('registerPetChatRoutes：HTTP 壳', () => {
  const app = new Hono();
  registerPetChatRoutes(app, asDeps(fakeClient('蹦蹦跳跳~今天没事哦')));

  it('POST 正常返回 { text }', async () => {
    const res = await app.request('/api/pet/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '今天有什么事' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '蹦蹦跳跳~今天没事哦' });
  });

  it('坏 JSON → 400', async () => {
    const res = await app.request('/api/pet/chat', { method: 'POST', body: 'not-json' });
    expect(res.status).toBe(400);
  });
});
