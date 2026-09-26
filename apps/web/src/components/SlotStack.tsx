// 同一节次块的折叠卡片（FR-14）：组里只有 1 条就只渲染卡片；
// 多条时渲染「最急的一条」+ 右下角「…+N」按钮，点开 SlotPopover 看全部。
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { EventDTO } from '../api/types';
import type { SlotGroup } from '../lib/slots';
import SlotPopover from './SlotPopover';

interface Props {
  group: SlotGroup<EventDTO>;
  /** 渲染一张卡片（今日页 EventCard / 本周 Item / 网格小格） */
  render: (event: EventDTO) => ReactNode;
  /** 在弹出列表里点了某条 → 外层打开 EventDrawer */
  onPick: (id: number) => void;
}

export default function SlotStack({ group, render, onPick }: Props) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);

  const open = () => {
    // 打开时记录触发元素位置，浮层钉在旁边（宽屏）；手机看 className 走底部抽屉
    setAnchor(wrapRef.current?.getBoundingClientRect() ?? null);
  };

  const pick = (id: number) => {
    close();
    onPick(id);
  };

  if (group.items.length === 1) return <>{render(group.rep)}</>;

  return (
    <div ref={wrapRef} className="relative">
      {render(group.rep)}
      <button
        type="button"
        onClick={open}
        aria-label={`同一时段还有 ${group.items.length - 1} 件事，点开看全部`}
        className="absolute bottom-1.5 right-1.5 rounded-full bg-slate-900/75 px-2 py-0.5 text-xs font-medium text-white shadow-sm hover:bg-slate-900"
      >
        …+{group.items.length - 1}
      </button>
      {anchor !== null && <SlotPopover items={group.items} anchor={anchor} onPick={pick} onClose={close} />}
    </div>
  );
}
