import { afterEach, expect, it, vi } from 'vitest';
import { cancelHistoryJob, getHistoryJobs, retryHistoryJob, startHistoryJob } from './history-jobs';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('任务操作隔离空间且只发短控制请求，微信读取需显式批准', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job: { id: 'synthetic' } }) });
  vi.stubGlobal('fetch', fetcher);
  await startHistoryJob('epoch-1', 'wechat', 30);
  const [path, options] = fetcher.mock.calls[0];
  expect(path).toBe('/api/history-jobs');
  expect(options.headers['X-ClassRep-Account-Epoch']).toBe('epoch-1');
  expect(JSON.parse(options.body)).toEqual({ expected_account_epoch: 'epoch-1', platform: 'wechat', days: 30, approve_history_read: true });
  await cancelHistoryJob('epoch-1', 'a/b'); await retryHistoryJob('epoch-1', 'a/b');
  expect(fetcher.mock.calls.slice(1).map(([url]) => url)).toEqual(['/api/history-jobs/a%2Fb/cancel', '/api/history-jobs/a%2Fb/retry']);
});
it('短请求连接超时只报告状态未知，不报告补拉失败或重试POST', async () => {
  const fetcher = vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
  vi.stubGlobal('fetch', fetcher);
  await expect(startHistoryJob('epoch', 'qq', 7)).rejects.toMatchObject({ status: 0, message: expect.stringContaining('无法确认后台状态') });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('状态读取附带epoch，空间冲突保留服务端错误', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: '空间已切换' }) });
  vi.stubGlobal('fetch', fetcher);
  await expect(getHistoryJobs('old-epoch')).rejects.toMatchObject({ status: 409, message: '空间已切换' });
  expect(fetcher.mock.calls[0][1].headers['X-ClassRep-Account-Epoch']).toBe('old-epoch');
});
it('演示模式不会意外连接真实采集接口，演示空间相互隔离', async () => {
  vi.stubEnv('VITE_MOCK', '1'); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect((await startHistoryJob('demo-space', 'qq', 7)).job.messages).toBe(0);
  expect((await getHistoryJobs('demo-space')).jobs).toHaveLength(1);
  expect((await getHistoryJobs('other-demo-space')).jobs).toHaveLength(0);
  expect(fetcher).not.toHaveBeenCalled();
});
