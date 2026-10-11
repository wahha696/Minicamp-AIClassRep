import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { WechatMessageChannel } from './wechat-message-channel.js';
import { WechatSelectionStore } from './wechat-selection-store.js';
import { bindWechatDestination, wechatBatchId } from './wechat.js';

const dirs: string[] = [];
const base = fileURLToPath(new URL('../../../../.review-research/', import.meta.url));
beforeEach(() => openDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  if (db.isOpen) db.close();
  for (const folder of dirs.splice(0)) {
    const rel = relative(realpathSync(base), realpathSync(folder));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('TEST_CLEANUP_PATH');
    rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
function fixture() {
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'synthetic-owned-message-')); dirs.push(directory);
  const context = { account: 'wxid_synthetic_pipe', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
  let current: typeof context | null = context;
  const scope = { ...context, dataRoot: 'C:\\synthetic\\xwechat_files', groups: [{ group_id: 'synthetic_A@chatroom', name: '人工群 😀' }] };
  const selection = new WechatSelectionStore('synthetic-space', context.account, () => current);
  selection.apply(scope, ['synthetic_A@chatroom']);
  const options = {
    executable: process.env.WECHAT4_TEST_PYTHON ?? 'unused.exe',
    entry: fileURLToPath(new URL('../../../../tools/wechat4-read-probe/message_worker_fixture.py', import.meta.url)),
    context, dataRoot: scope.dataRoot, destination: 'synthetic-space',
    groups: selection.list().map((row) => ({ group_id: row.group_id, name: row.name ?? '',
      receipt_path: join(directory, 'synthetic.wechat-receipts.sqlite3'), activation_id: row.activation_id,
      activation_pending: row.pending !== null, require_existing_progress: row.activated })),
    approveMessageRead: true, approveKeyRead: true, approveSelectedStorage: true,
    signal: new AbortController().signal, proof: vi.fn(async () => current),
    activated: vi.fn((group: string, activation: string) => selection.activated(context, group, activation)),
    receive: vi.fn(bindWechatDestination('synthetic-space', context.account, ['synthetic_A@chatroom'])),
  };
  return { options, selection, setCurrent: (value: typeof current) => { current = value; } };
}
function fake(f: ReturnType<typeof fixture>) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; }) });
  let token = '';
  const reply = (seq: number, fields: object) => child.stdout.write(JSON.stringify({ v: 1, token, seq, ...fields }) + '\n');
  const requests: Record<string, any>[] = [];
  child.stdin.on('data', (chunk: Buffer) => {
    const item = JSON.parse(chunk.toString()); requests.push(item);
    if (item.command === 'initialize') {
      token = item.token;
      queueMicrotask(() => reply(0, { kind: 'activation', mid: 1,
        payload: { group_id: f.options.groups[0]!.group_id, activation_id: f.options.groups[0]!.activation_id } }));
    } else if (item.command === 'activation_ack') {
      reply(0, { kind: 'ready', status: { 'synthetic_A@chatroom': { pending: 0, deferred: 0 } } });
    }
  });
  const launch = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const channel = new WechatMessageChannel({ ...f.options, launch });
  return { channel, launch, child, requests, reply };
}

describe('owned WeChat selected-message pipe', () => {
  it('is inert and refuses missing consent before launching', async () => {
    const f = fixture(), launch = vi.fn();
    const channel = new WechatMessageChannel({ ...f.options, approveSelectedStorage: false, launch });
    expect(launch).not.toHaveBeenCalled();
    await expect(channel.start()).rejects.toThrow('CONSENT_REQUIRED');
    expect(launch).not.toHaveBeenCalled(); await channel.close();
  });
  it('rejects a mismatched nonce and reaps its owned worker', async () => {
    const f = fixture(), worker = fake(f); await worker.channel.start();
    const result = worker.channel.status(); const rejected = expect(result).rejects.toThrow('RESPONSE_OR_COMMIT_FAILED');
    await vi.waitFor(() => expect(worker.requests.at(-1)?.command).toBe('status'));
    worker.reply(1, { token: 'b'.repeat(64), kind: 'result', result: {} });
    await rejected; expect(worker.child.kill).toHaveBeenCalledTimes(1);
    expect(f.options.receive).not.toHaveBeenCalled();
  });
  it('does not commit a delivery when the account changes during proof', async () => {
    const f = fixture(), worker = fake(f); await worker.channel.start();
    const result = worker.channel.tick(); const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(worker.requests.at(-1)?.command).toBe('tick'));
    f.setCurrent({ ...f.options.context, connectionId: randomUUID() });
    worker.reply(1, { kind: 'delivery', mid: 1, payload: { private: 'never commit' } });
    await rejected; expect(f.options.receive).not.toHaveBeenCalled();
    expect(worker.child.kill).toHaveBeenCalledTimes(1);
  });
  it('bounds an unresponsive worker and reaps it before reporting failure', async () => {
    const f = fixture(), worker = fake(f); await worker.channel.start(); vi.useFakeTimers();
    const result = worker.channel.status(); const rejected = expect(result).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(45000); await rejected;
    expect(worker.child.kill).toHaveBeenCalledTimes(1);
  });
  it('allows a bounded slow history snapshot beyond the lightweight command timeout', async () => {
    const f = fixture(), worker = fake(f); await worker.channel.start(); vi.useFakeTimers();
    const result = worker.channel.history('synthetic_A@chatroom', 7, true);
    // Attach immediately so a premature timeout is observed by the assertion.
    const completed = result.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(60_000);
    worker.reply(1, { kind: 'result', result: { inserted: 1, has_more: false } });
    expect(await completed).toEqual({ value: { inserted: 1, has_more: false } });
    expect(worker.child.kill).not.toHaveBeenCalled();
    await worker.channel.close();
  });
  it('commits and acknowledges history delivery before accepting page completion', async () => {
    const f = fixture(), worker = fake(f); await worker.channel.start();
    for (const seq of [1, 2]) {
      const page = seq === 1 ? worker.channel.history('synthetic_A@chatroom', 7, true) : worker.channel.historyNext();
      await vi.waitFor(() => expect(worker.requests.at(-1)?.command).toBe(seq === 1 ? 'history_start' : 'history_next'));
      const batch = { version: 1 as const, destination: 'synthetic-space', wechat_account: f.options.context.account,
        messages: [{ event_id: String(seq).repeat(64), group_id: 'synthetic_A@chatroom', group_name: 'Synthetic group',
          sender_name: 'Synthetic sender', text: 'Synthetic history notice', sent_at: 1000 + seq }] };
      worker.reply(seq, { kind: 'delivery', mid: 1, payload: { ...batch, batch_id: wechatBatchId(batch) } });
      await vi.waitFor(() => expect(worker.requests.at(-1)?.command).toBe('delivery_ack'));
      expect(db.prepare('SELECT count(*) AS n FROM messages').get()?.n).toBe(seq);
      worker.reply(seq, { kind: 'result', result: { inserted: 1, has_more: seq === 1 } });
      expect(await page).toEqual({ inserted: 1, has_more: seq === 1 });
    }
    await worker.channel.close();
  });
  it('still times out and reaps a hung history worker at its bounded deadline', async () => {
    const f = fixture(), worker = fake(f); await worker.channel.start(); vi.useFakeTimers();
    const result = worker.channel.history('synthetic_A@chatroom', 30, true);
    const rejected = expect(result).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(180_000); await rejected;
    expect(worker.child.kill).toHaveBeenCalledTimes(1);
  });
  it.skipIf(!process.env.WECHAT4_TEST_PYTHON)('real portable pipes commit synthetic selected text and resume without duplicates', async () => {
    const f = fixture(); const first = new WechatMessageChannel(f.options);
    try {
      expect(await first.start()).toEqual({ 'synthetic_A@chatroom': { pending: 0, deferred: 0 } });
      expect(f.selection.list()[0]).toMatchObject({ pending: null, activated: true });
      const tick = await first.tick();
      expect(tick.delivered['synthetic_A@chatroom']?.inserted).toBe(1);
      expect(db.prepare('SELECT text,source FROM messages').all()).toEqual([{ text: '明天提交人工测试作业 😀', source: 'wechat' }]);
      expect(JSON.stringify(db.prepare('SELECT * FROM messages').all())).not.toContain('PRIVATE');
    } finally { await first.close(); }
    const second = new WechatMessageChannel({ ...f.options,
      groups: f.options.groups.map((g) => ({ ...g, activation_pending: false, require_existing_progress: true })) });
    try {
      await second.start();
      expect((await second.tick()).saved['synthetic_A@chatroom']?.saved).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM messages').get()?.n).toBe(1);
    } finally { await second.close(); }
  });
});
