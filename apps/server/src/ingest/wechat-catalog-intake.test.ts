import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, openDb } from '../db/index.js';
import { WechatCatalog } from './wechat-catalog.js';
import { WechatIntake } from './wechat-intake.js';
import { WechatSelectionStore } from './wechat-selection-store.js';

const directories: string[] = [];
const collectors: WechatIntake[] = [];
beforeEach(() => { vi.useFakeTimers(); openDb(':memory:'); });
afterEach(async () => {
  for (const collector of collectors.splice(0)) await collector.stop();
  vi.useRealTimers();
  if (db.isOpen) db.close();
  for (const directory of directories.splice(0)) {
    const rel = relative(realpathSync(tmpdir()), realpathSync(directory));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('TEST_CLEANUP_PATH');
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['success', 'failure'] as const)('keeps approved intake while a same-source catalog refresh is pending (%s)', async outcome => {
  const context = { account: 'wxid_synthetic_refresh', connectionId: randomUUID(), epoch: 'synthetic-epoch' };
  const groups = [{ group_id: 'synthetic@chatroom', name: 'Synthetic group' }];
  const folder = mkdtempSync(join(tmpdir(), 'synthetic-catalog-intake-')); directories.push(folder);
  const store = new WechatSelectionStore('synthetic-space', context.account, () => context);
  const read = vi.fn(async () => groups);
  const catalog = new WechatCatalog({ current: () => context, revalidate: async () => true, read,
    remembered: () => store.list().filter(group => group.enabled).map(group => group.group_id),
    saveSelection: (scope, available) => store.apply(scope, available) });
  const offer = await catalog.refresh(context.epoch, true, true, 'C:\\synthetic\\xwechat_files');
  await catalog.select(offer.catalog_id, context.epoch, groups.map(group => group.group_id));
  const counts = { 'synthetic@chatroom': { pending: 0, deferred: 0 } };
  const channel = { start: vi.fn(async () => counts), close: vi.fn(async () => {}),
    tick: vi.fn(async () => ({ saved: {}, delivered: {}, status: counts })), status: vi.fn(async () => counts),
    history: vi.fn(async () => ({ inserted: 0, has_more: false })),
    historyNext: vi.fn(async () => ({ inserted: 0, has_more: false })),
    issues: vi.fn(async () => []), retryIssues: vi.fn(async () => counts) };
  const intake = new WechatIntake({ root: 'C:\\synthetic', current: () => context,
    selected: () => catalog.selectedScope(), destination: () => 'synthetic-space',
    revalidate: async () => true, createChannel: () => channel, receiptRoot: () => folder,
    runtime: () => ({ executable: 'unused.exe', entry: 'C:\\synthetic\\identity_worker.py' }) });
  collectors.push(intake);
  await intake.start(context.epoch, true, true, true);
  const id = intake.status().intake_id;
  let complete!: () => void;
  read.mockImplementationOnce(() => new Promise((resolve, reject) => {
    complete = () => outcome === 'success' ? resolve(groups) : reject(new Error('synthetic catalog failure'));
  }));
  const refresh = catalog.refresh(context.epoch, true, true, 'C:\\synthetic\\xwechat_files');
  const settled = refresh.catch(() => undefined);
  await Promise.resolve();
  // The product polls intake status while the separate contact read runs.
  const during = intake.status();
  complete(); await settled;
  expect(during.collecting).toBe(true);
  expect(intake.status().intake_id).toBe(id);
  expect(channel.close).not.toHaveBeenCalled();
});
