// 事件卡片（D2 今日页用，D3 本周页可复用）：底色与左侧色条按「类型色相 × 危机等级深浅」。
// pending_confirm → 「待确认」小标签；done → 整张置灰 + 标题划线；有变更记录 →「已按最新通知更新」；
// 等级被手动锁定 → 图钉图标。
import type { EventDTO } from '../api/types';
import { isUpdated, LEVEL_LABEL, levelStyle, typeMeta } from '../lib/eventMeta';
import { eventTimeText } from '../lib/time';

/** 等级被手动锁定（level_locked）时的小图钉 */
export function PinIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? 'h-3 w-3'}
      fill="currentColor"
      aria-hidden
    >
      <title>等级已手动锁定</title>
      <path d="M14.5 3.5 20.5 9.5l-1.4 1.4-.7-.1-4.3 4.3v3.4l-1.4 1.4-3.5-3.5-4.3 4.2-1.4-1.4 4.2-4.3-3.5-3.5 1.4-1.4h3.4l4.3-4.3-.1-.7 1.4-1.4Z" />
    </svg>
  );
}

export default function EventCard({ event, onClick }: { event: EventDTO; onClick?: () => void }) {
  const meta = typeMeta(event.type);
  const lv = levelStyle(event.type, event.level);
  const time = eventTimeText(event);
  const done = event.status === 'done';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full overflow-hidden rounded-xl border border-slate-200 text-left shadow-sm transition hover:shadow ${lv.bg} ${
        done ? 'opacity-50' : ''
      }`}
    >
      <span className={`w-1.5 shrink-0 ${lv.bar}`} aria-hidden />
      <div className="min-w-0 flex-1 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded bg-white/60 px-1.5 py-0.5 text-xs font-medium ${lv.text}`}>
            {meta.label}
          </span>
          {event.status === 'pending_confirm' && (
            <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
              待确认
            </span>
          )}
          {isUpdated(event) && (
            <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">已按最新通知更新</span>
          )}
          {done && <span className="text-xs text-slate-500">已完成</span>}
          <span className={`ml-auto flex items-center gap-0.5 text-xs font-medium ${lv.text}`}>
            {event.level_locked && <PinIcon className="h-3 w-3" />}
            {LEVEL_LABEL[event.level] ?? '中'}
          </span>
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
