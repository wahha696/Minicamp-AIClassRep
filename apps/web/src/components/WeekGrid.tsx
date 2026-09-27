// 本周页「按课表」形态（D3 / FR-14）：7 列（周一…周日）× 5 行（两节一块）。
// 课程作格子灰色背景（课名 + 教室），事件按 blockOf(落位时间) 落格、levelStyle 着色、DDL 角标；
// 跨多块的事件只落在开始那块。手机横向滚动、左列 sticky，页面本身不出横向滚动条。
import type { CourseDTO, EventDTO } from '../api/types';
import { isUpdated, levelStyle, typeMeta } from '../lib/eventMeta';
import { groupBySlot } from '../lib/slots';
import { hhmm, weekdayDate } from '../lib/time';
import { blockOf, CLASS_BLOCKS } from '../lib/timetable';
import type { WeekItem } from '../lib/week';
import SlotStack from './SlotStack';

export interface GridDay {
  from: number;
  isToday: boolean;
}

interface Props {
  days: GridDay[]; // 周一到周日 7 天（from = 当天上海 0 点）
  /** 已按当周周数过滤好的课程 */
  courses: CourseDTO[];
  /** 每天的落位条目（groupByDay 的产物；落位时间 = item.at） */
  itemsByDay: WeekItem[][];
  onPick: (id: number) => void;
  /** 预览模式（设置页导入课表、确认前）：不显示事件、不可点击 */
  readonly?: boolean;
}

function EventChip({ item, onClick }: { item: WeekItem; onClick?: () => void }) {
  const { event, at, isDeadline } = item;
  const meta = typeMeta(event.type);
  const lv = levelStyle(event.type, event.level);
  const done = event.status === 'done';
  return (
    <button
      type="button"
      onClick={onClick}
      title={event.title}
      className={`block w-full truncate rounded px-1.5 py-0.5 text-left text-xs font-medium ${lv.bg} ${lv.text} ${
        done ? 'opacity-50 line-through' : ''
      }`}
    >
      {isDeadline && <span className="mr-0.5 rounded bg-red-600 px-0.5 text-[10px] text-white">DDL</span>}
      {event.level_locked && '📌'}
      {isUpdated(event) && '↻'}
      {`${hhmm(at)} ${event.title}`}
      <span className="sr-only">（{meta.label}）</span>
    </button>
  );
}

/** 一个格子：课程灰底 + 落在这块的事件（>1 条时折叠成最急一条 + …+N） */
function Cell({
  courses,
  items,
  onPick,
  readonly,
}: {
  courses: CourseDTO[];
  items: WeekItem[];
  onPick: (id: number) => void;
  readonly?: boolean;
}) {
  // 同格事件同天同块，groupBySlot 自然把它们合成一组；落位时间用 item.at（DDL 条目按截止时刻）
  const events = items.map((i) => i.event);
  const itemOf = new Map(items.map((i) => [i.event.id, i]));
  return (
    <div className="flex h-full min-h-16 flex-col gap-1 p-1">
      {courses.map((c, i) => (
        <div
          key={i}
          className="rounded-md bg-slate-200/70 px-1.5 py-1 text-xs leading-tight text-slate-500"
          title={`${c.name}　${c.teacher}`}
        >
          <div className="line-clamp-2 font-medium">{c.name}</div>
          {c.location && <div className="truncate text-[10px] text-slate-400">{c.location}</div>}
        </div>
      ))}
      {!readonly &&
        groupBySlot(events, (e) => itemOf.get(e.id)?.at ?? null).map((g) => (
          <SlotStack
            key={g.key ?? g.rep.id}
            group={g}
            render={(e) => <EventChip item={itemOf.get(e.id)!} />}
            onPick={onPick}
          />
        ))}
    </div>
  );
}

export default function WeekGrid({ days, courses, itemsByDay, onPick, readonly }: Props) {
  return (
    <div className="overflow-x-auto" role="region" aria-label="课表网格">
      {/* min-width 保证手机上格子不被挤没；外层 overflow-x-auto 让横向滚动只发生在网格内 */}
      <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-1">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 w-14 bg-slate-50 text-xs font-normal text-slate-400" scope="col">
              节次
            </th>
            {days.map((d) => (
              <th
                key={d.from}
                scope="col"
                className={`rounded-md px-1 py-1.5 text-xs font-semibold ${
                  d.isToday ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'
                }`}
              >
                {weekdayDate(d.from)}
                {d.isToday && <span className="ml-1 font-normal">今天</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CLASS_BLOCKS.map((b) => (
            <tr key={b.block}>
              <th
                scope="row"
                className="sticky left-0 z-10 w-14 rounded-md bg-slate-50 px-1 py-1 text-left align-top text-[10px] font-normal leading-tight text-slate-400"
              >
                <div className="font-medium text-slate-500">{b.label}</div>
                <div>{b.time}</div>
              </th>
              {days.map((d, di) => {
                const cellCourses = courses.filter((c) => c.weekday === di + 1 && c.block === b.block);
                const cellItems = (itemsByDay[di] ?? []).filter((i) => blockOf(i.at) === b.block);
                return (
                  <td
                    key={d.from}
                    className={`rounded-md border align-top ${
                      d.isToday ? 'border-slate-300 bg-white' : 'border-slate-100 bg-white/70'
                    }`}
                  >
                    <Cell courses={cellCourses} items={cellItems} onPick={onPick} readonly={readonly} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
