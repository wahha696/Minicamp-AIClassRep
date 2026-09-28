// P0-1 直接复现：A 账号的 OneBot action 响应在切到 B 后才回来，绝不能写进 B 的库。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

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

import { currentAccount, setAccountsDirForTest, switchAccount } from '../accounts.js';
import { db } from '../db/index.js';
import {
  getOnebotFacts,
  handleOnebotMessage,
  startOnebotClient,
  stopOnebotClient,
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
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('OneBot 迟到响应的账号隔离', () => {
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
