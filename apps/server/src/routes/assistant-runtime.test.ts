import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { accountEpoch, initAccounts, setAccountsDirForTest, workspaceRuntime } from '../accounts.js';
import { accountMutationGuard } from '../account-request-guard.js';
import { db } from '../db/index.js';
import { accessGuard } from '../lan-guard.js';
import { registerWorkspaceRoutes } from './workspaces.js';
import { registerTodoRoutes } from './todos.js';
import { registerAssistantRoutes } from './assistant.js';
import type { PetLlmClient } from './pet-chat.js';

vi.mock('../ai-settings.js', () => ({ getLlmConfig: () => ({ apiKey: '', baseURL: '', model: 'synthetic', version: 1 }) }));
let root = '';
afterEach(() => {
  if (!root) return;
  db.close();
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  const rel = relative(realpathSync(tmpdir()), realpathSync(root));
  if (!rel.startsWith('classrep-assistant-runtime-') || rel.includes('..') || isAbsolute(rel)) throw new Error('SYNTHETIC_CLEANUP_PATH');
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

it('real workspace rename through assistant confirmation does not deadlock its own account lease', async () => {
  root = mkdtempSync(join(tmpdir(), 'classrep-assistant-runtime-'));
  setAccountsDirForTest(join(root, 'accounts'), join(root, 'fallback.db'));
  await initAccounts({ dataDir: root, settingsDir: root, accountsDir: join(root, 'accounts'), fallbackDb: join(root, 'fallback.db'), workspace: {
    automaticWorkspace: false, verifyIdentity: i => i.platform === 'wechat' && i.account_id === 'wxid_synthetic_assistant', stopCollectors: () => {}, restartCollectors: () => {},
  } });
  const runtime = workspaceRuntime()!;
  await runtime.observe({ platform: 'wechat', account_id: 'wxid_synthetic_assistant' }, 'synthetic-worker');
  await runtime.choose({ request_id: runtime.status().pending[0]!.request_id, expected_account_epoch: accountEpoch(), choice: { mode: 'create', name: '合成原空间' }, confirm_switch: false });
  const app = new Hono();
  app.use('*', accessGuard({ lanToken: () => null, lanHosts: () => [] }));
  app.use('*', accountMutationGuard());
  registerWorkspaceRoutes(app);
  registerTodoRoutes(app);
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ text: '请确认改名', actions: [
    { tool: 'workspace.rename', args: { name: '合成新空间' } },
    { tool: 'todos.create', args: { title: '改名后的合成待办' } },
  ] }) } }] }) } } } as unknown as PetLlmClient;
  registerAssistantRoutes(app, { client });
  const epoch = accountEpoch();
  const request = (path: string, body: unknown, cookie = '') => app.request(path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-ClassRep-Account-Epoch': epoch, Cookie: cookie,
  }, body: JSON.stringify(body) }, { incoming: { socket: { remoteAddress: '127.0.0.1' } } });
  const session = await request('/api/assistant/session', {});
  expect(session.status).toBe(200);
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
  const chat = await request('/api/assistant/chat', { message: '改名并添加一个合成待办' }, cookie);
  expect(chat.status).toBe(200);
  const { plan } = await chat.json() as any;
  const confirmed = await request(`/api/assistant/plans/${plan.id}/confirm`, { confirmed: true }, cookie);
  expect(confirmed.status).toBe(200);
  const result = await confirmed.json() as any;
  expect(result.results.map((r: any) => r.ok)).toEqual([true, true]);
  expect(runtime.status().current?.name).toBe('合成新空间');
  expect(db.prepare('SELECT title FROM todos').all()).toEqual([{ title: '改名后的合成待办' }]);
  // Recovering a completed response is read-only and cannot add another todo.
  expect((await request(`/api/assistant/plans/${plan.id}/confirm`, { confirmed: true }, cookie)).status).toBe(200);
  expect(db.prepare('SELECT COUNT(*) AS n FROM todos').get()?.n).toBe(1);
}, 10_000);
