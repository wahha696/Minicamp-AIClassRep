// 修复计划第一节验收：lifecycle 换号 —— self_id 变了就切到对应账号库，同号重发是空操作。
// 换号后到的新消息进新库（D6：新群默认禁用，先登记不存消息）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import { currentAccount, db, dbGeneration, setDataDir, switchAccount } from '../db/index.js';
import { handleOnebotMessage } from './onebot.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'classrep-ob-'));
  dirs.push(d);
  return d;
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
const groupMsg = (mid: string, gid = '9001') =>
  JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    message_id: Number(mid),
    group_id: Number(gid),
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: '张三' },
    message: [{ type: 'text', data: { text: '下周三交作业' } }],
  });
const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('lifecycle 换号（修复计划第一节 §4）', () => {
  it('self_id 与当前库不同 → 切到该号的库；再发同号 lifecycle 是空操作', () => {
    setDataDir(tempDir());
    switchAccount('111');

    handleOnebotMessage(lifecycle('222'));
    expect(currentAccount()).toBe('222'); // 换号 → 切库

    const gen = dbGeneration();
    handleOnebotMessage(lifecycle('222'));
    expect(currentAccount()).toBe('222');
    expect(dbGeneration()).toBe(gen); // 同号不重建连接
  });

  it('换号后到的群消息进新号的库，旧号数据不受影响', () => {
    setDataDir(tempDir());
    switchAccount('111');
    handleOnebotMessage(lifecycle('222')); // 换到 222

    // D6：新发现的群默认禁用——消息不入库，但群登记在新号的库里
    handleOnebotMessage(groupMsg('1'));
    expect(count('messages')).toBe(0);
    const g = db.prepare('SELECT enabled, adapter FROM groups WHERE group_id = ?').get('9001') as {
      enabled: number;
      adapter: string;
    };
    expect(g).toEqual({ enabled: 0, adapter: 'onebot' });

    switchAccount('111'); // 切回旧号：看不到 222 刚登记的群
    expect(count('groups')).toBe(0);
  });
});
