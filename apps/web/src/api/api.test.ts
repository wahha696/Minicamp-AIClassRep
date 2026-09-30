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
    // 列表接口不返回 cancelled / 待办类事件（与后端一致），所以要从三个口凑齐：
    // getEvents（正常事件）+ getTodos（待办类）+ getEvent（取消的那条按 id 取详情）
    const [listed, todos, cancelled] = await Promise.all([
      c.getEvents(0, Date.now() + 30 * 86_400_000),
      c.getTodos(),
      c.getEvent(8),
    ]);
    const all = [...listed, ...todos.events, cancelled];
    const types = new Set(all.map((e) => e.type));
    const statuses = new Set(all.map((e) => e.status));
    expect([...types].sort()).toEqual(['activity', 'announcement', 'assignment', 'exam', 'meeting', 'other']);
    expect([...statuses].sort()).toEqual(['active', 'cancelled', 'done', 'pending_confirm']);
  });

  it('getEvents 省略参数时不返回 cancelled，也不返回待办类事件', async () => {
    const c = await loadClient(true);
    const all = await c.getEvents();
    expect(all.some((e) => e.status === 'cancelled')).toBe(false);
    // 无时间事件（待办）不出现在列表接口
    expect(all.every((e) => e.start_at !== null || e.deadline_at !== null)).toBe(true);
  });

  it('PATCH 事件后状态持久', async () => {
    const c = await loadClient(true);
    expect((await c.patchEvent(3, { status: 'active' })).status).toBe('active');
    expect((await c.getEvent(3)).status).toBe('active');
  });

  it('PATCH level 设级后锁定，null 交还 AI', async () => {
    const c = await loadClient(true);
    const locked = await c.patchEvent(1, { level: 1 });
    expect(locked).toMatchObject({ level: 1, level_locked: true });
    const unlocked = await c.patchEvent(1, { level: null });
    expect(unlocked.level_locked).toBe(false);
  });

  it('待确认提案可接受或拒绝，决定后立即返回最新详情', async () => {
    const c = await loadClient(true);
    const before = await c.getEvent(5);
    expect(before.pending_proposals[0]).toMatchObject({
      id: 501,
      kind: 'update',
      reason: 'low_confidence',
      changes: { location: { from: '学生活动中心 201', to: '学生活动中心 305' } },
    });
    const accepted = await c.resolveEventProposal(5, 501, 'accept', before.version);
    expect(accepted).toMatchObject({
      status: 'active',
      location: '学生活动中心 305',
      pending_proposals: [],
    });

    const fresh = await loadClient(true);
    const again = await fresh.getEvent(5);
    const rejected = await fresh.resolveEventProposal(5, 501, 'reject', again.version);
    expect(rejected).toMatchObject({
      status: 'active',
      location: '学生活动中心 201',
      pending_proposals: [],
    });
  });

  it('人工修正时间地点会关闭待确认并保护改过的字段；旧版本写入返回 409', async () => {
    const c = await loadClient(true);
    const before = await c.getEvent(5);
    const correctedStart = before.start_at! + 2 * 60 * 60_000;
    const corrected = await c.patchEvent(5, {
      start_at: correctedStart,
      location: '艺术楼 102',
      expected_version: before.version,
    });
    expect(corrected).toMatchObject({
      status: 'active',
      start_at: correctedStart,
      location: '艺术楼 102',
      pending_proposals: [],
    });
    expect(corrected.manual_locked_fields).toEqual(expect.arrayContaining(['start_at', 'location']));
    await expect(c.patchEvent(5, { location: '过期修改', expected_version: before.version })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('不存在的事件抛 ApiError 404', async () => {
    const c = await loadClient(true);
    await expect(c.getEvent(999)).rejects.toMatchObject({ message: '事件不存在', status: 404 });
  });

  it('群开关、删除群数据', async () => {
    const c = await loadClient(true);
    expect((await c.patchGroup('demo-math', { enabled: false })).enabled).toBe(false);
    await c.deleteGroupData('demo-math');
    const g = (await c.getGroups()).find((x) => x.group_id === 'demo-math')!;
    expect(g).toMatchObject({ message_count: 0, event_count: 0 });
  });

  it('群绑定课程名', async () => {
    const c = await loadClient(true);
    expect((await c.patchGroup('demo-linear', { course_name: '线性代数' })).course_name).toBe('线性代数');
    expect((await c.patchGroup('demo-linear', { course_name: null })).course_name).toBeNull();
  });

  it('待办：列表、新建、勾选完成', async () => {
    const c = await loadClient(true);
    const t0 = await c.getTodos();
    expect(t0.events.length).toBeGreaterThan(0); // 群里的待办类事件
    expect(t0.manual).toHaveLength(1);
    const created = await c.createTodo({ title: '领快递' });
    expect((await c.getTodos()).manual.map((t) => t.id)).toContain(created.id);
    await c.patchTodo(created.id, { done: true });
    expect((await c.getTodos()).manual.map((t) => t.id)).not.toContain(created.id);
  });

  it('课表：读取、保存、清空', async () => {
    const c = await loadClient(true);
    const t = await c.getTimetable();
    expect(t.semester_start).toBe('2026-09-07');
    expect(t.courses.length).toBe(13);
    const saved = await c.saveTimetable({ semester_start: '2026-09-07', courses: t.courses.slice(0, 1) });
    expect(saved.courses).toHaveLength(1);
    await c.clearTimetable();
    expect((await c.getTimetable()).courses).toHaveLength(0);
  });

  it('记忆：开关、删单条、清空', async () => {
    const c = await loadClient(true);
    const m = await c.getMemory();
    expect(m.rules.length).toBe(2);
    expect((await c.setMemoryEnabled(false)).enabled).toBe(false);
    expect((await c.deleteMemoryRule(1)).rules.map((r) => r.id)).toEqual([2]);
    expect((await c.clearMemory()).rules).toEqual([]);
  });

  it('回收站：群里取消 + 改期旧版本；手动取消也进；恢复后回到日历', async () => {
    const c = await loadClient(true);
    const trash = await c.getTrash();
    expect(trash.map((t) => [t.id, t.kind, t.by])).toEqual([
      ['change-1000', 'changed', 'group'],
      ['cancel-8', 'cancelled', 'group'],
    ]);
    expect(trash[1]!.source_text).toContain('取消');

    await c.patchEvent(4, { status: 'cancelled' });
    const withManual = await c.getTrash();
    expect(withManual[0]).toMatchObject({ id: 'cancel-4', by: 'manual', source_text: null });

    await c.restoreTrash('cancel-4');
    await c.restoreTrash('cancel-8');
    expect((await c.getEvents()).map((e) => e.id)).toEqual(expect.arrayContaining([4, 8]));

    const before = (await c.getEvent(1)).start_at;
    const after = await c.restoreTrash('change-1000');
    expect(after).toEqual([]);
    const e1 = await c.getEvent(1);
    expect(e1.location).toBe('A301');
    expect(e1.start_at).not.toBe(before);
    await expect(c.restoreTrash('change-1000')).rejects.toMatchObject({ status: 409 });
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

    await c.restartConnect({ accountEpoch: '10001:1', uin: '10001' });
    expect(await c.getConnectStatus()).toMatchObject({ state: 'online', nickname: '演示同学' });

    await c.logoutConnect({ accountEpoch: '10001:1', uin: '10001' });
    expect((await c.getConnectStatus()).state).toBe('waiting_qr');
    await c.restartConnect({ accountEpoch: '10001:1', uin: null });
  });

  it('health 字段齐全，jev 为 disabled', async () => {
    const c = await loadClient(true);
    const h = await c.getHealth();
    expect(h).toMatchObject({ db: 'ok', jev: 'disabled', pending: 0 });
    expect(Object.keys(h).sort()).toEqual(
      ['db', 'filtered_count', 'jev', 'jev_called_count', 'jev_filtered_count', 'llm', 'llm_called_count', 'pending', 'qq', 'status', 'uptime'],
    );
  });
});

describe('真实模式（fetch 打桩）', () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const requestHeaders: Headers[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeEach(() => {
    calls.length = 0;
    requestHeaders.length = 0;
    reply = { status: 200, body: {} };
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
      requestHeaders.push(new Headers(init.headers));
      const hasExplicitConnectReply =
        reply.body !== null && typeof reply.body === 'object' && 'account_epoch' in reply.body;
      const response = url === '/api/connect/status' && !hasExplicitConnectReply
        ? {
            status: 200,
            body: { state: 'online', account_epoch: '10001:1', since: 1, first_run: false },
          }
        : reply;
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('每个函数的方法、路径、请求体都符合 §7', async () => {
    const c = await loadClient(false);
    expect(c.isMock).toBe(false);
    await c.getConnectStatus();
    await c.getToday();
    await c.getEvents();
    await c.getEvents(1, 2);
    await c.getEvent(5);
    await c.patchEvent(5, { location: 'A203', expected_version: 2 });
    await c.resolveEventProposal(5, 17, 'accept', 2);
    await c.patchEvent(5, { status: 'done' });
    await c.patchEvent(5, { level: 3 });
    await c.patchEvent(5, { level: null });
    await c.getGroups();
    await c.patchGroup('123', { enabled: true });
    await c.patchGroup('123', { course_name: '线性代数' });
    await c.deleteGroupData('123');
    await c.getScenarios();
    await c.replay('reschedule');
    await c.resetDemo();
    await c.undoReplay('reschedule');
    await c.importText('群', '文本');
    await c.restartConnect({ accountEpoch: '10001:1', uin: '10001' });
    await c.logoutConnect({ accountEpoch: '10001:1', uin: '10001' });
    await c.syncNow();
    await c.syncNow(30);
    await c.getHealth();
    await c.getLlmSettings();
    await c.saveLlmSettings('deepseek', 'sk-12345678abcd');
    await c.getTodos();
    await c.createTodo({ title: '领快递', note: '东门', level: 3 });
    await c.patchTodo(1, { done: true });
    await c.getTimetable();
    await c.saveTimetable({ semester_start: '2026-09-07', courses: [] });
    await c.clearTimetable();
    await c.getMemory();
    await c.setMemoryEnabled(true);
    await c.deleteMemoryRule(2);
    await c.clearMemory();
    await c.getTrash();
    await c.restoreTrash('change-12');
    expect(calls).toEqual([
      { method: 'GET', url: '/api/connect/status' },
      { method: 'GET', url: '/api/today' },
      { method: 'GET', url: '/api/events' },
      { method: 'GET', url: '/api/events?from=1&to=2' },
      { method: 'GET', url: '/api/events/5' },
      { method: 'PATCH', url: '/api/events/5', body: { location: 'A203', expected_version: 2 } },
      { method: 'POST', url: '/api/events/5/proposals/17/resolve', body: { decision: 'accept', expected_version: 2 } },
      { method: 'PATCH', url: '/api/events/5', body: { status: 'done' } },
      { method: 'PATCH', url: '/api/events/5', body: { level: 3 } },
      { method: 'PATCH', url: '/api/events/5', body: { level: null } },
      { method: 'GET', url: '/api/groups' },
      { method: 'PATCH', url: '/api/groups/123', body: { enabled: true } },
      { method: 'PATCH', url: '/api/groups/123', body: { course_name: '线性代数' } },
      { method: 'DELETE', url: '/api/groups/123/data', body: {} },
      { method: 'GET', url: '/api/demo/scenarios' },
      { method: 'POST', url: '/api/demo/replay', body: { scenario: 'reschedule' } },
      { method: 'POST', url: '/api/demo/reset', body: {} },
      { method: 'POST', url: '/api/demo/undo', body: { scenario: 'reschedule' } },
      { method: 'POST', url: '/api/import/text', body: { groupName: '群', text: '文本' } },
      { method: 'POST', url: '/api/connect/restart', body: {
        expected_account_epoch: '10001:1', expected_uin: '10001',
      } },
      { method: 'POST', url: '/api/connect/logout', body: {
        expected_account_epoch: '10001:1', expected_uin: '10001',
      } },
      { method: 'POST', url: '/api/sync', body: {} },
      { method: 'POST', url: '/api/sync', body: { days: 30 } },
      { method: 'GET', url: '/health' },
      { method: 'GET', url: '/api/settings/llm' },
      { method: 'PUT', url: '/api/settings/llm', body: { provider: 'deepseek', api_key: 'sk-12345678abcd' } },
      { method: 'GET', url: '/api/todos' },
      { method: 'POST', url: '/api/todos', body: { title: '领快递', note: '东门', level: 3 } },
      { method: 'PATCH', url: '/api/todos/1', body: { done: true } },
      { method: 'GET', url: '/api/timetable' },
      { method: 'PUT', url: '/api/timetable', body: { semester_start: '2026-09-07', courses: [] } },
      { method: 'DELETE', url: '/api/timetable', body: {} },
      { method: 'GET', url: '/api/settings/memory' },
      { method: 'PUT', url: '/api/settings/memory', body: { enabled: true } },
      { method: 'DELETE', url: '/api/settings/memory/rules/2', body: {} },
      { method: 'DELETE', url: '/api/settings/memory', body: {} },
      { method: 'GET', url: '/api/trash' },
      { method: 'POST', url: '/api/trash/change-12/restore', body: {} },
    ]);
    expect(c.exportIcsUrl(1, 2)).toBe('/api/export.ics?from=1&to=2&account_epoch=10001%3A1');
    expect(c.eventIcsUrl(5)).toBe('/api/events/5/export.ics?account_epoch=10001%3A1');
    for (const [index, call] of calls.entries()) {
      if (call.method !== 'GET' && call.method !== 'HEAD') {
        expect(requestHeaders[index]!.get('Content-Type'), `${call.method} ${call.url}`).toBe('application/json');
      }
    }
  });

  it('读取连接状态后，后续账号业务读写都带账号库 epoch', async () => {
    const c = await loadClient(false);
    reply = {
      status: 200,
      body: { state: 'online', account_epoch: '10001:37', since: Date.now(), first_run: false },
    };
    await c.getConnectStatus();
    reply = { status: 200, body: {} };
    await c.getToday();
    await c.patchEvent(1, { status: 'done', expected_version: 4 });
    expect(requestHeaders[0]!.get('X-ClassRep-Account-Epoch')).toBeNull();
    expect(requestHeaders[1]!.get('X-ClassRep-Account-Epoch')).toBe('10001:37');
    expect(requestHeaders[2]!.get('X-ClassRep-Account-Epoch')).toBe('10001:37');
  });

  it('首个账号业务请求会先取 epoch，且直接 fetch 的桌宠通道也统一携带', async () => {
    const c = await loadClient(false);
    await c.getToday();
    await c.accountScopedFetch('/api/pet/chat', { method: 'POST' });

    expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: '/api/connect/status' },
      { method: 'GET', url: '/api/today' },
      { method: 'POST', url: '/api/pet/chat' },
    ]);
    expect(requestHeaders[0]!.get('X-ClassRep-Account-Epoch')).toBeNull();
    expect(requestHeaders[1]!.get('X-ClassRep-Account-Epoch')).toBe('10001:1');
    expect(requestHeaders[2]!.get('X-ClassRep-Account-Epoch')).toBe('10001:1');
  });

  it('出错时抛出响应里的 error 字段', async () => {
    const c = await loadClient(false);
    reply = { status: 409, body: { error: 'QQ 未连接' } };
    await expect(c.syncNow()).rejects.toMatchObject({ message: 'QQ 未连接', status: 409 });
    reply = { status: 403, body: { error: '局域网只读' } };
    await expect(c.patchEvent(1, { status: 'done' })).rejects.toMatchObject({ message: '局域网只读', status: 403 });
    reply = { status: 404, body: { error: '接口不存在' } };
    await expect(c.getToday()).rejects.toMatchObject({ message: '接口不存在', status: 404 });
  });

  it('响应不是 JSON（旧后端的纯文本 404）时也给出可读错误', async () => {
    const c = await loadClient(false);
    vi.stubGlobal('fetch', async (url: string) =>
      url === '/api/connect/status'
        ? new Response(JSON.stringify({ state: 'online', account_epoch: '10001:1', since: 1, first_run: false }))
        : new Response('404 Not Found', { status: 404 }),
    );
    await expect(c.getToday()).rejects.toMatchObject({ message: '请求失败（404）', status: 404 });
  });

  it('局域网写操作 403 统一提示「请在电脑上操作」', async () => {
    const { errorText } = await import('../lib/errors');
    const { ApiError } = await import('./error');
    expect(errorText(new ApiError('局域网访问只读', 403))).toBe('请在电脑上操作');
    expect(errorText(new ApiError('QQ 未连接', 409))).toBe('QQ 未连接');
  });
});
