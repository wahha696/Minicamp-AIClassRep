import { useCallback, useEffect, useRef, useState } from 'react';

export interface Polling<T> {
  data: T | undefined;      // 最近一次成功的结果；失败时保留上一次的数据，页面不白屏
  error: Error | undefined; // 最近一次失败；成功后清空
  loading: boolean;         // 还没拿到过任何结果
  refresh: () => Promise<void>; // 立即再拉一次（如操作后刷新）
}

/**
 * 立即调用一次 fn，之后每 intervalMs 调用一次。
 * fn 不需要 useCallback，总是用最新的那个。
 */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number): Polling<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const inFlight = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    // 正在请求时再被调用（比如刚点完按钮）：等这次返回后立刻补拉一次，保证拿到最新数据
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
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
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!inFlight.current) void refresh(); // 定时轮询遇到上一次没返回就跳过，不叠请求
    }, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { data, error, loading, refresh };
}
