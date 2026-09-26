// D0 自测：mock 数据满足 D-前端.md 的要求；真实 client 的路径/请求体符合总约定 §7，出错抛 error 字段。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mock.ts 用到 localStorage（node 环境没有），给一个内存版
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});

async function loadClient(mock: boolean) {
  vi.resetModules();
  vi.stubEnv('VITE_MOCK', mock ? '1' : '');
  return import('./client');
}

describe('mock 模式', () => {
  beforeEach(() => store.clear());

  it('VITE_MOCK=1 时走 mock', async () => {
    const c = await loadClient(true);
    expect(c.isMock).toBe(true);
  });

  it('今日：有摘要、只含今天、不含 cancelled、按时间升序', async () => {
    const c = await loadClient(true);
    const t = await c.getToday();
    expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.summary).toMatch(/^今天 \d+ 件事，最急的是 \d{2}:\d{2} /);
    expect(t.events.length).toBeGreaterThan(0);
    expect(t.events.every((e) => e.status !== 'cancelled')).toBe(true);
    const times = t.events.map((e) => e.start_at ?? e.deadline_at!);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('存在一个有 2 条来源、1 条改期历史的事件', async () => {
    const c = await loadClient(true);
    const all = await c.getEvents();
    const details = await Promise.all(all.map((e) => c.getEvent(e.id)));
    const target = details.find((d) => d.sources.length === 2 && d.history.length === 1);
    expect(target).toBeDefined();
    expect(target!.group_name).not.toBe('');
    expect(target!.version).toBe(2);
  });

  it('覆盖所有类型和状态，供页面调样式', async () => {
    const c = await loadClient(true);
    const all = await c.getEvents(0, Date.now() + 30 * 86_400_000);
    const types = new Set([...all, ...(await c.getEvents())].map((e) => e.type));
    const statuses = new Set(all.map((e) => e.status));
    expect([...types].sort()).toEqual(['activity', 'announcement', 'assignment', 'exam', 'meeting', 'other']);
    expect([...statuses].sort()).toEqual(['active', 'cancelled', 'done', 'pending_confirm']);
  });

  it('getEvents 省略参数时不返回 cancelled', async () => {
    const c = await loadClient(true);
    expect((await c.getEvents()).some((e) => e.status === 'cancelled')).toBe(false);
  });

  it('PATCH 事件后状态持久', async () => {
    const c = await loadClient(true);
    expect((await c.patchEvent(3, 'active')).status).toBe('active');
    expect((await c.getEvent(3)).status).toBe('active');
  });

  it('不存在的事件抛 ApiError 404', async () => {
    const c = await loadClient(true);
    await expect(c.getEvent(999)).rejects.toMatchObject({ message: '事件不存在', status: 404 });
  });

  it('群开关、删除群数据', async () => {
    const c = await loadClient(true);
    expect((await c.patchGroup('demo-math', false)).enabled).toBe(false);
    await c.deleteGroupData('demo-math');
    const g = (await c.getGroups()).find((x) => x.group_id === 'demo-math')!;
    expect(g).toMatchObject({ message_count: 0, event_count: 0 });
  });

  it('演示：剧本、回放、粘贴、清空', async () => {
    const c = await loadClient(true);
    const [s] = await c.getScenarios();
    expect(await c.replay(s.name)).toEqual({ injected: s.count });
    expect((await c.getScenarios())[0].active).toBe(true);
    await c.undoReplay(s.name);
    expect((await c.getScenarios())[0].active).toBe(false);
    expect(await c.importText('测试群', 'a\nb\n\nc')).toEqual({ messages: 3 });
    await expect(c.importText('', 'x')).rejects.toMatchObject({ status: 400 });
    await c.resetDemo();
    expect(await c.getGroups()).toEqual([]);
  });

  it('连接状态可切换；未连接时同步 409 "QQ 未连接"', async () => {
    const c = await loadClient(true);
    expect((await c.getConnectStatus()).state).toBe('online');
    expect((await c.syncNow()).groups).toBeGreaterThan(0);

    store.set('mockConnectState', 'waiting_qr');
    store.set('mockFirstRun', '1');
    expect(await c.getConnectStatus()).toMatchObject({ state: 'waiting_qr', first_run: true });
    expect((await c.getHealth()).qq).toBe('waiting_qr');
    await expect(c.syncNow()).rejects.toMatchObject({ message: 'QQ 未连接', status: 409 });

    await c.restartConnect();
    expect((await c.getConnectStatus()).state).toBe('online');
  });

  it('health 字段齐全，jev 为 disabled', async () => {
    const c = await loadClient(true);
    const h = await c.getHealth();
    expect(h).toMatchObject({ db: 'ok', jev: 'disabled' });
    expect(Object.keys(h).sort()).toEqual(
      ['db', 'filtered_count', 'jev', 'llm', 'llm_called_count', 'qq', 'status', 'uptime'],
    );
  });
});

describe('真实模式（fetch 打桩）', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeEach(() => {
    calls.length = 0;
    reply = { status: 200, body: {} };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('每个函数的方法、路径、请求体都符合 §7', async () => {
    const c = await loadClient(false);
    expect(c.isMock).toBe(false);
    await c.getToday();
    await c.getEvents();
    await c.getEvents(1, 2);
    await c.getEvent(5);
    await c.patchEvent(5, 'done');
    await c.getGroups();
    await c.patchGroup('123', true);
    await c.deleteGroupData('123');
    await c.getScenarios();
    await c.replay('reschedule');
    await c.resetDemo();
    await c.undoReplay('reschedule');
    await c.importText('群', '文本');
    await c.getConnectStatus();
    await c.restartConnect();
    await c.syncNow();
    await c.getHealth();
    await c.getLlmSettings();
    await c.saveLlmSettings('deepseek', 'sk-12345678abcd');
    expect(calls).toEqual([
      { method: 'GET', url: '/api/today' },
      { method: 'GET', url: '/api/events' },
      { method: 'GET', url: '/api/events?from=1&to=2' },
      { method: 'GET', url: '/api/events/5' },
      { method: 'PATCH', url: '/api/events/5', body: { status: 'done' } },
      { method: 'GET', url: '/api/groups' },
      { method: 'PATCH', url: '/api/groups/123', body: { enabled: true } },
      { method: 'DELETE', url: '/api/groups/123/data' },
      { method: 'GET', url: '/api/demo/scenarios' },
      { method: 'POST', url: '/api/demo/replay', body: { scenario: 'reschedule' } },
      { method: 'POST', url: '/api/demo/reset' },
      { method: 'POST', url: '/api/demo/undo', body: { scenario: 'reschedule' } },
      { method: 'POST', url: '/api/import/text', body: { groupName: '群', text: '文本' } },
      { method: 'GET', url: '/api/connect/status' },
      { method: 'POST', url: '/api/connect/restart' },
      { method: 'POST', url: '/api/sync' },
      { method: 'GET', url: '/health' },
      { method: 'GET', url: '/api/settings/llm' },
      { method: 'PUT', url: '/api/settings/llm', body: { provider: 'deepseek', api_key: 'sk-12345678abcd' } },
    ]);
    expect(c.exportIcsUrl(1, 2)).toBe('/api/export.ics?from=1&to=2');
    expect(c.eventIcsUrl(5)).toBe('/api/events/5/export.ics');
  });

  it('出错时抛出响应里的 error 字段', async () => {
    const c = await loadClient(false);
    reply = { status: 409, body: { error: 'QQ 未连接' } };
    await expect(c.syncNow()).rejects.toMatchObject({ message: 'QQ 未连接', status: 409 });
    reply = { status: 403, body: { error: '局域网只读' } };
    await expect(c.patchEvent(1, 'done')).rejects.toMatchObject({ message: '局域网只读', status: 403 });
    reply = { status: 404, body: { error: '接口不存在' } };
    await expect(c.getToday()).rejects.toMatchObject({ message: '接口不存在', status: 404 });
  });

  it('响应不是 JSON（旧后端的纯文本 404）时也给出可读错误', async () => {
    const c = await loadClient(false);
    vi.stubGlobal('fetch', async () => new Response('404 Not Found', { status: 404 }));
    await expect(c.getToday()).rejects.toMatchObject({ message: '请求失败（404）', status: 404 });
  });

  it('局域网写操作 403 统一提示「请在电脑上操作」', async () => {
    const { errorText } = await import('../lib/errors');
    const { ApiError } = await import('./error');
    expect(errorText(new ApiError('局域网访问只读', 403))).toBe('请在电脑上操作');
    expect(errorText(new ApiError('QQ 未连接', 409))).toBe('QQ 未连接');
  });
});
