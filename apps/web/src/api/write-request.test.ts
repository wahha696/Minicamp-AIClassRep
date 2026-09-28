import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it('账号控制和其他写操作发送 JSON，删除选项保留，读取不附加请求体', async () => {
  vi.stubEnv('VITE_MOCK', '');
  const fetchMock = vi.fn(async (url: string) => new Response(
    url === '/api/connect/status'
      ? '{"state":"online","account_epoch":"v2:test:1:0","since":1,"first_run":false}'
      : '{"ok":true}',
    { headers: { 'Content-Type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  const api = await import('./client');
  await api.getConnectStatus();
  const account = { accountEpoch: 'v2:test:1:0', uin: '10001' };
  await api.logoutConnect(account);
  await api.logoutConnect(account, false);
  await api.logoutConnect(account, true);
  await api.restartConnect({ accountEpoch: 'v2:test:1:0', uin: null });
  await api.deleteGroupData('test');
  await api.getConnectStatus();
  const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
  expect(calls[1]![0]).toBe('/api/connect/logout');
  for (const index of [1, 2, 3, 4, 5]) {
    expect(new Headers(calls[index]![1].headers).get('Content-Type')).toBe('application/json');
  }
  expect(new Headers(calls[5]![1].headers).get('X-ClassRep-Account-Epoch')).toBe('v2:test:1:0');
  expect(JSON.parse(String(calls[1]![1].body))).toEqual({
    expected_account_epoch: 'v2:test:1:0', expected_uin: '10001',
  });
  expect(JSON.parse(String(calls[2]![1].body))).toEqual({
    expected_account_epoch: 'v2:test:1:0', expected_uin: '10001',
  });
  expect(JSON.parse(String(calls[3]![1].body))).toEqual({
    expected_account_epoch: 'v2:test:1:0', expected_uin: '10001', erase: true,
  });
  expect(JSON.parse(String(calls[4]![1].body))).toEqual({
    expected_account_epoch: 'v2:test:1:0', expected_uin: null,
  });
  expect(JSON.parse(String(calls[5]![1].body))).toEqual({});
  for (const index of [0, 6]) {
    expect(calls[index]![1].body).toBeUndefined();
    expect(calls[index]![1].headers).toBeUndefined();
  }
});
