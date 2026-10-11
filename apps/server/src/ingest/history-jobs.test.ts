import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, notifyAccountSwitch, openDb } from '../db/index.js';
import { HistoryJobs } from './history-jobs.js';
import { recordHistoryJobMessages } from './history-job-counts.js';
import { cancelHistorySync, setHistorySyncCoordinator, syncHistory } from './history.js';
import type { Message } from '../types.js';
import type { WechatIntake } from './wechat-intake.js';

const state = vi.hoisted(() => ({ epoch: 'synthetic-epoch', account: '10001', online: true, action: vi.fn() }));
vi.mock('../accounts.js', () => ({ accountDataState: () => 'ready', accountEpoch: () => state.epoch,
  currentAccount: () => state.account }));
vi.mock('../napcat/onebot.js', () => ({ isOnline: () => state.online, callAction: state.action,
  getGroupNameCached: (id: string) => id, isMentionOther: () => false,
  toMessage: (raw: Record<string, unknown>): Message => ({ message_id: String(raw.message_id),
    group_id: String(raw.group_id), group_name: 'Synthetic', sender_name: 'Synthetic', text: 'synthetic notice', sent_at: Number(raw.time) * 1000 }) }));
const row = (id: number, offset = id) => ({ group_id: 1001, message_id: id, time: Math.floor(Date.now() / 1000) - offset });
const intake = () => ({ historyContext: vi.fn(() => ({ account: 'wxid_synthetic', epoch: state.epoch, intakeId: 'synthetic-intake', groups: ['test@chatroom'] })),
  history: vi.fn<WechatIntake['history']>().mockResolvedValue({ inserted: 0, has_more: false }) });
const request = () => ({ platform: 'qq' as const, days: 7 as const, expected_account_epoch: state.epoch });
const count = () => Number(db.prepare('SELECT COUNT(*) n FROM messages').get()?.n);
const commitWechatCount = (jobId: string, group: string, inserted: number) => {
  db.exec('BEGIN');
  try { recordHistoryJobMessages(jobId, group, inserted); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
};
const complete = async (jobs: HistoryJobs) => { await vi.waitFor(() => expect(['running', 'cancelling']).not.toContain(jobs.list()[0]?.status)); return jobs.list()[0]!; };

beforeAll(() => openDb(':memory:'));
afterAll(() => db.close());
afterEach(() => setHistorySyncCoordinator(null));
beforeEach(() => {
  state.epoch = 'synthetic-epoch'; state.account = '10001'; state.online = true; state.action.mockReset();
  db.exec('DELETE FROM messages; DELETE FROM message_seen; DELETE FROM groups; DELETE FROM group_sync; DELETE FROM kv WHERE key LIKE \'history_job_v1:%\';');
  db.prepare("INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES ('1001','Synthetic',1,'onebot',?)").run(Date.now());
  state.action.mockResolvedValue({ messages: [] });
});

describe('durable history jobs', () => {
  it('automatic login, legacy endpoint and manual starts share a single durable job and completion', async () => {
    let respond!: (value: unknown) => void;
    state.action.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const jobs = new HistoryJobs(intake()); jobs.coordinateQQ();
    const automatic = syncHistory(7), legacy = syncHistory(7);
    const manual = jobs.create(request());
    await vi.waitFor(() => expect(state.action).toHaveBeenCalledTimes(1));
    expect(jobs.list()).toHaveLength(1);
    expect(jobs.list()[0]?.id).toBe(manual.id);
    respond({ messages: [row(901, 100), row(900, 8 * 86400)] });
    const results = await Promise.all([automatic, legacy]);
    expect(results).toEqual([{ groups: 1, messages: 1, failures: 0 }, { groups: 1, messages: 1, failures: 0 }]);
    expect(jobs.list()[0]).toMatchObject({ status: 'completed', messages: 1 });
    expect(state.action.mock.calls.filter(([action]) => action === 'get_group_msg_history')).toHaveLength(1);
  });
  it('legacy cancellation aborts the shared active page and does not mark automatic completion successful', async () => {
    state.action.mockImplementation((_action, _params, _timeout, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const jobs = new HistoryJobs(intake()); jobs.coordinateQQ();
    const automatic = syncHistory(7), rejected = expect(automatic).rejects.toThrow('HISTORY_CANCELLED');
    await vi.waitFor(() => expect(state.action).toHaveBeenCalledTimes(1));
    cancelHistorySync(); await rejected;
    expect(jobs.list()[0]).toMatchObject({ status: 'cancelled', messages: 0, retryable: true });
  });
  it('returns immediately, dedupes starts, saves each page and completes beyond the old 60-page cap', async () => {
    let n = 0;
    state.action.mockImplementation(async (action: string) => action === 'get_essence_msg_list' ? [] :
      { messages: ++n <= 65 ? [row(1000 - n, n * 10)] : [] });
    const jobs = new HistoryJobs(intake()), job = jobs.create(request());
    expect(job.status).toBe('running'); expect(state.action).not.toHaveBeenCalled();
    expect(jobs.create({ ...request(), days: 30 }).id).toBe(job.id);
    const result = await complete(jobs);
    expect(result).toMatchObject({ status: 'completed', messages: 65, pages: 66, groups_completed: 1 });
    expect(count()).toBe(65);
    expect(new HistoryJobs(intake()).get(job.id)).toMatchObject({ status: 'completed', messages: 65 });
  });
  it('cancel preserves the last committed page and rejects late replies; retry resumes its cursor without duplicates', async () => {
    let respond!: (value: unknown) => void;
    state.action.mockResolvedValueOnce({ messages: [row(201, 10), row(200, 20)] })
      .mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const jobs = new HistoryJobs(intake()), job = jobs.create(request());
    await vi.waitFor(() => expect(state.action).toHaveBeenCalledTimes(2));
    expect(jobs.cancel(job.id, state.epoch).status).toBe('cancelling');
    respond({ messages: [row(199, 30)] });
    expect(await complete(jobs)).toMatchObject({ status: 'cancelled', pages: 1, messages: 2 });
    expect(count()).toBe(2);
    let next = 0;
    state.action.mockImplementation(async (action: string, params: { message_seq?: number }) => {
      if (action === 'get_essence_msg_list') return [];
      if (next++ === 0) { expect(params.message_seq).toBe(200); return { messages: [row(200, 20), row(199, 30)] }; }
      return { messages: [] };
    });
    jobs.retry(job.id, state.epoch);
    expect(await complete(jobs)).toMatchObject({ status: 'completed', messages: 3 });
    expect(count()).toBe(3);
  });
  it('recovers an orphaned running task after a process restart with the saved fixed window and cursor', async () => {
    let respond!: (value: unknown) => void;
    state.action.mockResolvedValueOnce({ messages: [row(77, 30)] })
      .mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const jobs = new HistoryJobs(intake()), job = jobs.create(request());
    await vi.waitFor(() => expect(state.action).toHaveBeenCalledTimes(2));
    jobs.cancel(job.id, state.epoch); respond({ messages: [row(77, 30)] }); await complete(jobs);
    const saved = JSON.parse(String(db.prepare("SELECT value FROM kv WHERE key='history_job_v1:qq'").get()?.value));
    saved.status = 'running'; db.prepare("UPDATE kv SET value=? WHERE key='history_job_v1:qq'").run(JSON.stringify(saved));
    state.epoch = 'new-process-epoch';
    const restarted = new HistoryJobs(intake());
    expect(restarted.get(job.id)).toMatchObject({ status: 'interrupted', retryable: true, messages: 1 });
    state.action.mockResolvedValue({ messages: [] }); restarted.retry(job.id, state.epoch);
    expect(await complete(restarted)).toMatchObject({ status: 'completed', messages: 1 });
    expect(state.action.mock.calls[2]?.[1]).toMatchObject({ message_seq: 77 });
    expect(JSON.parse(String(db.prepare("SELECT value FROM kv WHERE key='history_job_v1:qq'").get()?.value)).since).toBe(saved.since);
  });
  it('login recovery resumes an interrupted job rather than overwriting its saved cursor', async () => {
    state.action.mockResolvedValueOnce({ messages: [row(71, 30)] }).mockRejectedValueOnce(new Error('disconnected'));
    const before = new HistoryJobs(intake()); const job = before.create(request());
    expect(await complete(before)).toMatchObject({ status: 'failed', messages: 1, pages: 1 });
    state.action.mockReset(); state.action.mockResolvedValue({ messages: [] });
    const restarted = new HistoryJobs(intake()); restarted.coordinateQQ();
    expect(await syncHistory(7)).toEqual({ groups: 1, messages: 1, failures: 0 });
    expect(state.action.mock.calls[0]?.[1]).toMatchObject({ message_seq: 71 });
    expect(restarted.list()[0]).toMatchObject({ id: job.id, status: 'completed', messages: 1 });
  });
  it('automatic recovery reads new offline arrivals after preserving the old backward cursor', async () => {
    state.action.mockResolvedValueOnce({ messages: [row(71, 30)] }).mockRejectedValueOnce(new Error('disconnected'));
    const jobs = new HistoryJobs(intake()); const job = jobs.create(request());
    expect(await complete(jobs)).toMatchObject({ status: 'failed', messages: 1 });
    state.action.mockReset();
    state.action.mockImplementation(async (action: string, params: { message_seq?: number }) => {
      if (action === 'get_essence_msg_list') return [];
      return { messages: params.message_seq === undefined ? [row(72, 1), row(70, 8 * 86400)] : [] };
    });
    jobs.coordinateQQ();
    expect(await syncHistory(7)).toEqual({ groups: 1, messages: 2, failures: 0 });
    expect(state.action.mock.calls[0]?.[1]).toMatchObject({ message_seq: 71 });
    expect(db.prepare("SELECT message_id FROM messages WHERE message_id='72'").get()).toBeDefined();
    expect(jobs.list()[0]).toMatchObject({ id: job.id, status: 'completed', messages: 2 });
  });
  it('recovery revisits completed groups and preserves catch-up progress across another disconnect', async () => {
    db.prepare("INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES ('1002','Synthetic second',1,'onebot',?)").run(Date.now());
    state.action.mockImplementation(async (action: string, params: { group_id: number }) => {
      if (action === 'get_essence_msg_list') return [];
      if (params.group_id === 1002) throw new Error('disconnected');
      return { messages: [] };
    });
    const jobs = new HistoryJobs(intake()); const job = jobs.create(request());
    expect(await complete(jobs)).toMatchObject({ status: 'failed', groups_completed: 1 });
    let headReads = 0;
    state.action.mockImplementation(async (action: string, params: { group_id: number; message_seq?: number }) => {
      if (action === 'get_essence_msg_list' || params.group_id === 1002) return [];
      if (params.message_seq === undefined) { headReads++; return { messages: [row(81, 1)] }; }
      throw new Error('second disconnect');
    });
    jobs.coordinateQQ();
    expect(await syncHistory(7)).toMatchObject({ messages: 1, failures: 1 });
    expect(headReads).toBe(1);
    const persisted = JSON.parse(String(db.prepare("SELECT value FROM kv WHERE key='history_job_v1:qq'").get()?.value));
    expect(persisted.groups[0].cursor).toBe(81);
    state.action.mockReset();
    state.action.mockImplementation(async (action: string, params: { group_id: number; message_seq?: number }) => {
      if (action === 'get_essence_msg_list' || params.group_id === 1002) return [];
      return { messages: params.message_seq === undefined ? [row(82, 1), row(80, 8 * 86400)] : [] };
    });
    const restarted = new HistoryJobs(intake()); restarted.coordinateQQ();
    expect(await syncHistory(7)).toEqual({ groups: 2, messages: 2, failures: 0 });
    expect(state.action.mock.calls[0]?.[1]).toMatchObject({ message_seq: 81 });
    expect(restarted.get(job.id)).toMatchObject({ status: 'completed', messages: 2 });
  });
  it('an automatic caller joins a manual task once and cancellation also stops its pending catch-up', async () => {
    let respond!: (value: unknown) => void;
    state.action.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const jobs = new HistoryJobs(intake()); const job = jobs.create(request()); jobs.coordinateQQ();
    const automatic = syncHistory(7), duplicate = syncHistory(7);
    const rejected = Promise.all([expect(automatic).rejects.toThrow('HISTORY_CANCELLED'), expect(duplicate).rejects.toThrow('HISTORY_CANCELLED')]);
    await vi.waitFor(() => expect(state.action).toHaveBeenCalledTimes(1));
    jobs.cancel(job.id, state.epoch); respond({ messages: [] }); await rejected;
    expect(state.action).toHaveBeenCalledTimes(1);
    expect(jobs.get(job.id)).toMatchObject({ status: 'cancelled', messages: 0 });
  });
  it('automatic takeover expands a manual subset to currently enabled groups without replacing its cursor', async () => {
    let respond!: (value: unknown) => void;
    state.action.mockResolvedValueOnce({ messages: [row(91, 100)] })
      .mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const jobs = new HistoryJobs(intake()); jobs.coordinateQQ();
    const job = jobs.create({ ...request(), group_ids: ['1001'] });
    await vi.waitFor(() => expect(state.action).toHaveBeenCalledTimes(2));
    db.prepare("INSERT INTO groups(group_id,name,enabled,adapter,created_at) VALUES ('1002','Newly enabled',1,'onebot',?)").run(Date.now());
    state.action.mockImplementation(async (action: string, params: { group_id: number; message_seq?: number }) => {
      if (action === 'get_essence_msg_list') return [];
      return { messages: params.group_id === 1002 && params.message_seq === undefined
        ? [{ ...row(92, 1), group_id: 1002 }, { ...row(90, 8 * 86400), group_id: 1002 }] : [] };
    });
    const automatic = syncHistory(7), duplicate = syncHistory(7);
    expect(jobs.get(job.id)).toMatchObject({ groups_total: 2, messages: 1 });
    respond({ messages: [] });
    expect(await automatic).toEqual({ groups: 2, messages: 2, failures: 0 });
    expect(await duplicate).toEqual({ groups: 2, messages: 2, failures: 0 });
    expect(jobs.get(job.id)).toMatchObject({ id: job.id, status: 'completed', groups_completed: 2 });
    expect(db.prepare("SELECT group_id FROM messages WHERE message_id='92'").get()?.group_id).toBe('1002');
  });
  it('rejects old account pages and stale UI mutations without writing messages into a new context', async () => {
    let respond!: (value: unknown) => void;
    state.action.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const jobs = new HistoryJobs(intake()), job = jobs.create(request());
    await vi.waitFor(() => expect(state.action).toHaveBeenCalledTimes(1));
    state.epoch = 'other-epoch'; state.account = '20002';
    expect(() => jobs.cancel(job.id, 'synthetic-epoch')).toThrow('HISTORY_SCOPE_CHANGED');
    respond({ messages: [row(90)] }); await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count()).toBe(0); expect(jobs.list()).toEqual([]);
    expect(() => jobs.retry(job.id, state.epoch)).toThrow('HISTORY_SCOPE_CHANGED');
  });
  it('releases a never-returning QQ request on space switch without relying on browser polling', async () => {
    let signal!: AbortSignal;
    state.action.mockImplementation((_action, _params, _timeout, activeSignal: AbortSignal) => new Promise((_resolve, reject) => {
      signal = activeSignal; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const jobs = new HistoryJobs(intake()); jobs.create(request());
    await vi.waitFor(() => expect(signal).toBeDefined());
    state.epoch = 'another-space'; notifyAccountSwitch(null);
    expect(signal.aborted).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(count()).toBe(0);
    expect(jobs.list()[0]).toMatchObject({ status: 'interrupted', retryable: true });
  });
  it('does not declare a full repeated cursor page complete and can retry a transport error', async () => {
    state.action.mockResolvedValue({ messages: [row(12, 10), row(11, 20)] });
    const jobs = new HistoryJobs(intake()), job = jobs.create(request());
    expect(await complete(jobs)).toMatchObject({ status: 'failed', error: 'HISTORY_CURSOR_STALLED', messages: 2, retryable: true });
    state.action.mockRejectedValue(new Error('private transport details'));
    jobs.retry(job.id, state.epoch);
    expect(await complete(jobs)).toMatchObject({ status: 'failed', error: 'HISTORY_PAGE_UNAVAILABLE', messages: 2 });
    expect(JSON.stringify(jobs.list())).not.toContain('private');
  });
  it('rolls back messages with the cursor if the durable checkpoint cannot be saved', async () => {
    let respond!: (value: unknown) => void;
    state.action.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    const jobs = new HistoryJobs(intake()); jobs.create(request());
    await vi.waitFor(() => expect(state.action).toHaveBeenCalledTimes(1));
    db.exec(`CREATE TEMP TRIGGER break_history_checkpoint BEFORE UPDATE ON kv
      WHEN NEW.key='history_job_v1:qq' AND json_extract(NEW.value,'$.pages')>0 BEGIN SELECT RAISE(ABORT,'synthetic disk error'); END`);
    try {
      respond({ messages: [row(19)] });
      expect(await complete(jobs)).toMatchObject({ status: 'failed', messages: 0, pages: 0 }); expect(count()).toBe(0);
    } finally { db.exec('DROP TRIGGER break_history_checkpoint'); }
  });
  it('wechat runs approved pages in the background and replays only incomplete groups with a fixed time window', async () => {
    const wx = intake();
    wx.history.mockImplementationOnce(async (_epoch, _intake, group, _days, _approved, _more, _at, jobId) => {
      commitWechatCount(jobId!, group, 2); return { inserted: 2, has_more: true };
    }).mockRejectedValueOnce(new Error('private worker failure'));
    const jobs = new HistoryJobs(wx), job = jobs.create({ ...request(), platform: 'wechat', approve_history_read: true });
    expect(await complete(jobs)).toMatchObject({ status: 'failed', messages: 2 });
    wx.history.mockResolvedValue({ inserted: 0, has_more: false }); jobs.retry(job.id, state.epoch);
    expect(await complete(jobs)).toMatchObject({ status: 'completed', messages: 2 });
    expect(wx.history.mock.calls[0]?.[5]).toBe(false);
    expect(wx.history.mock.calls[1]?.[5]).toBe(true);
    expect(wx.history.mock.calls[2]?.[5]).toBe(false);
    expect(wx.history.mock.calls[2]?.[6]).toBe(job.created_at / 1000);
  });
  it('wechat cancel is page-boundary and never silently starts collection; consent/foreign groups fail closed', async () => {
    const wx = intake(), jobs = new HistoryJobs(wx);
    expect(() => jobs.create({ ...request(), platform: 'wechat' })).toThrow('CONSENT');
    expect(() => jobs.create({ ...request(), platform: 'wechat', approve_history_read: true, group_ids: ['foreign@chatroom'] })).toThrow('SCOPE');
    let finish!: (value: { inserted: number; has_more: boolean }) => void;
    wx.history.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const job = jobs.create({ ...request(), platform: 'wechat', approve_history_read: true });
    await vi.waitFor(() => expect(wx.history).toHaveBeenCalledTimes(1)); jobs.cancel(job.id, state.epoch);
    commitWechatCount(job.id, 'test@chatroom', 3);
    finish({ inserted: 3, has_more: true });
    expect(await complete(jobs)).toMatchObject({ status: 'cancelled', messages: 3, pages: 1 });
    (wx.historyContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => jobs.retry(job.id, state.epoch)).toThrow('WECHAT_UNAVAILABLE');
  });
  it('wechat count survives business commit followed by a lost page result and receipt replay', async () => {
    const wx = intake();
    wx.history.mockImplementationOnce(async (_epoch, _intake, group, _days, _approved, _more, _at, jobId) => {
      commitWechatCount(jobId!, group, 4); throw new Error('lost IPC reply after commit');
    });
    const jobs = new HistoryJobs(wx), job = jobs.create({ ...request(), platform: 'wechat', approve_history_read: true });
    expect(await complete(jobs)).toMatchObject({ status: 'failed', messages: 4, pages: 0 });
    const restarted = new HistoryJobs(wx); restarted.retry(job.id, state.epoch);
    expect(await complete(restarted)).toMatchObject({ status: 'completed', messages: 4, pages: 1 });
  });
  it('polling during owned wechat worker recovery does not revoke the task', async () => {
    const wx = intake(); let recover!: () => void;
    wx.history.mockImplementationOnce(async () => {
      const original = wx.historyContext.getMockImplementation()!;
      (wx.historyContext as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
      await new Promise<void>((resolve) => { recover = resolve; });
      wx.historyContext.mockImplementation(original);
      return { inserted: 0, has_more: false, skipped: 'WECHAT_MESSAGE_TIMEOUT', intake_id: 'recovered-intake' };
    });
    const jobs = new HistoryJobs(wx); jobs.create({ ...request(), platform: 'wechat', approve_history_read: true });
    await vi.waitFor(() => expect(recover).toBeTypeOf('function'));
    expect(jobs.list()[0]?.status).toBe('running'); recover();
    expect(await complete(jobs)).toMatchObject({ status: 'failed', error: 'HISTORY_WECHAT_UNAVAILABLE' });
  });
  it('detects multi-page cursor cycles without imposing a legitimate-work time limit', async () => {
    let n = 0;
    state.action.mockImplementation(async () => ({ messages: n++ % 2 ? [row(11, 20)] : [row(12, 10)] }));
    const jobs = new HistoryJobs(intake()); jobs.create(request());
    expect(await complete(jobs)).toMatchObject({ status: 'failed', pages: 2, messages: 2, error: 'HISTORY_CURSOR_STALLED' });
  });
  it('cancels a queued task immediately before any source read', async () => {
    const jobs = new HistoryJobs(intake()), job = jobs.create(request());
    expect(jobs.cancel(job.id, state.epoch)).toMatchObject({ status: 'cancelled', messages: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.action).not.toHaveBeenCalled();
  });
});
