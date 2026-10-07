import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { accountEpoch, setAccountsDirForTest, switchAccount } from '../accounts.js';
import { db } from '../db/index.js';
import { registerDataRoutes } from './data.js';

const roots: string[] = [];

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'classrep-data-route-'));
  roots.push(root);
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  await switchAccount('10001');
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

function app(): Hono {
  const value = new Hono();
  registerDataRoutes(value);
  return value;
}

function addMessage(id: string, text = '真实消息不应出现在诊断包'): void {
  db.prepare(
    `INSERT INTO messages
      (message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, decision_reason, created_at)
     VALUES (?, 'private-group', '真实姓名', ?, 1, 'onebot', 1, 0, 'event_recognized', 1)`,
  ).run(id, text);
}

describe('账号数据路由', () => {
  it('下载可校验备份并恢复，恢复后旧 epoch 立即失效', async () => {
    const server = app();
    addMessage('before');
    const download = await server.request('/api/settings/data/backup');
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/octet-stream');
    expect(download.headers.get('cache-control')).toBe('no-store');
    const backup = new Uint8Array(await download.arrayBuffer());

    addMessage('after');
    const oldEpoch = accountEpoch();
    const restored = await server.request('/api/settings/data/restore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ClassRep-Account-Epoch': oldEpoch,
      },
      body: backup,
    });
    expect(restored.status).toBe(200);
    expect(accountEpoch()).not.toBe(oldEpoch);
    expect(db.prepare('SELECT message_id FROM messages ORDER BY message_id').all()).toEqual([{ message_id: 'before' }]);
  });

  it('篡改备份在换库前被拒绝；诊断下载不包含正文和标识', async () => {
    const server = app();
    addMessage('private-message-id');
    const download = await server.request('/api/settings/data/backup');
    const backup = new Uint8Array(await download.arrayBuffer());
    backup[backup.length - 1] = backup[backup.length - 1]! ^ 1;
    const rejected = await server.request('/api/settings/data/restore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-ClassRep-Account-Epoch': accountEpoch(),
      },
      body: backup,
    });
    expect(rejected.status).toBe(400);
    expect(db.prepare("SELECT message_id FROM messages WHERE message_id='private-message-id'").get()).toBeTruthy();

    const diagnostic = await server.request('/api/settings/diagnostics');
    expect(diagnostic.status).toBe(200);
    expect(diagnostic.headers.get('cache-control')).toBe('no-store');
    const text = await diagnostic.text();
    for (const secret of ['private-message-id', 'private-group', '真实姓名', '真实消息不应出现在诊断包']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('event_recognized');
  });
});
