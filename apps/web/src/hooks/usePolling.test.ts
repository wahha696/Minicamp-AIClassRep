// @vitest-environment jsdom
// B13：refresh() 返回在途 promise（调用方 await 到的是补拉后的新数据）；
// P3：标签页隐藏时定时轮询暂停；resetKey 变化清数据重拉（换号不闪旧数据）。
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling';

// React 19：告诉调度器当前在测试环境，act() 才能用
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePolling（B13/P3）', () => {
  it('在途时 refresh() 返回同一个 promise，并补拉一次拿到最新数据', async () => {
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise)
      .mockImplementation(() => Promise.resolve('later'));

    const { result } = renderHook(() => usePolling(fn, 60_000));
    const p1 = result.current.refresh(); // 第一次还在飞
    const p2 = result.current.refresh();
    expect(p2).toBe(p1); // B13：同一个在途 promise

    await act(async () => {
      d1.resolve('first');
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(2); // 补拉已发出

    await act(async () => {
      d2.resolve('second');
      await p1;
    });
    expect(result.current.data).toBe('second'); // await 到的是补拉后的数据
    expect(result.current.loading).toBe(false);
  });

  it('拉取失败不清空旧数据，error 可见，下一次成功清掉 error', async () => {
    const d1 = deferred<string>();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => d1.promise)
      .mockRejectedValueOnce(new Error('断网'))
      .mockImplementation(() => Promise.resolve('又好了'));

    const { result } = renderHook(() => usePolling(fn, 60_000));
    await act(async () => {
      d1.resolve('ok');
      await Promise.resolve();
    });
    expect(result.current.data).toBe('ok');

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.data).toBe('ok'); // 失败不白屏
    expect(result.current.error?.message).toBe('断网');

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.data).toBe('又好了');
    expect(result.current.error).toBeUndefined();
  });

  it('resetKey 变化：清掉旧数据重新拉，旧号数据不留', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => Promise.resolve('uin-1的数据'))
      .mockImplementation(() => Promise.resolve('uin-2的数据'));

    const { result, rerender } = renderHook(({ k }: { k: string }) => usePolling(fn, 60_000, k), {
      initialProps: { k: '10001' },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data).toBe('uin-1的数据');

    rerender({ k: '20002' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data).toBe('uin-2的数据');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('定时轮询：在途合并、标签页隐藏暂停、恢复可见继续', async () => {
    vi.useFakeTimers();
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('v');
    renderHook(() => usePolling(fn, 1000));
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(1); // 挂载即拉

    vi.advanceTimersByTime(3000); // 3 次 tick，但请求在途 → 合并成 1 次
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(2);

    const hiddenSpy = vi
      .spyOn(document, 'hidden', 'get')
      .mockReturnValue(true);
    vi.advanceTimersByTime(3000); // 隐藏：一次都不再调
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(2);

    hiddenSpy.mockReturnValue(false);
    vi.advanceTimersByTime(1000); // 恢复可见：继续轮询
    await act(async () => {
      await Promise.resolve();
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
