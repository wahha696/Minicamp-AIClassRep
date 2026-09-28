import { useState } from 'react';
import {
  DEFAULT_BELLS,
  DAY,
  TZ,
  dateString,
  expandTimetable,
  findConflicts,
  minutes,
  periods,
  type CourseDTO,
  type TimetableDTO,
  type Occurrence,
  type Conflict,
} from '../../../../shared/timetable';
import { hhmm, weekdayDate } from '../lib/time';
import type { WeekItem } from '../lib/week';
import type { EventDTO } from '../api/types';

export interface GridDay {
  from: number;
  isToday: boolean;
}
interface Props {
  allEvents?: EventDTO[];
  days: GridDay[];
  courses: CourseDTO[];
  timetable?: TimetableDTO;
  itemsByDay: WeekItem[][];
  onPick: (id: number) => void;
  readonly?: boolean;
}
export function CourseCard({
  occurrence: o,
  conflicts = [],
  names = new Map(),
}: {
  occurrence: Occurrence;
  conflicts?: Conflict[];
  names?: Map<string, string>;
}) {
  const c = o.course;
  const relevant = conflicts.filter((x) => x.left === o.id || x.right === o.id);
  return (
    <details
      className={`min-w-0 rounded-md border p-2 text-xs ${relevant.length ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}
    >
      <summary className="cursor-pointer break-words font-medium leading-relaxed">
        {c.name}
        <span className="mt-1 block font-normal">
          {hhmm(o.start)}–{hhmm(o.end)} · {periods(c).join('–')} 节
        </span>
        {!!relevant.length && <span className="block text-amber-900">⚠ 时间冲突 {relevant.length} 项</span>}
      </summary>
      <div className="mt-2 space-y-1 break-words">
        <p>
          教师：{c.teacher || '未提供'} · 地点：{c.location || '未提供'}
        </p>
        <p>
          校区：{c.campus || '未提供'} · 班级：{c.class_name || '未提供'}
        </p>
        <p>
          第 {c.weeks.join(',')} 周 · {o.date}
        </p>
        {o.exception && (
          <p>
            本次例外：{o.exception.kind} {o.exception.note}
          </p>
        )}
        {relevant.map((x, i) => (
          <p key={i} className="text-amber-900">
            与 {names.get(x.left === o.id ? x.right : x.left) || '其他安排'} 重叠 {hhmm(x.start)}–
            {hhmm(x.end)}（{x.kind === 'course' ? '课程之间' : '课程与考试 / 安排'}）
          </p>
        ))}
        {!!relevant.length && <p>全部保留；可在设置 → 课表 → 编辑中标记请假、单次调课或暂时保留。</p>}
        {c.source && (
          <p className="text-slate-500">
            来源 {c.source.sheet} R{c.source.row}C{c.source.column}
          </p>
        )}
      </div>
    </details>
  );
}
function EventChip({ item, onPick }: { item: WeekItem; onPick: (id: number) => void }) {
  return (
    <button
      className="w-full break-words rounded bg-sky-50 p-2 text-left text-xs leading-relaxed text-sky-900"
      onClick={() => onPick(item.event.id)}
    >
      {item.isDeadline ? 'DDL 截止时点 · ' : ''}
      {hhmm(item.at)} {item.event.title}
    </button>
  );
}
export default function WeekGrid({
  days,
  courses,
  timetable,
  itemsByDay,
  allEvents,
  onPick,
  readonly,
}: Props) {
  const [list, setList] = useState(false);
  if (!days.length) return null;
  const table = timetable ?? {
    semester_start: dateString(days[0]!.from),
    courses: courses.map((c) => ({ ...c, weeks: [1] })),
  };
  const bells = table.bells ?? DEFAULT_BELLS;
  const occurrences = expandTimetable(table, days[0]!.from, days[days.length - 1]!.from + DAY);
  const sourceEvents =
    allEvents ??
    itemsByDay
      .flat()
      .filter((i) => !i.isDeadline)
      .map((i) => i.event);
  const events = sourceEvents
    .filter((e) => e.status !== 'cancelled' && e.status !== 'done')
    .map((e) => ({ id: `event-${e.id}`, start: e.start_at ?? NaN, end: e.end_at ?? NaN }));
  const conflicts = findConflicts(occurrences, events);
  const names = new Map([
    ...occurrences.map((o) => [o.id, o.course.name] as const),
    ...sourceEvents.map((e) => [`event-${e.id}`, e.title] as const),
  ]);
  const inDay = (d: GridDay) => occurrences.filter((o) => o.start < d.from + DAY && o.end > d.from);
  const render = (o: Occurrence) => (
    <CourseCard key={o.id} occurrence={o} conflicts={conflicts} names={names} />
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p>
          本周 {occurrences.length} 个实际课次 · {conflicts.length} 处时间冲突
        </p>
        <button className="rounded border px-3 py-1.5" aria-pressed={list} onClick={() => setList(!list)}>
          {list ? '切换节次网格' : '展开全天列表'}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        连堂课在覆盖的每一节显示，统计仅计一次；点击或按 Enter 展开完整信息。截止时间是时点，不占整段课时。
      </p>
      {list ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {days.map((d, i) => (
            <section key={d.from} className="min-w-0 space-y-2 rounded border p-3">
              <h3 className="text-sm font-semibold">
                {weekdayDate(d.from)} · {inDay(d).length} 门
              </h3>
              {inDay(d).map(render)}
              {!readonly &&
                (itemsByDay[i] ?? []).map((item) => (
                  <EventChip key={`${item.event.id}-${item.at}`} item={item} onPick={onPick} />
                ))}
              {!inDay(d).length && !itemsByDay[i]?.length && <p className="text-xs text-slate-500">无安排</p>}
            </section>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto" role="region" aria-label="课表网格" tabIndex={0}>
          <table className="w-full min-w-[840px] table-fixed border-separate border-spacing-1">
            <thead>
              <tr>
                <th className="w-24 text-xs">节次</th>
                {days.map((d) => (
                  <th
                    key={d.from}
                    scope="col"
                    className={`p-2 text-xs ${d.isToday ? 'bg-slate-900 text-white' : 'bg-slate-100'}`}
                  >
                    {weekdayDate(d.from)}
                    <span className="block font-normal">{inDay(d).length} 门</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bells.map((b) => (
                <tr key={b.period}>
                  <th scope="row" className="sticky left-0 bg-slate-50 p-2 text-xs font-normal">
                    第 {b.period} 节<br />
                    {b.start}–{b.end}
                  </th>
                  {days.map((d, i) => {
                    const start = d.from + minutes(b.start) * 60000,
                      end = d.from + minutes(b.end) * 60000;
                    const matching = inDay(d).filter((o) => o.start < end && o.end > start);
                    const items = (itemsByDay[i] ?? []).filter((item) => {
                      const minute = ((item.at + TZ) % DAY) / 60000;
                      return (
                        (bells.filter((x) => minutes(x.start) <= minute).at(-1) ?? bells[0])?.period ===
                        b.period
                      );
                    });
                    return (
                      <td key={d.from} className="space-y-1 border border-slate-100 p-1 align-top">
                        {matching.map(render)}
                        {!readonly &&
                          items.map((item) => (
                            <EventChip key={`${item.event.id}-${item.at}`} item={item} onPick={onPick} />
                          ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!list &&
        occurrences.some(
          (o) =>
            !bells.some(
              (b) =>
                o.start < Date.parse(`${o.date}T${b.end}:00+08:00`) &&
                o.end > Date.parse(`${o.date}T${b.start}:00+08:00`),
            ),
        ) && (
          <p role="status" className="rounded bg-amber-50 p-3 text-sm">
            有课程的实际时间在作息表之外，请展开全天列表查看全部课次。
          </p>
        )}
    </div>
  );
}
