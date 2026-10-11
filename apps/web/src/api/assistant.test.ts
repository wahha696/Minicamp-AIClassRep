import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./client', async () => ({ isMock: false, ...await import('./error') }));
import { assistantRequest } from './assistant';
afterEach(() => vi.unstubAllGlobals());
it('每个请求固定调用者epoch，使用同源cookie且不添加任务耗时截止', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: '完成' }), { status: 200 })); vi.stubGlobal('fetch', fetch);
  await assistantRequest('epoch-A', '/api/assistant/chat', 'POST', { message: '合成消息' });
  expect(fetch).toHaveBeenCalledWith('/api/assistant/chat', expect.objectContaining({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-ClassRep-Account-Epoch': 'epoch-A' }, signal: undefined }));
});
it('错误回执保留服务端原因，不自动重试可能写入的请求', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: '当前空间已切换' }), { status: 409 })); vi.stubGlobal('fetch', fetch);
  await expect(assistantRequest('old', '/api/assistant/plans/one/confirm', 'POST', { confirmed: true })).rejects.toThrow('当前空间已切换');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('未确认空间和非助手路径拒绝请求', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(assistantRequest('', '/api/assistant/chat', 'POST', {})).rejects.toThrow('当前空间');
  await expect(assistantRequest('A', 'https://untrusted.example/')).rejects.toThrow('路径无效');
  expect(fetch).not.toHaveBeenCalled();
});
