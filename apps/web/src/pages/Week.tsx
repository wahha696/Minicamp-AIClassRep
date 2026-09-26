// 本周页 /week（D3，FR-7.2）：从今天起 7 天，电脑上 7 列、手机上 7 段纵向列表，今天高亮。
// 只有截止时间的事件显示为红底带「DDL」徽标的条目，和普通事件一眼能区分。
import { useState } from 'react';
import { exportIcsUrl, getEvents } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { typeMeta } from '../lib/eventMeta';
import { hhmm, weekdayDate } from '../lib/time';
import { groupByDay, weekRange, type WeekItem } from '../lib/week';

function fetchWeek() {
  const { from, to } = weekRange();
  return getEvents(from, to);
}

function Item({ item, onClick }: { item: WeekItem; onClick: () => void }) {
  const { event, at, isDeadline } = item;
  const meta = typeMeta(event.type);
  const done = event.status === 'done';

  return (
    <button
      type="button"
      onClick={onClick}
      title={event.title}
      className={`flex w-full overflow-hidden rounded-lg border text-left text-sm transition hover:shadow-sm ${
        isDeadline ? 'border-red-200 bg-red-50 hover:border-red-300' : 'border-slate-200 bg-white hover:border-slate-300'
      } ${done ? 'opacity-50' : ''}`}
    >
      <span className="w-1 shrink-0" style={{ backgroundColor: meta.color }} aria-hidden />
      <div className="min-w-0 flex-1 px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {isDeadline ? (
            <>
              <span className="rounded bg-red-600 px-1 font-semibold leading-4 text-white">DDL</span>
              <span className="font-medium text-red-600">{hhmm(at)} 截止</span>
            </>
          ) : (
            <span className="font-medium text-slate-600">{hhmm(at)}</span>
          )}
          <span style={{ color: meta.color }}>{meta.label}</span>
          {event.status === 'pending_confirm' && (
            <span className="rounded border border-amber-300 bg-amber-50 px-1 leading-4 text-amber-700">待确认</span>
          )}
        </div>
        <div className={`mt-0.5 line-clamp-2 font-medium text-slate-800 ${done ? 'line-through' : ''}`}>
          {event.title}
        </div>
        {event.location && <div className="mt-0.5 truncate text-xs text-slate-400">📍 {event.location}</div>}
      </div>
    </button>
  );
}

export default function Week() {
  const { data, error, loading, refresh } = usePolling(fetchWeek, 10_000);
  // 点条目选中的事件；详情抽屉在 D4 接上
  const [, setSelectedId] = useState<number | null>(null);

  const days = groupByDay(data ?? []);
  const { from, to } = weekRange();
  const total = days.reduce((n, d) => n + d.items.length, 0);

  return (
    <section>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">本周</h1>
          <p className="mt-1 text-sm text-slate-500">
            {loading ? '正在读取本周日程…' : `未来 7 天共 ${total} 件事`}
          </p>
        </div>
        <a
          href={exportIcsUrl(from, to)}
          download
          className="self-start rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 sm:self-auto"
        >
          导出本周
        </a>
      </div>

      {error && !data && (
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error.message}
          <button type="button" onClick={() => void refresh()} className="ml-3 font-medium underline">
            重试
          </button>
        </div>
      )}

      <div className="mt-6 grid gap-3 md:grid-cols-7 md:gap-2">
        {days.map((d) => (
          <div
            key={d.from}
            className={`rounded-xl border p-2 md:min-h-64 ${
              d.isToday ? 'border-slate-900 bg-white ring-1 ring-slate-900' : 'border-slate-200 bg-white/60'
            }`}
          >
            <h2
              className={`mb-2 flex items-center justify-between rounded-md px-2 py-1 text-sm font-semibold ${
                d.isToday ? 'bg-slate-900 text-white' : 'text-slate-600'
              }`}
            >
              <span>{weekdayDate(d.from)}</span>
              {d.isToday && <span className="text-xs font-normal">今天</span>}
            </h2>

            {loading ? (
              <div className="h-12 animate-pulse rounded-lg bg-slate-200/60" />
            ) : d.items.length === 0 ? (
              <p className="px-2 py-1 text-xs text-slate-300">无安排</p>
            ) : (
              <ul className="space-y-1.5">
                {d.items.map((item) => (
                  <li key={item.event.id}>
                    <Item item={item} onClick={() => setSelectedId(item.event.id)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
