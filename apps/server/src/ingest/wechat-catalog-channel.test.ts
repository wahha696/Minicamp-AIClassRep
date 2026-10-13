import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWechatCatalog, wechatCatalogFailureCode } from './wechat-catalog-channel.js';
import { parseWechatCatalogMetadata } from './wechat-metadata.js';
import type { WechatReadContext } from './wechat-group-selection.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; });
  let request: { token: string } | undefined;
  child.stdin.on('data', (value: Buffer) => { request = JSON.parse(value.toString('utf8')); });
  const context = { account: 'wxid_synthetic_catalog_pipe', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
  let current: WechatReadContext | null = context;
  const controller = new AbortController(); const launch = vi.fn(() => child);
  const proof = vi.fn(async () => current);
  const options = { executable: 'not executed',
    entry: fileURLToPath(new URL('synthetic-catalog-worker.py', import.meta.url)), context,
    metadata: { expected_account: context.account }, approveContactRead: true, approveKeyRead: true,
    proof, signal: controller.signal, launch };
  const reply = (patch: object = {}) => {
    child.stdout.write(JSON.stringify({ v: 1, token: request!.token, seq: 0, kind: 'catalog',
      groups: [{ group_id: 'synthetic@chatroom', name: '人工群 😀' }], ...patch }) + '\n');
  };
  return { child, options, controller, launch, proof, reply, token: () => request!.token,
    current: (value: WechatReadContext | null) => { current = value; } };
}

describe('owned contact catalog pipe (synthetic child, no native reads)', () => {
  it('requires both consents and a matching live source before any child starts', async () => {
    for (const mode of ['contact', 'key', 'source', 'abort', 'metadata']) {
      const f = fixture();
      if (mode === 'contact') f.options.approveContactRead = false;
      if (mode === 'key') f.options.approveKeyRead = false;
      if (mode === 'source') f.current(null);
      if (mode === 'abort') f.controller.abort();
      if (mode === 'metadata') f.options.metadata.expected_account = 'wxid_other';
      await expect(readWechatCatalog(f.options)).rejects.toThrow();
      expect(f.launch).not.toHaveBeenCalled();
    }
  });
  it('owned-root requests derive account from current evidence and refuse arbitrary/remote roots before launch', async () => {
    for (const dataRoot of ['relative', 'C:\\private', '\\\\server\\share\\xwechat_files', 'C:\\xwechat_files\0']) {
      const f = fixture();
      await expect(readWechatCatalog({ ...f.options, metadata: undefined, dataRoot })).rejects.toThrow('WECHAT_CATALOG_METADATA_INVALID');
      expect(f.launch).not.toHaveBeenCalled(); expect(f.proof).not.toHaveBeenCalled();
    }
    const f = fixture(); let sent: Record<string, unknown> | undefined;
    f.child.stdin.on('data', (value: Buffer) => { sent = JSON.parse(value.toString()); });
    const result = readWechatCatalog({ ...f.options, metadata: undefined, dataRoot: 'C:\\synthetic\\xwechat_files' });
    await Promise.resolve();
    expect(sent).toMatchObject({ command: 'catalog_root', selection: {
      data_root: 'C:\\synthetic\\xwechat_files', expected_account: f.options.context.account } });
    expect(sent).not.toHaveProperty('metadata');
    f.reply(); f.child.emit('close', 0); await result;
  });
  it('returns only bounded groups after worker close and fresh source recheck', async () => {
    const f = fixture(); let completed = false;
    const result = readWechatCatalog(f.options).then((value) => { completed = true; return value; });
    await Promise.resolve(); f.reply(); await Promise.resolve(); expect(completed).toBe(false);
    f.child.emit('close', 0);
    expect(await result).toEqual([{ group_id: 'synthetic@chatroom', name: '人工群 😀' }]);
    expect(f.proof).toHaveBeenCalledTimes(2); expect(f.child.kill).not.toHaveBeenCalled();
  });
  it.each(['token', 'private', 'duplicate', 'extra', 'invalid_utf8'])('rejects unsafe response (%s)', async (mode) => {
    const f = fixture(); const result = readWechatCatalog(f.options);
    const rejected = expect(result).rejects.toThrow('WECHAT_CATALOG_RESULT_INVALID');
    await Promise.resolve();
    if (mode === 'invalid_utf8') f.child.stdout.write(Buffer.from([255, 10]));
    else if (mode === 'token') f.reply({ token: 'wrong' });
    else if (mode === 'private') f.reply({ groups: [{ group_id: 'wxid_private', name: 'private' }] });
    else if (mode === 'duplicate') f.reply({ groups: [{ group_id: 'a@chatroom', name: null }, { group_id: 'a@chatroom', name: null }] });
    else f.reply({ private_body: 'never expose' });
    f.child.emit('close', 0); await rejected;
  });
  it('discards a valid result after logout, switch or reconnection', async () => {
    const f = fixture(); const result = readWechatCatalog(f.options);
    const rejected = expect(result).rejects.toThrow('WECHAT_CATALOG_NOT_CURRENT');
    await Promise.resolve(); f.reply();
    f.current({ ...f.options.context, connectionId: randomUUID() });
    f.child.emit('close', 0); await rejected;
  });
  it('cancels and reaps the child on identity loss and result overflow', async () => {
    for (const mode of ['abort', 'overflow']) {
      const f = fixture(); const result = readWechatCatalog(f.options); const rejected = expect(result).rejects.toThrow();
      await Promise.resolve();
      if (mode === 'abort') f.controller.abort(); else f.child.stdout.write(Buffer.alloc(1048577));
      await rejected; expect(f.child.kill).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds the job duration and releases the owned worker before failing', async () => {
    vi.useFakeTimers(); const f = fixture(); const result = readWechatCatalog(f.options);
    const rejected = expect(result).rejects.toThrow('WECHAT_CATALOG_TIMEOUT');
    await vi.advanceTimersByTimeAsync(120000); await rejected;
    expect(f.child.kill).toHaveBeenCalledTimes(1);
  });
  it('accepts only nonce-bound known failure codes after a failed child is reaped', async () => {
    for (const mode of ['known', 'native', 'unknown', 'token', 'extra', 'exit']) {
      const f = fixture(); const result = readWechatCatalog(f.options);
      const expected = mode === 'known' ? 'WECHAT_CATALOG_KEY_SCAN_BYTE_BUDGET_EXCEEDED'
        : mode === 'native' ? 'WECHAT_CATALOG_PROCESS_SHORT_READ' : 'WECHAT_CATALOG_WORKER_FAILED';
      const rejected = expect(result).rejects.toThrow(expected);
      await Promise.resolve();
      // Use the same private nonce supplied to our child.
      f.child.stdout.write(JSON.stringify({ v: 1, token: mode === 'token' ? 'wrong' : f.token(),
        seq: 0, kind: 'error', reason: mode === 'unknown' ? 'PRIVATE_ACCOUNT'
          : mode === 'native' ? 'PROCESS_SHORT_READ' : 'KEY_SCAN_BYTE_BUDGET_EXCEEDED',
        ...(mode === 'extra' ? { account: 'private' } : {}) }) + '\n');
      f.child.emit('close', mode === 'exit' ? 1 : 2); await rejected;
    }
    expect(wechatCatalogFailureCode(new Error('WECHAT_CATALOG_PRIVATE_ACCOUNT'))).toBe('WECHAT_CATALOG_WORKER_FAILED');
    expect(wechatCatalogFailureCode(new Error('WECHAT_CATALOG_KEY_SCAN_BYTE_BUDGET_EXCEEDED'))).toBe('WECHAT_CATALOG_KEY_SCAN_BYTE_BUDGET_EXCEEDED');
  });
  it.skipIf(!process.env.WECHAT4_TEST_PYTHON)('real portable pipe checks synthetic identity and filters private contact columns', async () => {
    const context = { account: 'wxid_synthetic_account', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
    const result = await readWechatCatalog({ executable: process.env.WECHAT4_TEST_PYTHON!,
      entry: fileURLToPath(new URL('../../../../tools/wechat4-read-probe/catalog_worker_fixture.py', import.meta.url)),
      metadata: { expected_account: context.account, ...parseWechatCatalogMetadata('{"process":{"created":134360728640232154}}') },
      context, approveContactRead: true, approveKeyRead: true,
      signal: new AbortController().signal, proof: async () => context });
    expect(result).toEqual([{ group_id: 'synthetic@chatroom', name: '人工群 😀' }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it.skipIf(!process.env.WECHAT4_TEST_PYTHON)('real portable failure response reports only a bounded known code and reaps its worker', async () => {
    const context = { account: 'wxid_synthetic_account', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
    await expect(readWechatCatalog({ executable: process.env.WECHAT4_TEST_PYTHON!,
      entry: fileURLToPath(new URL('../../../../tools/wechat4-read-probe/catalog_worker_fixture.py', import.meta.url)),
      metadata: { expected_account: context.account, synthetic_failure: true }, context,
      approveContactRead: true, approveKeyRead: true,
      signal: new AbortController().signal, proof: async () => context }))
      .rejects.toThrow('WECHAT_CATALOG_SNAPSHOT_SOURCE_CHANGED');
  });
  it.skipIf(!process.env.WECHAT4_TEST_PYTHON)('real portable root command obtains its scope inside the worker using synthetic discovery only', async () => {
    const context = { account: 'wxid_synthetic_account', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
    const result = await readWechatCatalog({ executable: process.env.WECHAT4_TEST_PYTHON!,
      entry: fileURLToPath(new URL('../../../../tools/wechat4-read-probe/catalog_worker_fixture.py', import.meta.url)),
      dataRoot: 'C:\\synthetic\\xwechat_files', context, approveContactRead: true, approveKeyRead: true,
      signal: new AbortController().signal, proof: async () => context });
    expect(result).toEqual([{ group_id: 'synthetic@chatroom', name: '人工群 😀' }]);
  });
});
