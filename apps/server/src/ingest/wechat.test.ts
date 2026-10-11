import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as accounts from '../accounts.js';
import { db, openDb, SCHEMA_VERSION } from '../db/index.js';
import { ingestMessages, upsertGroup } from './index.js';
import { bindWechatDestination, wechatBatchId, wechatGroupId, type WechatDelivery } from './wechat.js';
import { extractEvents } from '../pipeline/extract.js';
import { runPipelineNow } from '../pipeline/scheduler.js';
import { wechatPythonArgs, wechatPythonEnv } from './wechat-python.js';

vi.mock('../pipeline/extract.js', async (original) => ({
  ...(await original<typeof import('../pipeline/extract.js')>()), extractEvents: vi.fn(),
}));
vi.mock('../pipeline/jev.js', async (original) => ({
  ...(await original<typeof import('../pipeline/jev.js')>()),
  scoreWithJev: vi.fn(async () => null), jevAvailable: vi.fn(() => false),
}));

const ACCOUNT = 'synthetic_account_A';
const GROUP = 'synthetic_A@chatroom';
const DESTINATION = 'synthetic-workspace-A';
const extract = vi.mocked(extractEvents);
const dirs: string[] = [];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const research = join(root, '.review-research');

function directory(): string {
  mkdirSync(research, { recursive: true });
  const path = mkdtempSync(join(research, 'synthetic-wechat-bridge-'));
  const rel = relative(realpathSync(research), realpathSync(path));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('TEST_WORKSPACE_PATH');
  dirs.push(path);
  return path;
}
function enable(group = GROUP): void {
  const id = wechatGroupId(ACCOUNT, group);
  upsertGroup(id, '人工测试群', 'wechat');
  db.prepare('UPDATE groups SET enabled=1 WHERE group_id=?').run(id);
}
function delivery(messages?: WechatDelivery['messages']): WechatDelivery {
  const batch: WechatDelivery = { version: 1, destination: DESTINATION, wechat_account: ACCOUNT,
    batch_id: '', messages: messages ?? [{ event_id: 'a'.repeat(64), group_id: GROUP,
      group_name: '人工测试群 😀', sender_name: '人工成员', text: '明天下午两点交人工测试作业',
      sent_at: 1700000000000 }] };
  batch.batch_id = wechatBatchId(batch);
  return batch;
}
const receiver = () => bindWechatDestination(DESTINATION, ACCOUNT, [GROUP]);
const count = (table: 'messages' | 'events' | 'wechat_delivery_batches') =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  openDb(':memory:');
  extract.mockReset();
  extract.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (db.isOpen) db.close();
  for (const path of dirs.splice(0)) {
    const rel = relative(realpathSync(research), realpathSync(path));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('TEST_CLEANUP_PATH');
    rmSync(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

describe('微信幂等业务接收', () => {
  it('微信新群默认关闭，未主动启用时不确认或存消息', () => {
    const id = wechatGroupId(ACCOUNT, GROUP);
    upsertGroup(id, '人工测试群', 'wechat');
    expect(db.prepare('SELECT enabled FROM groups WHERE group_id=?').get(id)?.enabled).toBe(0);
    expect(() => receiver()(delivery())).toThrow('WECHAT_GROUP_NOT_ENABLED');
    expect(count('messages')).toBe(0);
    expect(count('wechat_delivery_batches')).toBe(0);
  });
  it('消息及回执一次提交，重投只确认，不重复入库', () => {
    enable();
    const receive = receiver();
    const batch = delivery();
    expect(receive(batch)).toMatchObject({ accepted: true, inserted: 1, replayed: false });
    expect(receive(batch)).toMatchObject({ accepted: true, inserted: 0, replayed: true });
    expect(count('messages')).toBe(1);
    expect(count('wechat_delivery_batches')).toBe(1);
    expect(db.prepare('SELECT source,sent_at,text FROM messages').get()).toEqual({
      source: 'wechat', sent_at: 1700000000000, text: batch.messages[0]!.text,
    });
  });
  it('回执写入失败时业务消息也回滚，原批次可以重试', () => {
    enable();
    db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON wechat_delivery_batches
      BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END`);
    const receive = receiver();
    expect(() => receive(delivery())).toThrow('WECHAT_DELIVERY_NOT_COMMITTED');
    expect(count('messages')).toBe(0);
    expect(count('wechat_delivery_batches')).toBe(0);
    db.exec('DROP TRIGGER reject_receipt');
    expect(receive(delivery()).inserted).toBe(1);
  });
  it('消息批次中途失败不留下半批数据或群名修改', () => {
    enable();
    db.exec(`CREATE TRIGGER reject_message BEFORE INSERT ON messages WHEN new.text='reject'
      BEGIN SELECT RAISE(ABORT,'synthetic body failure'); END`);
    const first = delivery().messages[0]!;
    expect(() => receiver()(delivery([first, { ...first, event_id: 'b'.repeat(64), text: 'reject' }]))).
      toThrow('WECHAT_DELIVERY_NOT_COMMITTED');
    expect(count('messages')).toBe(0);
    expect(count('wechat_delivery_batches')).toBe(0);
    expect(db.prepare('SELECT name FROM groups WHERE group_id=?').get(wechatGroupId(ACCOUNT, GROUP))?.name).
      toBe('人工测试群');
  });
  it('目标数据库已切换时拒绝旧绑定，不往新库串消息', () => {
    enable();
    const receive = receiver();
    openDb(':memory:');
    enable();
    expect(() => receive(delivery())).toThrow('WECHAT_DESTINATION_CHANGED');
    expect(count('messages')).toBe(0);
  });
  it('切库中/挂库失败时即使连接没变也拒绝接收', () => {
    enable();
    const receive = receiver();
    vi.spyOn(accounts, 'accountDataState').mockReturnValue('error');
    expect(() => receive(delivery())).toThrow('WECHAT_DESTINATION_CHANGED');
    expect(() => receiver()).toThrow('WECHAT_EXPLICIT_BINDING_REQUIRED');
    expect(count('messages')).toBe(0);
  });
  it('错误空间、微信账号、非选择群和摘要错误均拒绝', () => {
    enable();
    const receive = receiver();
    for (const change of [{ destination: 'other' }, { wechat_account: 'other' },
      { messages: [{ ...delivery().messages[0]!, group_id: 'other@chatroom' }] }]) {
      expect(() => receive({ ...delivery(), ...change })).toThrow('WECHAT_DELIVERY_SCOPE_MISMATCH');
    }
    expect(() => receive({ ...delivery(), batch_id: 'b'.repeat(64) })).toThrow('WECHAT_DELIVERY_DIGEST_OR_LIMIT');
    expect(count('messages')).toBe(0);
  });
  it('未知字段、重复事件、超限与不完整 Unicode 不入库', () => {
    enable();
    const receive = receiver();
    expect(() => receive({ ...delivery(), secret: 'synthetic' })).toThrow('WECHAT_DELIVERY_INVALID');
    const msg = delivery().messages[0]!;
    expect(() => receive(delivery([msg, msg]))).toThrow('WECHAT_DELIVERY_DIGEST_OR_LIMIT');
    expect(() => receive(delivery([{ ...msg, text: '\ud800' }]))).toThrow('WECHAT_DELIVERY_INVALID');
    expect(() => receive(delivery([{ ...msg, text: 'x'.repeat(262145) }]))).toThrow('WECHAT_DELIVERY_INVALID');
    expect(count('messages')).toBe(0);
  });
  it('已提交批次在群关闭后可确认，不再写数据', () => {
    enable();
    const receive = receiver();
    receive(delivery());
    db.prepare('UPDATE groups SET enabled=0').run();
    expect(receive(delivery())).toMatchObject({ inserted: 0, replayed: true });
    expect(count('messages')).toBe(1);
  });
  it('原始消息清理后重投仍不再次整理；新批次也沿用旧去重记录', () => {
    enable();
    const receive = receiver();
    const batch = delivery();
    receive(batch);
    db.exec(`INSERT INTO message_seen(group_id,message_id,sent_at)
      SELECT group_id,message_id,sent_at FROM messages; DELETE FROM messages;`);
    expect(receive(batch).replayed).toBe(true);
    const regrouped = delivery([{ ...batch.messages[0]!, group_name: '新人工群名' }]);
    expect(receive(regrouped).inserted).toBe(0);
    expect(count('messages')).toBe(0);
  });
  it('入库确认丢失、已整理后重投，不再调用提取器或重复建事项', async () => {
    enable();
    extract.mockImplementation(async (input) => [{ action: 'create', update_of: null,
      type: 'assignment', title: '人工测试作业', description: '', start_at: null, end_at: null,
      deadline_at: Date.now() + 86400000, location: null, action_required: null,
      confidence: 0.99, level: 2, source_message_ids: [input.candidates[0]!.message_id] }]);
    const receive = receiver();
    receive(delivery()); // Deliberately lose this acknowledgement.
    await runPipelineNow();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(count('events')).toBe(1);
    receive(delivery());
    await runPipelineNow();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(count('events')).toBe(1);
  });
  it('收到调用方事务时不提前确认或提交调用方数据', () => {
    enable();
    db.exec('BEGIN IMMEDIATE');
    expect(() => receiver()(delivery())).toThrow('WECHAT_OUTER_TRANSACTION');
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
  });
  it('业务库重开后仍认得已确认批次', () => {
    const file = join(directory(), 'business.db');
    openDb(file);
    enable();
    receiver()(delivery());
    openDb(file);
    expect(receiver()(delivery())).toMatchObject({ replayed: true, inserted: 0 });
    expect(count('messages')).toBe(1);
  });
  it('v7 老库增加回执表时保留原消息和群配置', () => {
    const file = join(directory(), 'business.db');
    openDb(file);
    enable();
    receiver()(delivery());
    db.exec("DROP TABLE wechat_delivery_batches; UPDATE kv SET value='7' WHERE key='schema_version'");
    openDb(file);
    expect(count('messages')).toBe(1);
    expect(count('wechat_delivery_batches')).toBe(0);
    expect(db.prepare("SELECT value FROM kv WHERE key='schema_version'").get()?.value).toBe(String(SCHEMA_VERSION));
    expect(receiver()(delivery()).inserted).toBe(0);
  });
});

describe('入库调用方事务边界', () => {
  it('外层回滚也回滚已经返回的消息入库', () => {
    db.exec('BEGIN IMMEDIATE');
    ingestMessages([{ message_id: 'm', group_id: 'demo-g', group_name: '人工',
      sender_name: '人工', text: '人工', sent_at: 1 }], 'demo');
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(count('messages')).toBe(0);
  });
  it('内层批次失败只回滚本次入库，保留调用方之前的改动', () => {
    db.exec(`CREATE TRIGGER reject_nested BEFORE INSERT ON messages WHEN new.text='reject'
      BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO kv(key,value) VALUES ('synthetic-outer','keep')").run();
    const first = { message_id: 'm', group_id: 'demo-g', group_name: '人工',
      sender_name: '人工', text: '人工', sent_at: 1 };
    expect(() => ingestMessages([first, { ...first, message_id: 'n', text: 'reject' }], 'demo')).toThrow();
    expect(db.isTransaction).toBe(true);
    expect(count('messages')).toBe(0);
    expect(db.prepare("SELECT value FROM kv WHERE key='synthetic-outer'").get()?.value).toBe('keep');
    expect(db.prepare("SELECT 1 FROM groups WHERE group_id='demo-g'").get()).toBeUndefined();
    db.exec('COMMIT');
  });
});

const python = process.env.WECHAT4_TEST_PYTHON;
describe.skipIf(!python)('Python 收件箱到 Node 业务库的人工集成', () => {
  function fixture(folder: string, request: Record<string, unknown>) {
    const child = spawnSync(python!, wechatPythonArgs(join(root, 'tools/wechat4-read-probe/test_delivery.py'),
      ['--transport-fixture']), { input: JSON.stringify({ ...request,
        path: join(folder, 'source.wechat-receipts.sqlite3'), destination: DESTINATION }),
      encoding: 'utf8', timeout: 15000, maxBuffer: 4194304, windowsHide: true, env: wechatPythonEnv(), shell: false });
    expect(child.status, `synthetic Python fixture failed: ${child.stderr}`).toBe(0);
    expect(child.stderr).toBe('');
    return JSON.parse(child.stdout);
  }
  it('确认丢失后重开 Python，重投到重开的业务库只入一次，最后回执持久化', () => {
    const folder = directory();
    const file = join(folder, 'business.db');
    openDb(file);
    enable();
    fixture(folder, { action: 'seed', text: ' \n人工中文 😀\u0000\n ' });
    const first = fixture(folder, { action: 'prepare' });
    expect(first.batch_id).toBe(wechatBatchId(first));
    expect(receiver()(first)).toMatchObject({ inserted: 1, replayed: false });
    expect(fixture(folder, { action: 'pending' })).toEqual({ pending: 1, stored: 1 });
    openDb(file);
    const retry = fixture(folder, { action: 'prepare' });
    expect(retry).toEqual(first);
    const acknowledgement = receiver()(retry);
    expect(acknowledgement).toMatchObject({ inserted: 0, replayed: true });
    fixture(folder, { action: 'ack', ack: acknowledgement });
    expect(fixture(folder, { action: 'prepare' })).toBeNull();
    expect(fixture(folder, { action: 'pending' })).toEqual({ pending: 0, stored: 1 });
    expect(count('messages')).toBe(1);
    expect(db.prepare('SELECT text FROM messages').get()?.text).toBe(' \n人工中文 😀\u0000\n ');
  });
  it('125 条积压分 100+25 投递，Python 每步重开后继续', () => {
    const folder = directory();
    enable();
    fixture(folder, { action: 'seed', count: 125 });
    const receive = receiver();
    for (const expected of [100, 25]) {
      const batch = fixture(folder, { action: 'prepare' });
      expect(batch.messages).toHaveLength(expected);
      fixture(folder, { action: 'ack', ack: receive(batch) });
    }
    expect(fixture(folder, { action: 'prepare' })).toBeNull();
    expect(count('messages')).toBe(125);
  });
  it('超过一页的非文本保留隔离，后面的正常文字仍能进入业务库', () => {
    const folder = directory();
    enable();
    fixture(folder, { action: 'seed', count: 125, unsupported: 122 });
    const batch = fixture(folder, { action: 'prepare' });
    expect(batch.messages).toHaveLength(3);
    fixture(folder, { action: 'ack', ack: receiver()(batch) });
    expect(fixture(folder, { action: 'prepare' })).toBeNull();
    expect(fixture(folder, { action: 'status' })).toEqual({ pending: 0, deferred: 122 });
    expect(fixture(folder, { action: 'pending' })).toEqual({ pending: 0, stored: 125 });
    expect(count('messages')).toBe(3);
  });
});
