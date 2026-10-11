import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHealthyPort, findRunningServer, installationId, isClassrepHealth } from './start-server.mjs';

test('拒绝其他服务、旧实例、无身份响应；允许未登录但已启动的本次课代表', () => {
  assert.equal(isClassrepHealth('<html>ok</html>', 'new'), false);
  assert.equal(isClassrepHealth({ status: 'ok' }, 'new'), false);
  assert.equal(isClassrepHealth({ app: 'other', launch_id: 'new', status: 'ok' }, 'new'), false);
  assert.equal(isClassrepHealth({ app: 'classrep', launch_id: 'old', status: 'ok' }, 'new'), false);
  assert.equal(isClassrepHealth({ app: 'classrep', launch_id: 'new', status: 'degraded' }, 'new'), true);
});

test('仅复用同一安装目录的已验证课代表，不复用其他目录或其他产品', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => Response.json({ app: 'classrep', launch_id: 'old', status: 'degraded',
    installation_id: new URL(url).port === '8001' ? installationId(process.cwd()) : 'another-installation' });
  try { assert.equal(await findRunningServer(process.cwd()), 8001); }
  finally { globalThis.fetch = original; }
});

test('端口探测跳过 HTML 和旧课代表，仅打开此次启动实例的地址', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const port = new URL(url).port;
    if (port === '8000') return new Response('<html>other app</html>');
    return Response.json({ app: 'classrep', launch_id: port === '8001' ? 'old' : 'new', status: 'degraded' });
  };
  try { assert.equal(await findHealthyPort(1000, 'new'), 8002); }
  finally { globalThis.fetch = original; }
});
