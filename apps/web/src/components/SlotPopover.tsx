// 同一节次块的事件列表浮层（FR-14 展开）：
// 宽屏（md+）锚定在触发卡片旁的浮层，放不下时翻到另一侧；手机从底部弹出抽屉。
// Esc / 点空白关闭；点某条 → onPick 交给外层（一般是打开 EventDrawer）。
import { useEffect, useRef, useState } from 'react';
import type { EventDTO } from '../api/types';
import { isUpdated, LEVEL_LABEL, levelStyle, typeMeta } from '../lib/eventMeta';
import { eventTimeText } from '../lib/time';

interface Props {
  items: EventDTO[];
  /** 触发元素的矩形，用来把浮层钉在它旁边（宽屏） */
  anchor: DOMRect | null;
  onPick: (id: number) => void;
  onClose: () => void;
}

function Row({ event, onClick }: { event: EventDTO; onClick: () => void }) {
  const meta = typeMeta(event.type);
  const lv = levelStyle(event.type, event.level);
  const time = eventTimeText(event);
  const done = event.status === 'done';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50 ${
        done ? 'opacity-50' : ''
      }`}
    >
      <span className={`mt-1.5 h-3 w-1 shrink-0 rounded-full ${lv.bar}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className={lv.text}>{meta.label}</span>
          <span className={`rounded px-1 font-medium leading-4 ${lv.bg} ${lv.text}`}>
            {LEVEL_LABEL[event.level]}
          </span>
          {event.level_locked && <span className="text-slate-400">📌</span>}
          {event.status === 'pending_confirm' && (
            <span className="rounded border border-amber-300 bg-amber-50 px-1 leading-4 text-amber-700">待确认</span>
          )}
          {isUpdated(event) && <span className="rounded bg-sky-50 px-1 leading-4 text-sky-700">已更新</span>}
        </span>
        <span className={`mt-0.5 block truncate font-medium text-slate-800 ${done ? 'line-through' : ''}`}>
          {event.title}
        </span>
        <span className="mt-0.5 block text-xs text-slate-400">
          {time.text}
          {event.location ? ` · ${event.location}` : ''} · {event.group_name}
        </span>
      </span>
    </button>
  );
}

export default function SlotPopover({ items, anchor, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Esc 关闭 + 打开时把焦点收进浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector('button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 宽屏定位：默认放锚点右边，右边放不下（距右缘 < 24rem）翻左边；垂直方向居中并夹在视口内
  useEffect(() => {
    if (!anchor || window.innerWidth < 768) {
      setPos(null);
      return;
    }
    const width = 320;
    const flip = anchor.right + 8 + width > window.innerWidth - 8;
    const left = flip ? Math.max(8, anchor.left - 8 - width) : anchor.right + 8;
    const height = Math.min(360, items.length * 72 + 60);
    const top = Math.min(
      Math.max(8, anchor.top + anchor.height / 2 - height / 2),
      window.innerHeight - height - 8,
    );
    setPos({ left, top });
  }, [anchor, items.length]);

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="同一时段的事件">
      <div className="absolute inset-0 animate-[fade-in_.15s_ease-out] bg-slate-900/20 md:bg-transparent" onClick={onClose} />
      <div
        ref={ref}
        className="absolute inset-x-0 bottom-0 max-h-[70vh] animate-[drawer-up_.2s_ease-out] overflow-hidden rounded-t-2xl bg-white shadow-2xl md:inset-x-auto md:bottom-auto md:w-80 md:rounded-xl md:border md:border-slate-200"
        style={pos ? { left: pos.left, top: pos.top } : undefined}
      >
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <span className="text-sm text-slate-500">这一节次块还有 {items.length} 件事</span>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 rounded-md px-2 py-0.5 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <ul className="max-h-[55vh] overflow-y-auto py-1 md:max-h-72">
          {items.map((e) => (
            <li key={e.id}>
              <Row event={e} onClick={() => onPick(e.id)} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
