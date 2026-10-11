import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceChoice, WorkspaceChoiceRequest } from '../../../../shared/workspaces.js';
import type { PlatformIdentity } from './registry.js';

const proof = vi.hoisted(() => ({ qq: null as string | null, wechat: null as string | null, stopped: false }));
vi.mock('../napcat/manager.js', () => ({ getUin: () => proof.qq ?? undefined }));
import {
  accountDataState, accountEpoch, currentAccount, currentDataSpace, deleteAccountData,
  deleteInactiveAccountData, initAccounts, isAccountSwitching, logoutAccountData,
  setAccountsDirForTest, switchAccount, tryAcquireAccountMutationLease, workspaceRuntime,
  resetCurrentWorkspaceData, waitForAccountTransitions,
} from '../accounts.js';
import { accountMutationGuard } from '../account-request-guard.js';
import { db, openDb } from '../db/index.js';
import { accessGuard } from '../lan-guard.js';
import { registerWorkspaceRoutes } from '../routes/workspaces.js';
import { WechatIdentitySession } from '../ingest/wechat-identity-session.js';
import { accountBackupStatus, currentBackupDatabase, restoreCurrentAccountBackup, runAutomaticBackupNow } from '../accounts.js';
import { createPortableBackup, writeParsedBackup } from '../data-backup.js';
import { registerDataRoutes } from '../routes/data.js';
import { DatabaseSync } from 'node:sqlite';
import { startScheduler, quiesceScheduler, stopScheduler } from '../pipeline/scheduler.js';

const QQ = { platform: 'qq' as const, account_id: '10001' };
const WX = { platform: 'wechat' as const, account_id: 'wxid_synthetic_runtime' };
let root: string;
let stopped: ReturnType<typeof vi.fn>;
let restarted: ReturnType<typeof vi.fn>;
function verify(input: PlatformIdentity): boolean { return !proof.stopped && proof[input.platform] === input.account_id; }
function options(revalidate?: (identity: PlatformIdentity) => Promise<boolean>) {
  return { dataDir: root, accountsDir: join(root, 'accounts'), fallbackDb: join(root, 'fallback.db'),
    workspace: { automaticWorkspace: false, verifyIdentity: verify, stopCollectors: stopped, restartCollectors: restarted,
      ...(revalidate ? { revalidateIdentity: revalidate } : {}) } };
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'classrep-workspace-runtime-synthetic-'));
  proof.qq = null; proof.wechat = null; proof.stopped = false;
  stopped = vi.fn(() => { proof.stopped = true; });
  restarted = vi.fn(() => { proof.stopped = false; });
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  await initAccounts(options());
});
afterEach(async () => {
  db?.close();
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  const rel = relative(realpathSync(tmpdir()), realpathSync(root));
  if (!rel.startsWith('classrep-workspace-runtime-synthetic-') || rel.includes('..') || isAbsolute(rel)) {
    throw new Error('SYNTHETIC_CLEANUP_PATH');
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  // The synchronous SQLite cases can exceed Vitest's RPC window together on CI.
  // Let the worker receive result acknowledgements between cases.
  await yieldToEventLoop();
});
function runtime() { return workspaceRuntime()!; }
async function reinitialize(settings: NonNullable<Parameters<typeof initAccounts>[0]>) {
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  await initAccounts(settings);
}
function request(choice: WorkspaceChoice, confirm = false): WorkspaceChoiceRequest {
  return { request_id: runtime().status().pending[0]!.request_id, expected_account_epoch: accountEpoch(),
    choice, confirm_switch: confirm };
}
async function newQq() {
  proof.qq = QQ.account_id;
  await switchAccount(QQ.account_id);
  await runtime().choose(request({ mode: 'create', name: '人工 A' }));
  return currentDataSpace()!;
}
function seed() {
  db.prepare(`INSERT INTO messages(message_id,group_id,sender_name,text,sent_at,source,created_at)
    VALUES ('synthetic','g','人工','人工测试',1,'demo',1)`).run();
}
function count() { return Number(db.prepare('SELECT count(*) AS n FROM messages').get()?.n); }
function app(stopWechat?: () => Promise<void>) {
  const result = new Hono();
  result.use('*', accessGuard({ lanToken: () => 'synthetic-token', lanHosts: () => [] }));
  result.use('*', accountMutationGuard());
  registerWorkspaceRoutes(result, stopWechat);
  result.get('/api/today', (c) => c.json({ count: count() }));
  return result;
}
function chooseHttp(body: unknown, local = true) {
  return app().request('/api/workspaces/choice', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) }, { incoming: { socket: { remoteAddress: local ? '127.0.0.1' : '192.168.1.3' } } });
}

describe('实际账号运行时中的空间选择与独立平台会话（人工身份）', () => {
  it('恢复前备份目录不可写时仍恢复调度器', async () => {
    await newQq(); seed();
    const directory = dirname(currentBackupDatabase()!);
    const candidate = join(directory, 'synthetic-restore.db');
    writeParsedBackup(createPortableBackup(), candidate);
    const backupDir = join(directory, 'backups');
    if (!relative(root, backupDir).startsWith('spaces')) throw new Error('SYNTHETIC_PATH');
    rmSync(backupDir, { recursive: true }); writeFileSync(backupDir, 'synthetic blocker');
    startScheduler();
    try {
      await expect(restoreCurrentAccountBackup(accountEpoch(), candidate)).rejects.toThrow();
      expect(await quiesceScheduler()).toBe(true);
      expect(count()).toBe(1); expect(existsSync(candidate)).toBe(true);
    } finally { stopScheduler(); }
  });
  it('微信独立空间可导出和恢复；加入 QQ 后仍恢复同一空间，不写 QQ 旧目录', async () => {
    proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-worker');
    await runtime().choose(request({ mode: 'create', name: '人工微信空间' }));
    seed();
    const database = currentBackupDatabase()!;
    expect(database).toContain(join(root, 'spaces'));
    expect(runAutomaticBackupNow()).toBe(true);
    expect(accountBackupStatus().automatic_count).toBe(1);
    db.exec("INSERT INTO groups(group_id,name,adapter,enabled,created_at) VALUES ('wx-test','人工','wechat',1,1)");
    db.exec("INSERT INTO kv(key,value) VALUES ('wechat_selection_v1:test','synthetic')");
    const stop = vi.fn(async () => {});
    const server = new Hono(); registerDataRoutes(server, stop);
    const download = await server.request('/api/settings/data/backup');
    expect(download.status).toBe(200);
    const backup = new Uint8Array(await download.arrayBuffer());
    proof.qq = QQ.account_id; await runtime().observe(QQ);
    await runtime().choose(request({ mode: 'current' }));
    const receipts = join(dirname(database), 'wechat-receipts');
    mkdirSync(receipts); writeFileSync(join(receipts, 'synthetic'), 'ack');
    db.exec("DELETE FROM messages");
    const epoch = accountEpoch();
    const restored = await server.request('/api/settings/data/restore', { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-ClassRep-Account-Epoch': epoch }, body: backup });
    expect(restored.status).toBe(200); expect(stop).toHaveBeenCalledOnce();
    expect(currentBackupDatabase()).toBe(database); expect(count()).toBe(1);
    expect(accountEpoch()).not.toBe(epoch);
    expect(existsSync(join(root, 'accounts', QQ.account_id, 'classrep.db'))).toBe(false);
    expect(existsSync(receipts)).toBe(false);
    expect(db.prepare("SELECT value FROM kv WHERE key LIKE 'wechat_selection_v1:%'").get()).toBeUndefined();
    expect(db.prepare("SELECT enabled FROM groups WHERE group_id='wx-test'").get()?.enabled).toBe(0);
  });

  it('恢复候选 SQL 失败时回滚原空间数据库和微信回执', async () => {
    await newQq(); seed();
    const database = currentBackupDatabase()!;
    const candidate = join(dirname(database), 'synthetic-restore.db');
    writeParsedBackup(createPortableBackup(), candidate);
    const raw = new DatabaseSync(candidate);
    raw.exec("INSERT INTO kv(key,value) VALUES ('wechat_selection_v1:test','synthetic')");
    raw.exec("CREATE TRIGGER reject_restore BEFORE DELETE ON kv BEGIN SELECT RAISE(ABORT, 'synthetic reject'); END");
    raw.close();
    const receipts = join(dirname(database), 'wechat-receipts');
    mkdirSync(receipts); writeFileSync(join(receipts, 'synthetic'), 'ack');
    await expect(restoreCurrentAccountBackup(accountEpoch(), candidate)).rejects.toThrow('synthetic reject');
    expect(currentBackupDatabase()).toBe(database); expect(count()).toBe(1);
    expect(existsSync(join(receipts, 'synthetic'))).toBe(true);
    expect(accountDataState()).toBe('ready');
  });

  it('停止采集时身份撤销会阻止恢复，不碰原库', async () => {
    await newQq(); seed();
    await runtime().observe(QQ, 'restore-key');
    const candidate = join(dirname(currentBackupDatabase()!), 'synthetic-stale.db');
    writeParsedBackup(createPortableBackup(), candidate);
    const epoch = accountEpoch();
    const result = await restoreCurrentAccountBackup(epoch, candidate, async () => {
      proof.qq = null;
      void runtime().revoke(QQ, 'restore-key');
    });
    expect(result.status).toBe('stale');
    await waitForAccountTransitions();
    expect(existsSync(candidate)).toBe(true);
  });

  it('清空只作用于当前空间，等待在途请求，重置回执并保留绑定', async () => {
    const space = await newQq(); seed();
    const binding = runtime().status().current;
    const file = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')!.file as string;
    const receipts = join(dirname(file), 'wechat-receipts');
    mkdirSync(receipts); writeFileSync(join(receipts, 'synthetic.sqlite3'), 'synthetic');
    db.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run('wechat_selection_v1:synthetic', 'synthetic');
    const epoch = accountEpoch();
    const lease = tryAcquireAccountMutationLease(epoch)!;
    const stop = vi.fn(async () => {});
    const resetting = resetCurrentWorkspaceData(epoch, stop);
    expect(isAccountSwitching()).toBe(true);
    expect(count()).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    lease.release(); await resetting;
    expect(count()).toBe(0);
    expect(existsSync(receipts)).toBe(false);
    expect(db.prepare("SELECT value FROM kv WHERE key LIKE 'wechat_selection%'").get()).toBeUndefined();
    expect(runtime().status().current).toEqual(binding);
    expect(currentDataSpace()).toBe(space);
    expect(accountEpoch()).not.toBe(epoch);
    await expect(resetCurrentWorkspaceData(epoch, stop)).rejects.toThrow('WORKSPACE_REQUEST_STALE');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('清空 SQL 失败时保留原始数据和微信回执', async () => {
    await newQq(); seed();
    const file = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')!.file as string;
    const receipts = join(dirname(file), 'wechat-receipts');
    mkdirSync(receipts); writeFileSync(join(receipts, 'synthetic.sqlite3'), 'synthetic');
    db.exec("CREATE TRIGGER reject_reset BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    await expect(resetCurrentWorkspaceData(accountEpoch(), async () => {})).rejects.toThrow('synthetic failure');
    expect(count()).toBe(1);
    expect(existsSync(join(receipts, 'synthetic.sqlite3'))).toBe(true);
    expect(accountDataState()).toBe('ready');
  });
  it('清空接口要求当前空间令牌和明确确认', async () => {
    await newQq(); seed();
    const stop = vi.fn(async () => {});
    const call = (body: unknown) => app(stop).request('/api/workspaces/reset-data', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect((await call({ expected_account_epoch: accountEpoch() })).status).toBe(400);
    expect((await call({ expected_account_epoch: 'stale', confirm: true })).status).toBe(409);
    expect(count()).toBe(1);
    expect((await call({ expected_account_epoch: accountEpoch(), confirm: true })).status).toBe(200);
    expect(count()).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('唯一空间默认存在，平台登录自动接入，断开一个平台保留另一个平台', async () => {
    const settings = options();
    await reinitialize({ ...settings, workspace: { ...settings.workspace, automaticWorkspace: true } });
    expect(runtime().status().current?.name).toBe('我的空间');
    expect(runtime().hasAccess()).toBe(false);
    proof.qq = QQ.account_id;
    await switchAccount(QQ.account_id);
    const space = currentDataSpace(); seed();
    proof.wechat = WX.account_id;
    expect(await runtime().observe(WX, 'wx-auto')).toBe('ready');
    expect(currentDataSpace()).toBe(space);
    expect(runtime().status().pending).toEqual([]);
    expect(runtime().registry.list()).toHaveLength(1);
    expect(runtime().status().current?.bindings).toHaveLength(2);
    const rejected = await chooseHttp({ request_id: randomUUID(), expected_account_epoch: accountEpoch(),
      choice: { mode: 'create', name: '第二个空间' }, confirm_switch: false });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: '本机只有一个固定空间，登录后自动接入，无需选择空间' });
    expect(runtime().registry.list()).toHaveLength(1);
    await runtime().logout('qq', accountEpoch());
    expect(runtime().currentWechat()).toBe(WX.account_id);
    expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
  });
  it('自动连接同时排队后仍只创建一个空间，换平台账号沿用空间', async () => {
    const settings = options();
    await reinitialize({ ...settings, workspace: { ...settings.workspace, automaticWorkspace: true } });
    proof.qq = QQ.account_id; proof.wechat = WX.account_id;
    await Promise.all([runtime().observe(QQ, 'qq-auto'), runtime().observe(WX, 'wx-auto')]);
    const space = currentDataSpace(); seed();
    proof.qq = '10002';
    await runtime().observe({ platform: 'qq', account_id: '10002' }, 'qq-new');
    expect(runtime().registry.list()).toHaveLength(1);
    expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
    expect(runtime().currentWechat()).toBe(WX.account_id);
    expect(runtime().status().current?.bindings.filter(b => b.platform === 'qq')).toEqual([{ platform: 'qq', account_id: '10002' }]);
  });
  it('空间改名持久化，过期请求、无效名称和局域网写入均拒绝', async () => {
    const settings = options();
    await reinitialize({ ...settings, workspace: { ...settings.workspace, automaticWorkspace: true } });
    const renameHttp = (name: string, epoch: string, local = true) => app().request('/api/workspaces/name', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, expected_account_epoch: epoch }),
    }, { incoming: { socket: { remoteAddress: local ? '127.0.0.1' : '192.168.1.3' } } });
    expect((await renameHttp('课程空间', accountEpoch())).status).toBe(200);
    expect((await renameHttp('错名', 'stale')).status).toBe(409);
    expect((await renameHttp('', accountEpoch())).status).toBe(400);
    expect([401, 403]).toContain((await renameHttp('错名', accountEpoch(), false)).status);
    await reinitialize({ ...settings, workspace: { ...settings.workspace, automaticWorkspace: true } });
    expect(runtime().status().current?.name).toBe('课程空间');
  });
  it('旧 QQ 和微信库合并事件及引用，原库保留，重复启动不重复插入', async () => {
    const qqSpace = await newQq(); seed();
    db.prepare("INSERT INTO events(group_id,type,title,confidence,created_at,updated_at) VALUES ('qq-g','notice','QQ event',1,1,1)").run();
    proof.wechat = WX.account_id;
    await runtime().observe(WX, 'wx-old');
    await runtime().choose(request({ mode: 'create', name: '旧微信空间' }, true));
    const wxSpace = currentDataSpace()!;
    const selectionKey = (space: string) => 'wechat_selection_v1:' + createHash('sha256')
      .update(JSON.stringify([space, WX.account_id])).digest('hex');
    db.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run(selectionKey(wxSpace),
      JSON.stringify({ version: 1, destination: wxSpace, account: WX.account_id, groups: [] }));
    db.prepare('INSERT INTO wechat_delivery_batches VALUES (?,?,?,?,?)').run(wxSpace, WX.account_id, 'synthetic-batch', 1, 1);
    db.prepare("INSERT INTO events(group_id,type,title,confidence,created_at,updated_at) VALUES ('wx-g','notice','WX event',1,1,1)").run();
    db.prepare("INSERT INTO event_sources(event_id,message_id,sender_name,text,sent_at) VALUES (1,'wx-msg','synthetic','wx-source',1)").run();
    const wxPath = runtime().registry.businessDbPath(wxSpace, { spaces: join(root, 'spaces'), accounts: join(root, 'accounts') });
    const settings = options();
    await reinitialize({ ...settings, workspace: { ...settings.workspace, automaticWorkspace: true } });
    proof.stopped = false; proof.qq = QQ.account_id;
    await switchAccount(QQ.account_id);
    expect(currentDataSpace()).toBe(qqSpace);
    expect(db.prepare('SELECT title FROM events ORDER BY id').all()).toEqual([{ title: 'QQ event' }, { title: 'WX event' }]);
    expect(db.prepare('SELECT e.title FROM events e JOIN event_sources s ON s.event_id=e.id').get()?.title).toBe('WX event');
    expect(existsSync(wxPath)).toBe(true);
    expect(runtime().registry.list()).toHaveLength(1);
    expect(runtime().status().current?.name).toBe('我的空间');
    expect(runtime().registry.find(WX)?.space_id).toBe(qqSpace);
    expect(JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key=?').get(selectionKey(qqSpace))?.value)).destination).toBe(qqSpace);
    expect(db.prepare('SELECT destination FROM wechat_delivery_batches').get()?.destination).toBe(qqSpace);
    await reinitialize({ ...settings, workspace: { ...settings.workspace, automaticWorkspace: true } });
    await switchAccount(QQ.account_id);
    expect(db.prepare('SELECT count(*) AS n FROM events').get()?.n).toBe(2);
  });
  it('forwards current WeChat capability and its unavailable reason to the connection page', async () => {
    let available = false;
    const settings = options();
    await reinitialize({ ...settings, workspace: { ...settings.workspace,
      wechatCapability: () => available ? { available: true } : { available: false, reason: 'runtime_missing' },
    } });
    expect(runtime().status()).toMatchObject({ wechat_available: false, wechat_unavailable_reason: 'runtime_missing' });
    available = true;
    expect(runtime().status().wechat_available).toBe(true);
    expect(runtime().status()).not.toHaveProperty('wechat_unavailable_reason');
  });
  it('绑定排队后重新采样失败时，不沿用排队前身份新增归属', async () => {
    const revalidate = vi.fn(async () => false);
    await reinitialize(options(revalidate));
    const space = await newQq(); seed(); proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-live-source');
    const lease = tryAcquireAccountMutationLease()!;
    const choosing = runtime().choose(request({ mode: 'current' }));
    const rejected = expect(choosing).rejects.toThrow('WORKSPACE_LOGIN_NOT_VERIFIED');
    lease.release(); await rejected;
    expect(revalidate).toHaveBeenCalledWith(WX);
    expect(runtime().registry.find(WX)).toBeNull();
    expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
  });
  it('跨空间停止消息采集后，微信身份仍须重新核实，不能沿用冻结证明', async () => {
    const revalidate = vi.fn(async () => false);
    await reinitialize(options(revalidate));
    const space = await newQq(); seed();
    const target = runtime().registry.createForIdentity(WX, '人工微信目标');
    proof.wechat = WX.account_id; await runtime().observe(WX, 'synthetic-live-source');
    await expect(runtime().choose(request({ mode: 'known' }, true))).rejects.toThrow('WORKSPACE_LOGIN_NOT_VERIFIED');
    expect(stopped).toHaveBeenCalled(); expect(revalidate).toHaveBeenCalledWith(WX);
    expect(runtime().registry.find(WX)?.space_id).toBe(target.space_id);
    expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
  });
  it('异步重新采样期间撤销来源，即使旧采样随后返回成功也不能绑定', async () => {
    let resolve!: (value: boolean) => void; let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    await reinitialize(options(async () => { entered(); return new Promise((r) => { resolve = r; }); }));
    const space = await newQq(); proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-live-source');
    const choosing = runtime().choose(request({ mode: 'current' }));
    const rejected = expect(choosing).rejects.toThrow('WORKSPACE_REQUEST_STALE');
    await started;
    const revoked = runtime().revoke(WX, 'synthetic-live-source');
    resolve(true); await rejected; await revoked;
    expect(runtime().registry.find(WX)).toBeNull(); expect(currentDataSpace()).toBe(space);
  });
  it('身份监测组件实际联动空间撤销：失效后 QQ 继续访问，旧微信不自动恢复', async () => {
    let session!: WechatIdentitySession; let invalidate!: () => void;
    let evidence: { account: string; generation: number } | null = null;
    const settings = options();
    await reinitialize({ ...settings, workspace: { ...settings.workspace,
      verifyIdentity: (identity) => identity.platform === 'wechat' ? session?.verifies(identity.account_id) === true : verify(identity),
      revalidateIdentity: (identity) => session.revalidate(identity.account_id),
    } });
    const space = await newQq(); seed();
    session = new WechatIdentitySession({ root: 'unused synthetic',
      onVerified: (account, key) => runtime().observe({ platform: 'wechat', account_id: account }, key),
      onRevoked: (account, key) => runtime().revoke({ platform: 'wechat', account_id: account }, key),
      createChannel: (callback) => { invalidate = callback; return {
        sample: async () => { evidence = { account: WX.account_id, generation: 1 }; return evidence; },
        current: () => evidence, isCurrent: (item) => evidence === item,
        close: async () => { evidence = null; invalidate(); },
      }; },
    });
    try {
      await session.start(true); await runtime().choose(request({ mode: 'current' }));
      invalidate(); expect(session.verifies(WX.account_id)).toBe(false);
      await session.close();
      expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
      expect(runtime().registry.find(WX)?.space_id).toBe(space);
      expect(runtime().status().pending).toEqual([]);
      await expect(session.start(true)).rejects.toThrow('WECHAT_IDENTITY_SESSION_CLOSED');
    } finally { await session.close(); }
  });
  it('微信身份失效只撤销微信，QQ 保持空间与数据访问', async () => {
    const space = await newQq(); seed();
    proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-worker-1');
    await runtime().choose(request({ mode: 'current' }));
    const epoch = accountEpoch();
    proof.wechat = null;
    expect(await runtime().revoke(WX, 'synthetic-worker-1')).toBe(true);
    expect(currentDataSpace()).toBe(space); expect(currentAccount()).toBe(QQ.account_id);
    expect(count()).toBe(1); expect(accountEpoch()).not.toBe(epoch);
    expect(stopped).not.toHaveBeenCalled();
    expect(runtime().registry.find(WX)?.space_id).toBe(space);
  });
  it('最后平台失效立即隐藏空间，再等在途请求释放，保留原业务库', async () => {
    proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-worker-1');
    await runtime().choose(request({ mode: 'create', name: '人工微信空间' }));
    const space = currentDataSpace()!; seed();
    const lease = tryAcquireAccountMutationLease()!;
    proof.wechat = null;
    const revoked = runtime().revoke(WX, 'synthetic-worker-1');
    expect(currentDataSpace()).toBeNull();
    expect(runtime().status().current).toBeNull();
    expect(tryAcquireAccountMutationLease()).toBeNull();
    lease.release(); await revoked;
    proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-worker-2');
    expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
  });
  it('旧组件迟到失效事件不能撤销同账号新连接', async () => {
    proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-worker-old');
    await runtime().choose(request({ mode: 'create', name: '人工空间' }));
    const space = currentDataSpace();
    await runtime().observe(WX, 'synthetic-worker-new');
    expect(await runtime().revoke(WX, 'synthetic-worker-old')).toBe(false);
    expect(currentDataSpace()).toBe(space);
    expect(await runtime().revoke({ ...WX, account_id: 'wxid_synthetic_other' }, 'synthetic-worker-new')).toBe(false);
    expect(currentDataSpace()).toBe(space);
  });
  it('撤销等待中的绑定请求，不新增归属、不影响另一平台', async () => {
    const space = await newQq();
    proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-worker-1');
    const lease = tryAcquireAccountMutationLease()!;
    const selecting = runtime().choose(request({ mode: 'current' }));
    expect(await runtime().revoke(WX, 'synthetic-worker-1')).toBe(true);
    lease.release();
    await expect(selecting).rejects.toThrow('STALE');
    expect(runtime().registry.find(WX)).toBeNull();
    expect(currentDataSpace()).toBe(space); expect(currentAccount()).toBe(QQ.account_id);
  });
  it('撤销队列中的已知登录，不能因旧的 verify 返回值恢复会话', async () => {
    proof.wechat = WX.account_id;
    await runtime().observe(WX, 'synthetic-worker-1');
    await runtime().choose(request({ mode: 'create', name: '人工空间' }));
    const lease = tryAcquireAccountMutationLease()!;
    const observing = runtime().observe(WX, 'synthetic-worker-2');
    const revoking = runtime().revoke(WX, 'synthetic-worker-2');
    expect(currentDataSpace()).toBeNull();
    lease.release();
    await expect(observing).rejects.toThrow('NOT_VERIFIED');
    await revoking;
    expect(currentDataSpace()).toBeNull();
  });
  it('未校验身份或非法来源标记不能登记来源或撤销有效连接', async () => {
    proof.wechat = WX.account_id;
    await expect(runtime().observe(WX, 'private text')).rejects.toThrow('NOT_VERIFIED');
    expect(await runtime().revoke(WX, 'private text')).toBe(false);
    expect(runtime().registry.find(WX)).toBeNull();
  });
  it('记住的 QQ 不是登录凭据；未验证身份不能创建空间', async () => {
    expect(currentAccount()).toBeNull();
    expect(runtime().status().current).toBeNull();
    await expect(switchAccount(QQ.account_id)).rejects.toThrow('NOT_VERIFIED');
    expect(runtime().registry.list()).toEqual([]);
  });
  it('未知账号先选择，HTTP 不得伪造平台登录或跳过待选择请求', async () => {
    proof.qq = QQ.account_id;
    await switchAccount(QQ.account_id);
    expect(currentAccount()).toBeNull();
    expect(runtime().registry.list()).toEqual([]);
    const choice = request({ mode: 'create', name: '人工 A' });
    expect((await chooseHttp({ ...choice, account_id: '10002' })).status).toBe(400);
    expect((await chooseHttp({ ...choice, request_id: '10000000-0000-4000-8000-000000000000' })).status).toBe(409);
    expect((await chooseHttp(choice)).status).toBe(200);
    expect(currentAccount()).toBe(QQ.account_id);
    expect(runtime().registry.list()).toHaveLength(1);
    expect((await chooseHttp(choice)).status).toBe(409);
  });
  it('明确绑定同一空间，退出 QQ 后微信独立访问原库；最后退出隐藏并可恢复', async () => {
    const space = await newQq(); seed();
    proof.wechat = WX.account_id;
    await runtime().observe(WX);
    await runtime().choose(request({ mode: 'current' }));
    const epoch = accountEpoch();
    const cleared = vi.fn();
    expect(await logoutAccountData({ expectedEpoch: epoch, expectedUin: QQ.account_id,
      sessionUin: QQ.account_id, erase: false, onAccepted: vi.fn(), clearSession: cleared })).toBe('logged_out');
    expect(cleared).toHaveBeenCalledOnce();
    expect(currentAccount()).toBeNull();
    expect(currentDataSpace()).toBe(space);
    expect(count()).toBe(1);
    expect(tryAcquireAccountMutationLease(epoch)).toBeNull();
    await runtime().logout('wechat', accountEpoch());
    expect(currentDataSpace()).toBeNull();
    expect(count()).toBe(0);
    await runtime().observe(WX);
    expect(currentDataSpace()).toBe(space);
    expect(count()).toBe(1);
  });
  it('新 QQ 到来先隐藏只由旧 QQ 授权的数据，不能用当前绑定绕过单平台上限', async () => {
    await newQq(); seed();
    proof.qq = '10002';
    await switchAccount('10002');
    expect(accountDataState()).toBe('locked');
    expect(runtime().status().current).toBeNull();
    expect(tryAcquireAccountMutationLease()).toBeNull();
    expect((await app().request('/api/today', { headers: { 'X-ClassRep-Account-Epoch': accountEpoch() } },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } })).status).toBe(409);
    await expect(runtime().choose(request({ mode: 'current' }))).rejects.toThrow('NO_CURRENT');
    expect(runtime().registry.list()).toHaveLength(1);
  });
  it('另一平台维持当前空间时，同平台第二账号不能绑定进来', async () => {
    const space = await newQq();
    runtime().registry.bindToExisting(WX, space);
    proof.wechat = WX.account_id; await runtime().observe(WX);
    proof.qq = '10002'; await switchAccount('10002');
    expect(currentDataSpace()).toBe(space);
    expect((await chooseHttp(request({ mode: 'current' }))).status).toBe(409);
    expect(currentDataSpace()).toBe(space);
    expect(accountDataState()).toBe('ready');
  });
  it('已绑定其他空间须确认，关采集闸后等在途写请求，再切换；旧 epoch 失效', async () => {
    const first = await newQq(); seed();
    const other = runtime().registry.createForIdentity(WX, '人工 B');
    proof.wechat = WX.account_id; await runtime().observe(WX);
    const choice = request({ mode: 'known' });
    const lease = tryAcquireAccountMutationLease()!;
    expect((await chooseHttp(choice)).status).toBe(409);
    expect(stopped).not.toHaveBeenCalled();
    expect(currentDataSpace()).toBe(first);
    const pending = runtime().choose({ ...choice, confirm_switch: true });
    expect(stopped).toHaveBeenCalledOnce();
    expect(isAccountSwitching()).toBe(true);
    expect(tryAcquireAccountMutationLease()).toBeNull();
    expect(currentDataSpace()).toBe(first);
    lease.release(); await pending;
    expect(currentDataSpace()).toBe(other.space_id);
    expect(currentAccount()).toBeNull();
    expect(count()).toBe(0);
    expect(tryAcquireAccountMutationLease(choice.expected_account_epoch)).toBeNull();
    // Only the selected platform reconnects. Switching to WX must not restart old QQ.
    expect(restarted).toHaveBeenCalledTimes(1);
  });
  it('当前空间绑定请求等待期间掉线，不能用排队前的身份继续绑定', async () => {
    await newQq();
    proof.wechat = WX.account_id; await runtime().observe(WX);
    const lease = tryAcquireAccountMutationLease()!;
    const pending = runtime().choose(request({ mode: 'current' }));
    proof.wechat = null;
    lease.release();
    await expect(pending).rejects.toThrow('NOT_VERIFIED');
    expect(runtime().registry.find(WX)).toBeNull();
    expect(currentAccount()).toBe(QQ.account_id);
  });
  it('空间或登录已变化，旧退出请求不清新会话', async () => {
    await newQq();
    const epoch = accountEpoch();
    await runtime().observe(QQ);
    const onAccepted = vi.fn(); const clearSession = vi.fn();
    expect(await logoutAccountData({ expectedEpoch: epoch, expectedUin: QQ.account_id,
      sessionUin: QQ.account_id, erase: false, onAccepted, clearSession })).toBe('stale');
    expect(onAccepted).not.toHaveBeenCalled(); expect(clearSession).not.toHaveBeenCalled();
    expect(currentAccount()).toBe(QQ.account_id);
  });
  it('拒绝旧删除接口，空间数据和平台绑定不改变', async () => {
    const space = await newQq(); seed();
    await expect(deleteAccountData(QQ.account_id)).rejects.toThrow('DELETE_SEPARATE');
    expect(await deleteInactiveAccountData('10002')).toBe('space_owned');
    await expect(logoutAccountData({ expectedEpoch: accountEpoch(), expectedUin: QQ.account_id,
      sessionUin: QQ.account_id, erase: true, onAccepted: vi.fn(), clearSession: vi.fn() })).rejects.toThrow('DELETE_SEPARATE');
    expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
  });
  it('元数据先提交、业务库挂载失败后，原始选择能刷新成已知目标并重试', async () => {
    proof.qq = QQ.account_id; await switchAccount(QQ.account_id);
    const choice = request({ mode: 'create', name: '人工 A' });
    writeFileSync(join(root, 'spaces'), 'synthetic obstacle');
    expect((await chooseHttp(choice)).status).toBe(503);
    expect(accountDataState()).toBe('error');
    expect(runtime().status().pending[0]?.kind).toBe('switch');
    expect(runtime().status().pending[0]?.request_id).not.toBe(choice.request_id);
    expect(runtime().registry.list()).toHaveLength(1);
    rmSync(join(root, 'spaces'));
    expect((await chooseHttp(request({ mode: 'known' }))).status).toBe(200);
    expect(accountDataState()).toBe('ready');
    expect(currentAccount()).toBe(QQ.account_id);
    expect(runtime().registry.list()).toHaveLength(1);
  });
  it('服务重启只恢复绑定，不从保存的账号重建认证；验证后进入原空间', async () => {
    const space = await newQq(); seed();
    db.close(); setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
    await initAccounts(options());
    expect(currentAccount()).toBeNull(); expect(currentDataSpace()).toBeNull(); expect(count()).toBe(0);
    await switchAccount(QQ.account_id);
    expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
  });
  it('生产默认兜底库与旧单库分开，重启不会误迁移兜底为 QQ 库', async () => {
    db.close(); setAccountsDirForTest(join(root, 'accounts'));
    const { fallbackDb: _unused, ...defaults } = options();
    await initAccounts(defaults);
    const space = await newQq(); seed();
    expect(existsSync(join(root, 'workspace-fallback.db'))).toBe(true);
    expect(existsSync(join(root, 'classrep.db'))).toBe(false);
    db.close(); setAccountsDirForTest(join(root, 'accounts'));
    await initAccounts(defaults);
    expect(existsSync(join(root, 'accounts', QQ.account_id, 'classrep.db'))).toBe(false);
    await switchAccount(QQ.account_id);
    expect(currentDataSpace()).toBe(space); expect(count()).toBe(1);
  });
  it('旧 QQ 只登记原目录，验证身份前不公开数据，之后直接使用原库', async () => {
    const path = join(root, 'accounts', QQ.account_id, 'classrep.db');
    openDb(path); seed(); db.close();
    setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
    await initAccounts(options());
    expect(count()).toBe(0);
    const saved = runtime().registry.find(QQ)!;
    expect(saved.storage_kind).toBe('legacy_qq'); expect(existsSync(path)).toBe(true);
    proof.qq = QQ.account_id; await switchAccount(QQ.account_id);
    expect(count()).toBe(1); expect(currentDataSpace()).toBe(saved.space_id);
  });
  it('手机只读连接和跨站网页不能选择空间', async () => {
    proof.qq = QQ.account_id; await switchAccount(QQ.account_id);
    const body = request({ mode: 'create', name: '人工 A' });
    expect((await chooseHttp(body, false)).status).toBe(401);
    const response = await app().request('/api/workspaces/choice', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://synthetic.invalid' }, body: JSON.stringify(body) },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
    expect(response.status).toBe(403); expect(runtime().registry.list()).toEqual([]);
  });
});
