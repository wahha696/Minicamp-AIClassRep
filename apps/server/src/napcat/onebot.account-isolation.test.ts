// P0-1 直接复现：A 账号的 OneBot action 响应在切到 B 后才回来，绝不能写进 B 的库。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./manager.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./manager.js')>();
  return {
    ...orig,
    IS_WINDOWS: false,
    setUin: vi.fn(),
    getUin: vi.fn(() => undefined),
    killTree: vi.fn(),
  };
});

import { accountEpoch, currentAccount, setAccountsDirForTest, switchAccount } from '../accounts.js';
import { db } from '../db/index.js';
import { HistoryJobs } from '../ingest/history-jobs.js';
import { setHistorySyncCoordinator, syncHistory } from '../ingest/history.js';
import { accountMutationGuard } from '../account-request-guard.js';
import { registerConnectRoutes } from '../routes/connect.js';
import { setDesktopRecoveryDoneHandler, setDesktopRecoveryHandler } from './desktop-recovery.js';
import {
  getOnebotFacts,
  handleOnebotMessage,
  startOnebotClient,
  stopOnebotClient,
  resetAfterRestart,
  callAction,
} from './onebot.js';

interface SentAction {
  action: string;
  params: Record<string, unknown>;
  echo: string;
}

const sent: SentAction[] = [];
const dirs: string[] = [];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(_url: string) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  send(raw: string): void {
    sent.push(JSON.parse(raw) as SentAction);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get('close') ?? []) listener({});
  }
}

const lifecycle = (uin: string) =>
  JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: Number(uin) });

const forwardMessage = (uin: string) =>
  JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    self_id: Number(uin),
    message_id: 1,
    group_id: 9001,
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: 'A 同学' },
    message: [
      { type: 'text', data: { text: 'A 的合并转发' } },
      { type: 'forward', data: { id: 'forward-from-a' } },
    ],
  });

async function setupAccountA(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'classrep-ob-isolation-'));
  dirs.push(root);
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  await switchAccount('11111');
  sent.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  startOnebotClient();
  handleOnebotMessage(lifecycle('11111'));
  return root;
}

async function actionAt(action: string, index: number): Promise<SentAction> {
  let found: SentAction | undefined;
  await vi.waitFor(() => {
    found = sent.filter((item) => item.action === action)[index];
    expect(found).toBeDefined();
  });
  return found!;
}

function reply(call: SentAction, data: unknown): void {
  handleOnebotMessage(JSON.stringify({ status: 'ok', echo: call.echo, data }));
}

afterEach(async () => {
  setHistorySyncCoordinator(null);
  setDesktopRecoveryHandler(() => null);
  setDesktopRecoveryDoneHandler(() => {});
  stopOnebotClient();
  vi.unstubAllGlobals();
  // 让被 stop 拒绝的 afterOnline 链完成 catch，避免跨用例残留微任务。
  await new Promise((resolve) => setTimeout(resolve, 0));
});

afterAll(() => {
  try {
    db.close();
  } catch {
    // 已关闭
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});

describe('OneBot 迟到响应的账号隔离', () => {
  it('cancels a long read without retaining its pending echo or accepting its late reply', async () => {
    await setupAccountA();
    const controller = new AbortController();
    const pending = callAction('get_group_msg_history', { group_id: 9001 }, null, controller.signal);
    const rejected = expect(pending).rejects.toThrow('ONEBOT_REQUEST_CANCELLED');
    const call = await actionAt('get_group_msg_history', 0);
    controller.abort(); await rejected;
    expect(() => reply(call, { messages: [] })).not.toThrow();
    // The next explicit request is independent of the cancelled request/echo.
    const next = callAction('get_group_msg_history', { group_id: 9001 }, null);
    reply(await actionAt('get_group_msg_history', 1), { messages: [] });
    expect(await next).toEqual({ messages: [] });
  });
  it('retains a history echo and its durable task for 20-minute pages and essence reads without retrying', async () => {
    await setupAccountA();
    reply(await actionAt('get_login_info', 0), { nickname: 'Synthetic' });
    reply(await actionAt('get_group_list', 0), []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    db.prepare("INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES ('9001','Synthetic',1,'onebot',?)").run(Date.now());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const jobs = new HistoryJobs({ historyContext: () => null, history: async () => { throw new Error('unused'); } });
      const request = { platform: 'qq' as const, days: 7 as const, expected_account_epoch: accountEpoch() };
      const job = jobs.create(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const first = await actionAt('get_group_msg_history', 0);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(jobs.get(job.id)).toMatchObject({ status: 'running', retryable: false, messages: 0, pages: 0 });
      expect(jobs.get(job.id)?.waiting_since).toBeTypeOf('number');
      expect(jobs.create(request).id).toBe(job.id);
      expect(sent.filter((item) => item.action === 'get_group_msg_history')).toHaveLength(1);
      const messages = [{ message_id: 901, group_id: 9001, time: Math.floor(Date.now() / 1000) - 10,
        sender: { nickname: 'Synthetic' }, message: [{ type: 'text', data: { text: 'Synthetic long page' } }] }];
      reply(first, { messages });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const last = await actionAt('get_group_msg_history', 1);
      expect(jobs.get(job.id)).toMatchObject({ messages: 1, pages: 1, waiting_since: null });
      reply(last, { messages: [] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const essence = await actionAt('get_essence_msg_list', 0);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(jobs.get(job.id)).toMatchObject({ status: 'running', retryable: false, messages: 1 });
      expect(jobs.get(job.id)?.waiting_since).toBeTypeOf('number');
      expect(sent.filter((item) => item.action === 'get_essence_msg_list')).toHaveLength(1);
      reply(essence, [{ message_id: 902, sender_time: Math.floor(Date.now() / 1000), content: 'Synthetic essence' }]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      reply(first, { messages }); // A duplicate late echo cannot ingest again.
      expect(jobs.get(job.id)).toMatchObject({ status: 'completed', messages: 2, pages: 2, waiting_since: null });
      expect(db.prepare('SELECT COUNT(*) n FROM messages').get()?.n).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it('login automatic backfill shares its indefinitely waiting task with manual and legacy requests', async () => {
    await setupAccountA();
    const jobs = new HistoryJobs({ historyContext: () => null, history: async () => { throw new Error('unused'); } });
    jobs.coordinateQQ();
    db.prepare("INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES ('9001','Synthetic',1,'onebot',?)").run(Date.now());
    reply(await actionAt('get_login_info', 0), { nickname: 'Synthetic' });
    const groupList = await actionAt('get_group_list', 0);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      reply(groupList, []);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const page = await actionAt('get_group_msg_history', 0);
      const id = jobs.list()[0]!.id;
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(jobs.list()[0]).toMatchObject({ id, status: 'running', retryable: false });
      expect(jobs.list()[0]?.waiting_since).toBeTypeOf('number');
      handleOnebotMessage(lifecycle('11111'));
      expect(jobs.create({ platform: 'qq', days: 7, expected_account_epoch: accountEpoch() }).id).toBe(id);
      const legacy = syncHistory(7);
      expect(sent.filter((call) => call.action === 'get_group_msg_history')).toHaveLength(1);
      reply(page, { messages: [{ message_id: 991, group_id: 9001, time: Math.floor(Date.now() / 1000) - 8 * 86400,
        sender: { nickname: 'Synthetic' }, message: [{ type: 'text', data: { text: 'Window boundary' } }] }] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const essence = await actionAt('get_essence_msg_list', 0);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(jobs.list()[0]).toMatchObject({ status: 'running', pages: 1 });
      expect(sent.filter((call) => call.action === 'get_essence_msg_list')).toHaveLength(1);
      reply(essence, [{ message_id: 992, sender_time: Math.floor(Date.now() / 1000), content: 'Synthetic long automatic notice' }]);
      expect(await legacy).toEqual({ groups: 1, messages: 1, failures: 0 });
      expect(jobs.list()[0]).toMatchObject({ id, status: 'completed', messages: 1, waiting_since: null });
      expect(db.prepare('SELECT COUNT(*) n FROM messages').get()?.n).toBe(1);
      expect(sent.filter((call) => call.action === 'get_group_msg_history')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
  it('legacy HTTP admission releases its account lease while the source page is still pending', async () => {
    await setupAccountA();
    const jobs = new HistoryJobs({ historyContext: () => null, history: async () => { throw new Error('unused'); } });
    jobs.coordinateQQ();
    db.prepare("INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES ('9001','Synthetic',1,'onebot',?)").run(Date.now());
    const app = new Hono(); app.use('*', accountMutationGuard()); registerConnectRoutes(app);
    const response = await app.request('/api/sync', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-ClassRep-Account-Epoch': accountEpoch(),
    }, body: JSON.stringify({ days: 7 }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ job: { status: 'running' } });
    const pendingPage = await actionAt('get_group_msg_history', 0);
    // This exclusive transition would deadlock if /api/sync retained its lease.
    await switchAccount('22222');
    expect(currentAccount()).toBe('22222');
    reply(pendingPage, { messages: [] });
    expect(db.prepare('SELECT COUNT(*) n FROM messages').get()?.n).toBe(0);
  });
  it('reconnect resumes the saved cursor then catches new offline arrivals under the same task ID', async () => {
    await setupAccountA();
    const jobs = new HistoryJobs({ historyContext: () => null, history: async () => { throw new Error('unused'); } });
    jobs.coordinateQQ();
    db.prepare("INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES ('9001','Synthetic',1,'onebot',?)").run(Date.now());
    const message = (id: number, age: number) => ({ message_id: id, group_id: 9001,
      time: Math.floor(Date.now() / 1000) - age, raw_message: 'Synthetic offline notice', sender: { nickname: 'Synthetic' } });
    reply(await actionAt('get_login_info', 0), { nickname: 'Synthetic' });
    reply(await actionAt('get_group_list', 0), []);
    reply(await actionAt('get_group_msg_history', 0), { messages: [message(51, 100)] });
    const oldPending = await actionAt('get_group_msg_history', 1);
    const id = jobs.list()[0]!.id;
    stopOnebotClient();
    await vi.waitFor(() => expect(jobs.get(id)?.status).toBe('failed'));
    resetAfterRestart(); handleOnebotMessage(lifecycle('11111'));
    reply(await actionAt('get_login_info', 1), { nickname: 'Synthetic' });
    reply(await actionAt('get_group_list', 1), []);
    const resumed = await actionAt('get_group_msg_history', 2);
    expect(resumed.params.message_seq).toBe(51);
    reply(resumed, { messages: [] });
    reply(await actionAt('get_essence_msg_list', 0), []);
    const head = await actionAt('get_group_msg_history', 3);
    expect(head.params.message_seq).toBeUndefined();
    handleOnebotMessage(lifecycle('11111'));
    const joining = syncHistory(7);
    expect(jobs.create({ platform: 'qq', days: 7, expected_account_epoch: accountEpoch() }).id).toBe(id);
    expect(sent.filter((call) => call.action === 'get_group_msg_history')).toHaveLength(4);
    reply(oldPending, { messages: [message(999, 1)] }); // Rejected old socket echo.
    reply(head, { messages: [message(52, 1), message(50, 8 * 86400)] });
    reply(await actionAt('get_essence_msg_list', 1), []);
    expect(await joining).toEqual({ groups: 1, messages: 2, failures: 0 });
    expect(jobs.get(id)).toMatchObject({ status: 'completed', messages: 2 });
    expect(db.prepare('SELECT message_id FROM messages ORDER BY message_id').all()).toEqual([{ message_id: '51' }, { message_id: '52' }]);
    expect(sent.filter((call) => call.action === 'get_group_msg_history')).toHaveLength(4);
  });
  it('an indefinite read still rejects on real connection close', async () => {
    await setupAccountA();
    const result = callAction('get_essence_msg_list', { group_id: 9001 }, null);
    const rejected = expect(result).rejects.toThrow('连接已关闭');
    stopOnebotClient(); await rejected;
  });
  it('same-account desktop return backfills its gap once and deduplicates repeated lifecycle events', async () => {
    await setupAccountA();
    reply(await actionAt('get_login_info', 0), { nickname: 'A' });
    reply(await actionAt('get_group_list', 0), []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    db.prepare("INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('9001', '班群', 1, 'onebot', ?)").run(Date.now());
    const since = Date.now() - 10 * 60_000;
    const takeGap = vi.fn((uin: string) => uin === '11111' ? since : null);
    setDesktopRecoveryHandler(takeGap);
    const finished = vi.fn();
    setDesktopRecoveryDoneHandler(finished);
    stopOnebotClient();
    resetAfterRestart();
    handleOnebotMessage(lifecycle('11111'));
    reply(await actionAt('get_login_info', 1), { nickname: 'A' });
    reply(await actionAt('get_group_list', 1), []);
    const history = await actionAt('get_group_msg_history', 0);
    expect(finished).not.toHaveBeenCalled();
    reply(history, { messages: [
      { message_id: 3001, group_id: 9001, time: Math.floor((since + 1000) / 1000), raw_message: '切换期间的通知', sender: { nickname: '老师' } },
      { message_id: 3000, group_id: 9001, time: Math.floor((since - 120_000) / 1000), raw_message: '窗口前的消息', sender: { nickname: '老师' } },
    ] });
    reply(await actionAt('get_essence_msg_list', 0), []);
    await vi.waitFor(() => expect(db.prepare("SELECT 1 FROM messages WHERE message_id = '3001'").get()).toBeDefined());
    expect(db.prepare("SELECT 1 FROM messages WHERE message_id = '3000'").get()).toBeUndefined();
    handleOnebotMessage(lifecycle('11111'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(takeGap).toHaveBeenCalledExactlyOnceWith('11111');
    expect(finished).toHaveBeenCalledExactlyOnceWith('11111', since);
    expect(sent.filter((item) => item.action === 'get_group_msg_history')).toHaveLength(1);
  });
  it('A 的 get_group_list 切到 B 后才返回，不得把 A 的群写进 B', async () => {
    await setupAccountA();
    const loginA = await actionAt('get_login_info', 0);
    reply(loginA, { nickname: '账号 A' });
    const groupsA = await actionAt('get_group_list', 0); // 故意挂起

    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(currentAccount()).toBe('22222'));

    const loginB = await actionAt('get_login_info', 1);
    reply(loginB, { nickname: '账号 B' });
    const groupsB = await actionAt('get_group_list', 1);
    reply(groupsB, []);

    // 已被切号作废的 A 回包此刻才抵达。
    reply(groupsA, [{ group_id: 7001, group_name: 'A 的班群' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.prepare("SELECT 1 FROM groups WHERE group_id = '7001'").get()).toBeUndefined();
  });

  it('A 的 get_forward_msg 切到 B 后才返回，不得把 A 的转发节点写进 B', async () => {
    await setupAccountA();
    handleOnebotMessage(forwardMessage('11111'));
    const forwardA = await actionAt('get_forward_msg', 0); // 故意挂起
    const loginCallsBeforeB = sent.filter((item) => item.action === 'get_login_info').length;
    const groupCallsBeforeB = sent.filter((item) => item.action === 'get_group_list').length;

    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(currentAccount()).toBe('22222'));

    const loginB = await actionAt('get_login_info', loginCallsBeforeB);
    reply(loginB, { nickname: '账号 B' });
    const groupsB = await actionAt('get_group_list', groupCallsBeforeB);
    reply(groupsB, []);

    // 让 B 中同群处于开启状态；若少了代次守卫，迟到节点会真实落进 messages，而非被 D6 偶然挡住。
    db.prepare(
      "INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('9001', 'B 的同号群', 1, 'onebot', ?)",
    ).run(Date.now());
    const historyB = await actionAt('get_group_msg_history', 0);
    reply(historyB, { messages: [] });
    const essenceB = await actionAt('get_essence_msg_list', 0);
    reply(essenceB, []);

    reply(forwardA, [
      {
        message_id: 88001,
        time: Math.floor(Date.now() / 1000),
        sender: { nickname: 'A 老师' },
        content: [{ type: 'text', data: { text: '只属于 A 的通知' } }],
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(db.prepare("SELECT 1 FROM messages WHERE message_id = '88001'").get()).toBeUndefined();
  });

  it('B 挂库失败且 generation 留在 A 时，A 的历史补齐不得在 B 会话上重试并写回 A', async () => {
    const root = await setupAccountA();
    db.prepare(
      "INSERT INTO groups (group_id, name, enabled, adapter, created_at) VALUES ('9001', 'A 的班群', 1, 'onebot', ?)",
    ).run(Date.now());

    const loginA = await actionAt('get_login_info', 0);
    reply(loginA, { nickname: '账号 A' });
    const groupsA = await actionAt('get_group_list', 0);
    reply(groupsA, []);
    await actionAt('get_group_msg_history', 0); // 故意挂起；换号 lifecycle 会 reject 这个 action

    // 目标账号路径是文件，确保 openDb(B) 失败；全局 db 与 generation 因原子挂库仍留在 A。
    const blocker = join(root, 'accounts', '22222');
    writeFileSync(blocker, 'not a directory');
    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(getOnebotFacts().accountError).not.toBeNull());
    expect(currentAccount()).toBe('11111');

    // 旧实现只看 dbGeneration，会在 800ms 退避后用 B 的 OneBot 会话再次请求 A 群历史。
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(sent.filter((item) => item.action === 'get_group_msg_history')).toHaveLength(1);
    expect(db.prepare("SELECT 1 FROM messages WHERE message_id = '99001'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM group_sync WHERE group_id = '9001'").get()).toBeUndefined();

    // 恢复账号状态，避免挂库失败留下的静默状态影响同进程里的后续用例。
    rmSync(blocker);
    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(currentAccount()).toBe('22222'));
  });
});
