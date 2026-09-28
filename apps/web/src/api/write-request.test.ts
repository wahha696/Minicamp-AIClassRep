import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it('无参数退出和其他写操作发送 JSON，删除选项保留，读取不附加请求体', async () => {
  vi.stubEnv('VITE_MOCK', '');
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  const api = await import('./client');
  await api.logoutConnect();
  await api.logoutConnect(false);
  await api.logoutConnect(true);
  await api.restartConnect();
  await api.deleteGroupData('test');
  await api.getConnectStatus();
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  expect(calls[0]![0]).toBe('/api/connect/logout');
  for (const index of [0, 1, 3, 4]) {
    expect(calls[index]![1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(calls[index]![1].body))).toEqual({});
  }
  expect(JSON.parse(String(calls[2]![1].body))).toEqual({ erase: true });
  expect(calls[5]![1].body).toBeUndefined();
  expect(calls[5]![1].headers).toBeUndefined();
});
