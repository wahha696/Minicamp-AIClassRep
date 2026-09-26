// 事件卡片（D2 今日页用，D3 本周页可复用）：左侧类型色条、类型标签、标题、时间、地点、群名。
// pending_confirm → 「待确认」小标签；done → 整张置灰 + 标题划线。
import type { EventDTO } from '../api/types';
import { typeMeta } from '../lib/eventMeta';
import { eventTimeText } from '../lib/time';

export default function EventCard({ event, onClick }: { event: EventDTO; onClick?: () => void }) {
  const meta = typeMeta(event.type);
  const time = eventTimeText(event);
  const done = event.status === 'done';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-sm transition hover:border-slate-300 hover:shadow ${
        done ? 'opacity-50' : ''
      }`}
    >
      <span className="w-1.5 shrink-0" style={{ backgroundColor: meta.color }} aria-hidden />
      <div className="min-w-0 flex-1 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 text-xs font-medium"
            style={{ color: meta.color, backgroundColor: `${meta.color}1a` }}
          >
            {meta.label}
          </span>
          {event.status === 'pending_confirm' && (
            <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
              待确认
            </span>
          )}
          {done && <span className="text-xs text-slate-500">已完成</span>}
        </div>

        <h3
          className={`mt-1.5 truncate text-base font-semibold text-slate-900 ${done ? 'line-through' : ''}`}
          title={event.title}
        >
          {event.title}
        </h3>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-slate-500">
          <span className={time.isDeadline && !done ? 'font-medium text-red-600' : 'text-slate-700'}>
            {time.text}
          </span>
          {event.location && <span>📍 {event.location}</span>}
          <span className="truncate">{event.group_name}</span>
        </div>
      </div>
    </button>
  );
}
