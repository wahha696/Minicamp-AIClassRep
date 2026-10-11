// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usePolling } from './usePolling';

it('换空间后丢弃旧请求，旧请求结束也不会覆盖新空间数据或清除在途状态', async () => {
  let oldResult!: (value: string) => void;
  const old = new Promise<string>(resolve => { oldResult = resolve; });
  const request = vi.fn().mockReturnValueOnce(old).mockResolvedValue('新空间');
  const { result, rerender, unmount } = renderHook(({ scope }) => usePolling(request, 60000, scope), { initialProps: { scope: 'old' } });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  rerender({ scope: 'new' });
  await waitFor(() => expect(result.current.data).toBe('新空间'));
  await act(async () => oldResult('旧空间'));
  expect(result.current.data).toBe('新空间');
  expect(result.current.lastSuccessAt).toEqual(expect.any(Number));
  unmount();
});

it('首次失败没有有效空数据；刷新失败保留上次数据和成功时间', async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error('首次失败')).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('刷新失败'));
  const { result, unmount } = renderHook(() => usePolling(request, 60000));
  await waitFor(() => expect(result.current.error?.message).toBe('首次失败'));
  expect(result.current.data).toBeUndefined();
  await act(async () => result.current.refresh());
  const savedAt = result.current.lastSuccessAt;
  await act(async () => result.current.refresh());
  expect(result.current.data).toEqual([]);
  expect(result.current.lastSuccessAt).toBe(savedAt);
  expect(result.current.error?.message).toBe('刷新失败');
  unmount();
});
