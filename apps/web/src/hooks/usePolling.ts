import { useCallback, useEffect, useRef, useState } from 'react';

export interface Polling<T> {
  data: T | undefined;      // 最近一次成功的结果；失败时保留上一次的数据，页面不白屏
  error: Error | undefined; // 最近一次失败；成功后清空
  loading: boolean;         // 还没拿到过任何结果
  refresh: () => Promise<void>; // 立即再拉一次（如操作后刷新）；返回的 promise 在拿到新数据后才 resolve
}

/**
 * 立即调用一次 fn，之后每 intervalMs 调用一次。
 * fn 不需要 useCallback，总是用最新的那个。
 * resetKey 变化（如换 QQ 号）时清掉旧数据、重新 loading 再拉——旧号的数据不会在页面上闪一下。
 */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, resetKey?: unknown): Polling<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useRef<Promise<void> | null>(null); // 在途请求
  const again = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback((): Promise<void> => {
    // 正在请求时再被调用（比如刚点完按钮）：标记补拉，并返回同一个在途 promise——
    // 调用方 await 到的是补拉完成后的最新数据，不会再拿到旧数据（B13）。
    if (run.current) {
      again.current = true;
      return run.current;
    }
    const p = (async () => {
      try {
        do {
          again.current = false;
          try {
            const result = await fnRef.current();
            if (!alive.current) return;
            setData(result);
            setError(undefined);
          } catch (e) {
            if (!alive.current) return;
            setError(e instanceof Error ? e : new Error(String(e)));
          }
          setLoading(false);
        } while (again.current);
      } finally {
        run.current = null;
      }
    })();
    run.current = p;
    return p;
  }, []);

  useEffect(() => {
    alive.current = true;
    // resetKey 变化（首次挂载也算）：清掉上一次的数据从头来
    setData(undefined);
    setError(undefined);
    setLoading(true);
    void refresh();
    const timer = setInterval(() => {
      // 定时轮询遇到上一次没返回就跳过，不叠请求；标签页隐藏时暂停（P3）
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (!run.current && !hidden) void refresh();
    }, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs, resetKey]);

  return { data, error, loading, refresh };
}
