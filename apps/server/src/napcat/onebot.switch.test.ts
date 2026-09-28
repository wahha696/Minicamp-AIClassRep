// 修复计划第一节验收：lifecycle 换号 —— self_id 变了就切到对应账号库，同号重发是空操作。
// 换号后到的新消息进新库（D6：新群默认禁用，先登记不存消息）。
// 切库是异步的（先静默流水线再换库文件），测试里用 vi.waitFor 等它完成。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it, vi } from 'vitest';

// setUin/killTree/getUin 不碰真机（settings.json、进程树、真实 spawn）
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

import {
  accountDataState,
  closeCurrentAccount,
  currentAccount,
  deleteAccountData,
  setAccountsDirForTest,
  switchAccount,
  tryAcquireAccountMutationLease,
} from '../accounts.js';
import { accountMutationGuard } from '../account-request-guard.js';
import { db, dbGeneration } from '../db/index.js';
import { setUin } from './manager.js';
import { getOnebotFacts, handleOnebotMessage } from './onebot.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'classrep-ob-'));
  dirs.push(d);
  return d;
}
/** 每个用例一套独立账号目录 + 兜底库路径（互不污染） */
function useTempAccounts(): void {
  const d = tempDir();
  setAccountsDirForTest(join(d, 'accounts'), join(d, 'fallback.db'));
}
afterAll(() => {
  try {
    db.close(); // 先放开句柄，Windows 上才删得掉库文件
  } catch {
    // 忽略
  }
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // 句柄没放干净就留临时文件，不影响测试结果
    }
  }
});

const lifecycle = (selfId: string) =>
  JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: Number(selfId) });
const groupMsg = (mid: string, gid = '9001', selfId?: string) =>
  JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    ...(selfId === undefined ? {} : { self_id: Number(selfId) }),
    message_id: Number(mid),
    group_id: Number(gid),
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: '张三' },
    message: [{ type: 'text', data: { text: '下周三交作业' } }],
  });
const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('lifecycle 换号（修复计划第一节 §4）', () => {
  it('self_id 与当前库不同 → 切到该号的库；再发同号 lifecycle 是空操作', async () => {
    useTempAccounts();
    await switchAccount('11111');

    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(currentAccount()).toBe('22222')); // 换号 → 异步切库完成

    const gen = dbGeneration();
    handleOnebotMessage(lifecycle('22222'));
    // 同号是 no-op（accounts.ts 提前返回），等一下确认 generation 没变
    await new Promise((r) => setTimeout(r, 50));
    expect(currentAccount()).toBe('22222');
    expect(dbGeneration()).toBe(gen);
  });

  it('换号后到的群消息进新号的库，旧号数据不受影响', async () => {
    useTempAccounts();
    await switchAccount('11111');
    handleOnebotMessage(lifecycle('22222')); // 换到 22222
    await vi.waitFor(() => expect(currentAccount()).toBe('22222'));

    // D6：新发现的群默认禁用——消息不入库，但群登记在新号的库里
    handleOnebotMessage(groupMsg('1', '9001', '22222'));
    expect(count('messages')).toBe(0);
    const g = db.prepare('SELECT enabled, adapter FROM groups WHERE group_id = ?').get('9001') as {
      enabled: number;
      adapter: string;
    };
    expect(g).toEqual({ enabled: 0, adapter: 'onebot' });

    await switchAccount('11111'); // 切回旧号：看不到 22222 刚登记的群
    expect(count('groups')).toBe(0);
  });

  it('旧连接迟到的群消息带旧 self_id 时，不能登记进当前账号库', async () => {
    useTempAccounts();
    await switchAccount('11111');
    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(currentAccount()).toBe('22222'));

    handleOnebotMessage(groupMsg('1', '9001', '11111'));
    expect(count('groups')).toBe(0);

    handleOnebotMessage(groupMsg('2', '9002', '22222'));
    const row = db.prepare('SELECT enabled FROM groups WHERE group_id = ?').get('9002') as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('缺少 self_id 的群消息无法证明归属，一律丢弃', async () => {
    useTempAccounts();
    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(currentAccount()).toBe('22222'));

    handleOnebotMessage(groupMsg('1', '9001'));
    expect(count('groups')).toBe(0);
  });

  it('登录 A 时删除非当前账号 B，期间缓冲的 A 消息会在删除结束后写回 A', async () => {
    useTempAccounts();
    await switchAccount('22222'); // 先建出待删除的 B 账号库
    handleOnebotMessage(lifecycle('11111'));
    await vi.waitFor(() => expect(currentAccount()).toBe('11111'));

    const lease = tryAcquireAccountMutationLease();
    expect(lease).not.toBeNull();
    const deletion = deleteAccountData('22222');
    handleOnebotMessage(groupMsg('7', '9007', '11111'));

    lease!.release();
    await expect(deletion).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(db.prepare('SELECT enabled FROM groups WHERE group_id = ?').get('9007')).toEqual({ enabled: 0 });
    });
    expect(currentAccount()).toBe('11111');
  });

  it('切库失败 → 断流不写错库、facts 暴露错误；修复后 lifecycle 重试恢复', async () => {
    const d = tempDir();
    setAccountsDirForTest(join(d, 'accounts'), join(d, 'fallback.db'));
    await switchAccount('11111'); // 当前挂载 11111 的库

    // 让 22222 的库目录建不出来：accounts/22222 是个文件 → openDb 的 mkdirSync 抛 ENOTDIR
    const blocker = join(d, 'accounts', '22222');
    writeFileSync(blocker, 'not a directory');

    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(getOnebotFacts().accountError).not.toBeNull());
    expect(accountDataState()).toBe('error');

    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.get('/api/events/test', (c) => c.json({ leaked: true }));
    expect((await app.request('/api/events/test')).status).toBe(503);

    // 断流：新消息不写进 11111 的库（连群登记都没有），getOnebotFacts 让状态机能报 error
    handleOnebotMessage(groupMsg('1', '9001', '22222'));
    expect(count('groups')).toBe(0);
    expect(count('messages')).toBe(0);

    // 修复目录后重连（lifecycle 重发）→ 切库重试成功、断流解除
    rmSync(blocker);
    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(currentAccount()).toBe('22222'));
    expect(getOnebotFacts().accountError).toBeNull();
    expect(accountDataState()).toBe('ready');
    handleOnebotMessage(groupMsg('2', '9001', '22222'));
    const g = db.prepare('SELECT enabled FROM groups WHERE group_id = ?').get('9001') as { enabled: number };
    expect(g.enabled).toBe(0); // D6：新群登记但不收消息
  });

  it('登出回退库挂载失败后也断流，不得继续写入旧账号库', async () => {
    const d = tempDir();
    const blocker = join(d, 'blocked-parent');
    writeFileSync(blocker, 'not a directory');
    setAccountsDirForTest(join(d, 'accounts'), join(blocker, 'fallback.db'));
    await switchAccount('11111');
    handleOnebotMessage(lifecycle('11111'));
    await vi.waitFor(() => expect(accountDataState()).toBe('ready'));

    await expect(closeCurrentAccount()).rejects.toThrow();
    expect(currentAccount()).toBe('11111');
    expect(accountDataState()).toBe('error');
    // 这类失败不经 onLifecycleOnline，OneBot 自身的 accountError 仍为 null；
    // 写入闸门必须以 accounts 的统一状态为准。
    expect(getOnebotFacts().accountError).toBeNull();

    handleOnebotMessage(groupMsg('9', '9009', '11111'));
    expect(count('groups')).toBe(0);
    expect(count('messages')).toBe(0);

    rmSync(blocker);
    await expect(closeCurrentAccount()).resolves.toBeUndefined();
    expect(currentAccount()).toBeNull();
    expect(accountDataState()).toBe('ready');
  });

  it('保存新账号失败时立即断流并保持 fail closed，不暴露旧库或兜底库', async () => {
    useTempAccounts();
    await switchAccount('11111');
    vi.mocked(setUin).mockImplementationOnce(() => { throw new Error('settings locked'); });

    handleOnebotMessage(lifecycle('22222'));
    await vi.waitFor(() => expect(accountDataState()).toBe('error'));
    expect(currentAccount()).toBeNull();
    expect(getOnebotFacts().accountError).toContain('settings locked');

    const app = new Hono();
    app.use('*', accountMutationGuard());
    app.get('/api/events/test', (c) => c.json({ leaked: true }));
    expect((await app.request('/api/events/test')).status).toBe(503);

    // stopOnebotClient 后的迟到 lifecycle 必须被忽略，不能偷偷重新挂库。
    handleOnebotMessage(lifecycle('22222'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(currentAccount()).toBeNull();
  });
});
