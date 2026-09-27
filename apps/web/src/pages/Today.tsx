// 今日页 /（D2，FR-7.1 + FR-15）：顶部大字摘要 + 待办框（窄屏在事件列表上方，宽屏右栏）
// + 事件卡片（按时间 / 按紧急两种排序，可切换；同一节次块折叠成最急的一张），每 10s 刷新。
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { exportIcsUrl, getEvents, getToday, getTodos } from '../api/client';
import EventCard from '../components/EventCard';
import EventDrawer from '../components/EventDrawer';
import SlotStack from '../components/SlotStack';
import TodoBox from '../components/TodoBox';
import { usePolling } from '../hooks/usePolling';
import { groupBySlot } from '../lib/slots';
import { SORT_LABEL, type SortMode, sortEvents } from '../lib/sort';
import { shanghaiDayRange } from '../lib/time';

const UPCOMING_DAYS = 3;
const SORT_KEY = 'todaySort'; // 记住上次选的排序

function loadSort(): SortMode {
  try {
    return localStorage.getItem(SORT_KEY) === 'urgency' ? 'urgency' : 'time';
  } catch {
    return 'time';
  }
}

export default function Today() {
  const { data, error, loading, refresh } = usePolling(getToday, 10_000);
  const todos = usePolling(getTodos, 10_000);
  // 接下来 3 天（明天 0 点起）：周末 / 周日也能一眼看到下周初的事
  const upcoming = usePolling(
    useCallback(() => getEvents(shanghaiDayRange(1).from, shanghaiDayRange(UPCOMING_DAYS).to), []),
    30_000,
  );
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sort, setSort] = useState<SortMode>(loadSort);

  function toggleSort() {
    const next: SortMode = sort === 'time' ? 'urgency' : 'time';
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      // 存不下就只在本次生效
    }
  }

  // 每次轮询拿到新数据都按当前时间重排（「两小时内」会随时间变化），再按节次块折叠
  const upcomingEvents = useMemo(
    () => sortEvents((upcoming.data ?? []).filter((e) => e.status !== 'done'), 'time'),
    [upcoming.data],
  );
  const groups = useMemo(() => groupBySlot(sortEvents(data?.events ?? [], sort)), [data, sort]);

  const onChanged = useCallback(() => {
    void refresh();
    void todos.refresh();
    void upcoming.refresh();
  }, [refresh, todos.refresh, upcoming.refresh]);
  const closeDrawer = useCallback(() => setSelectedId(null), []);
  const { from, to } = shanghaiDayRange(0);

  return (
    <section>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-slate-400">{data?.date ?? ' '}</p>
          <h1 className="mt-1 text-2xl font-bold leading-snug text-slate-900 sm:text-3xl">
            {data?.summary ?? (loading ? '正在读取今天的日程…' : '暂时读不到今天的日程')}
          </h1>
        </div>
        <div className="flex shrink-0 gap-2">
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

      <div className="mt-6 lg:flex lg:items-start lg:gap-6">
        {/* 待办框：窄屏在事件列表上方，宽屏挪到右栏 */}
        <div className="order-first mb-6 lg:order-none lg:mb-0 lg:w-80 lg:shrink-0">
          <TodoBox
            data={todos.data}
            loading={todos.loading}
            onChanged={onChanged}
            onOpenEvent={setSelectedId}
          />
        </div>

        <div className="min-w-0 flex-1">
          {loading && (
            <div className="space-y-3" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-200/60" />
              ))}
            </div>
          )}

          {data && data.events.length > 0 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400">
                {sort === 'time' ? '按开始 / 截止时间先后' : '按危机等级，同级里两小时内最前'}
              </p>
              <button
                type="button"
                onClick={toggleSort}
                title="切换排序方式"
                className="flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {SORT_LABEL[sort]}
              </button>
            </div>
          )}

          {data && data.events.length > 0 && (
            <ul className="mt-3 space-y-3">
              {groups.map((g) => (
                <li key={g.key ?? g.rep.id}>
                  <SlotStack
                    group={g}
                    render={(e) => <EventCard event={e} onClick={() => setSelectedId(e.id)} />}
                    onPick={setSelectedId}
                  />
                </li>
              ))}
            </ul>
          )}

          {data && data.events.length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
              <div className="text-5xl" aria-hidden>
                ☕️
              </div>
              <p className="mt-4 text-lg font-medium text-slate-700">今天没有安排，轻松一天 🎉</p>
              <p className="mt-2 text-sm text-slate-400">群里有新通知时会自动出现在这里</p>
              <Link
                to="/demo"
                className="mt-6 inline-block rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                去演示控制台看看效果 →
              </Link>
            </div>
          )}

          {upcomingEvents.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-slate-600">
                接下来 {UPCOMING_DAYS} 天
                <span className="ml-2 font-normal text-slate-400">{upcomingEvents.length} 件</span>
              </h2>
              <ul className="mt-3 space-y-3">
                {upcomingEvents.map((e) => (
                  <li key={e.id}>
                    <EventCard event={e} onClick={() => setSelectedId(e.id)} />
                  </li>
                ))}
              </ul>
              <Link to="/week" className="mt-3 inline-block text-xs text-slate-500 underline underline-offset-2">
                看完整周历 →
              </Link>
            </div>
          )}
        </div>
      </div>

      <EventDrawer id={selectedId} onClose={closeDrawer} onChanged={onChanged} />
    </section>
  );
}
