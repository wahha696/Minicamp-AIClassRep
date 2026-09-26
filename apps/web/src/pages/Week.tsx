// 本周页 /week（D3，FR-7.2 + FR-14）：固定周一到周日 7 天，可翻上周 / 下周 / 回到本周。
// 两种形态：「按时间」沿用纵向列表（套 SlotStack 折叠）；「按课表」是 7×5 网格（WeekGrid），
// 课程灰底、事件落格。形态选择存 localStorage。只有截止时间的事件显示「DDL」徽标。
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { exportIcsUrl, getEvents, getTimetable } from '../api/client';
import EventDrawer from '../components/EventDrawer';
import SlotStack from '../components/SlotStack';
import WeekGrid from '../components/WeekGrid';
import { usePolling } from '../hooks/usePolling';
import { isUpdated, typeMeta } from '../lib/eventMeta';
import { hhmm, weekdayDate } from '../lib/time';
import { weekOf } from '../lib/timetable';
import { groupByDay, thisMonday, weekRange, type WeekItem } from '../lib/week';
import { groupBySlot } from '../lib/slots';

const WEEK_MS = 7 * 24 * 3_600_000;
const MODE_KEY = 'weekMode';
type Mode = 'time' | 'grid';

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'grid' ? 'grid' : 'time';
  } catch {
    return 'time';
  }
}

function saveMode(m: Mode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // 存不下就只在本次生效
  }
}

/** 列表形态的小条目（时间 + 类型 + 标题 + 地点） */
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
          {isUpdated(event) && (
            <span className="rounded bg-sky-50 px-1 leading-4 text-sky-700" title="已按最新通知更新">
              已更新
            </span>
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
  // 当前查看那周的周一 0 点（上海时间）
  const [monday, setMonday] = useState(() => thisMonday());
  const [mode, setMode] = useState<Mode>(loadMode);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const timetable = usePolling(getTimetable, 60_000);

  const { data, error, loading, refresh } = usePolling(
    useCallback(() => {
      const { from, to } = weekRange(monday);
      return getEvents(from, to);
    }, [monday]),
    10_000,
  );

  const days = useMemo(() => groupByDay(data ?? [], monday), [data, monday]);
  const { from, to } = weekRange(monday);
  const total = days.reduce((n, d) => n + d.items.length, 0);
  const isThisWeek = monday === thisMonday();

  // 周数：有课表才显示「第 N 周」，否则只显示日期范围
  const semesterStart = timetable.data?.semester_start;
  const hasCourses = (timetable.data?.courses.length ?? 0) > 0;
  const weekN = hasCourses && semesterStart ? weekOf(monday, semesterStart) : null;
  const rangeText = `${new Date(from + 8 * 3_600_000).getUTCMonth() + 1}/${new Date(from + 8 * 3_600_000).getUTCDate()}–${new Date(to - 1 + 8 * 3_600_000).getUTCMonth() + 1}/${new Date(to - 1 + 8 * 3_600_000).getUTCDate()}`;

  // 课表形态要用的当周课程（按周数过滤）
  const weekCourses = useMemo(() => {
    if (!hasCourses || weekN === null) return [];
    return timetable.data!.courses.filter((c) => c.weeks.includes(weekN));
  }, [hasCourses, weekN, timetable.data]);

  const closeDrawer = useCallback(() => setSelectedId(null), []);
  const nav = (delta: number) => setMonday((m) => m + delta * WEEK_MS);
  const setModeAndSave = (m: Mode) => {
    setMode(m);
    saveMode(m);
  };

  return (
    <section>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {weekN !== null ? `第 ${weekN} 周` : '本周'}
            <span className="ml-2 text-base font-normal text-slate-500">{rangeText}</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {loading ? '正在读取本周日程…' : `这一周共 ${total} 件事`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 翻周 */}
          <div className="flex items-center rounded-lg border border-slate-300 bg-white text-sm">
            <button
              type="button"
              onClick={() => nav(-1)}
              className="px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
              aria-label="上一周"
            >
              ‹ 上周
            </button>
            {!isThisWeek && (
              <button
                type="button"
                onClick={() => setMonday(thisMonday())}
                className="border-x border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
              >
                回到本周
              </button>
            )}
            <button
              type="button"
              onClick={() => nav(1)}
              className="px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
              aria-label="下一周"
            >
              下周 ›
            </button>
          </div>

          {/* 形态切换 */}
          <div className="flex items-center rounded-lg border border-slate-300 bg-white p-0.5 text-xs font-medium" role="group" aria-label="形态">
            {(['time', 'grid'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setModeAndSave(m)}
                className={`rounded-md px-2.5 py-1 ${mode === m ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-900'}`}
              >
                {m === 'time' ? '按时间' : '按课表'}
              </button>
            ))}
          </div>

          <a
            href={exportIcsUrl(from, to)}
            download
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            导出本周
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

      {mode === 'grid' && !hasCourses && !timetable.loading && (
        <p className="mt-4 rounded-lg bg-sky-50 px-4 py-2.5 text-sm text-sky-800">
          导入课表后这里会显示你的课 →{' '}
          <Link to="/timetable" className="font-medium underline underline-offset-2">
            去导入
          </Link>
        </p>
      )}

      {mode === 'grid' ? (
        <div className="mt-6">
          <WeekGrid
            days={days.map((d) => ({ from: d.from, isToday: d.isToday }))}
            courses={weekCourses}
            itemsByDay={days.map((d) => d.items)}
            onPick={setSelectedId}
          />
        </div>
      ) : (
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
                  {(() => {
                    const itemOf = new Map(d.items.map((i) => [i.event.id, i]));
                    // 落位用 item.at（DDL 条目按截止时刻），与格子形态一致
                    return groupBySlot(
                      d.items.map((i) => i.event),
                      (e) => itemOf.get(e.id)?.at ?? null,
                    ).map((g) => (
                      <li key={g.key ?? g.rep.id}>
                        <SlotStack
                          group={g}
                          render={(e) => <Item item={itemOf.get(e.id)!} onClick={() => setSelectedId(e.id)} />}
                          onPick={setSelectedId}
                        />
                      </li>
                    ));
                  })()}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      <EventDrawer id={selectedId} onClose={closeDrawer} onChanged={() => void refresh()} />
    </section>
  );
}
