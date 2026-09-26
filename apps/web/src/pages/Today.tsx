// 今日页 /（D2，FR-7.1）：顶部大字摘要 + 按时间排序的事件卡片，每 10s 刷新。
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, exportIcsUrl, getToday, syncNow } from '../api/client';
import EventCard from '../components/EventCard';
import EventDrawer from '../components/EventDrawer';
import { useToast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';
import { shanghaiDayRange } from '../lib/time';

export default function Today() {
  const { data, error, loading, refresh } = usePolling(getToday, 10_000);
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  async function onSync() {
    setSyncing(true);
    try {
      const r = await syncNow();
      toast(`已同步 ${r.groups} 个群、${r.messages} 条消息`);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast('QQ 未连接', 'error');
      else toastError(toast, e);
    } finally {
      setSyncing(false);
    }
  }

  const closeDrawer = useCallback(() => setSelectedId(null), []);
  const { from, to } = shanghaiDayRange(0);

  return (
    <section>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-slate-400">{data?.date ?? ' '}</p>
          <h1 className="mt-1 text-2xl font-bold leading-snug text-slate-900 sm:text-3xl">
            {data?.summary ?? (loading ? '正在读取今天的日程…' : '暂时读不到今天的日程')}
          </h1>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onSync}
            disabled={syncing}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {syncing ? '同步中…' : '立即同步'}
          </button>
          <a
            href={exportIcsUrl(from, to)}
            download
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            导出今日到日历
          </a>
        </div>
      </div>

      {error && !data && (
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error.message}
          <button type="button" onClick={() => void refresh()} className="ml-3 font-medium underline">
            重试
          </button>
        </div>
      )}

      {loading && (
        <div className="mt-6 space-y-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-200/60" />
          ))}
        </div>
      )}

      {data && data.events.length > 0 && (
        <ul className="mt-6 space-y-3">
          {data.events.map((e) => (
            <li key={e.id}>
              <EventCard event={e} onClick={() => setSelectedId(e.id)} />
            </li>
          ))}
        </ul>
      )}

      {data && data.events.length === 0 && (
        <div className="mt-10 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <div className="text-5xl" aria-hidden>
            ☕️
          </div>
          <p className="mt-4 text-lg font-medium text-slate-700">今天没有待办，轻松一天 🎉</p>
          <p className="mt-2 text-sm text-slate-400">群里有新通知时会自动出现在这里</p>
          <Link
            to="/demo"
            className="mt-6 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            去演示控制台看看效果 →
          </Link>
        </div>
      )}

      <EventDrawer id={selectedId} onClose={closeDrawer} onChanged={() => void refresh()} />
    </section>
  );
}
