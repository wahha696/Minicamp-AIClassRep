// 顶栏「刷新」按钮（FR-16）：点开菜单选 1 / 7 / 30 天，往前补拉群历史消息。
// 补拉后轮询 health.pending：按钮旁显示本次补回的消息还剩几条没整理（「整理中 N」），归零时 Toast「整理完了」；
// 超时 / 没配 AI / 连续读不到 health 时停止跟踪（判定见 lib/syncTrack.ts）。
// QQ 不在线禁用；局域网只读访问（写接口 403）整颗按钮不渲染。
import { useEffect, useRef, useState } from 'react';
import { getHealth, syncNow } from '../api/client';
import { toastError } from '../lib/errors';
import { type SyncTrack, trackStep } from '../lib/syncTrack';
import { useConnectStatus } from './ConnectStatus';
import { useToast } from './Toast';

const OPTIONS: { days: 1 | 7 | 30; label: string; hint?: string }[] = [
  { days: 1, label: '补回最近 1 天' },
  { days: 7, label: '补回最近 7 天' },
  { days: 30, label: '补回最近 30 天', hint: '消息多时会消耗较多 AI 额度' },
];

/** 从非本机地址打开页面时，后端会拒所有写接口（403 只读）——干脆不显示按钮 */
const isLanReadonly = () => {
  const h = window.location.hostname;
  return h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]' && h !== '0.0.0.0';
};

export default function SyncButton() {
  const { data: conn } = useConnectStatus();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0); // 本次补回的消息还没整理完的条数
  const [track, setTrack] = useState<Omit<SyncTrack, 'fails'> | null>(null);
  const tracking = track !== null;
  const rootRef = useRef<HTMLDivElement>(null);

  const online = conn?.state === 'online';

  // 点外面/按 Esc 关菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 补拉后轮询 pending 直到本次补回的归零（或超时 / 没配 AI / 读不到 health）
  useEffect(() => {
    if (!track) return;
    let alive = true;
    let fails = 0;
    const poll = () => {
      getHealth()
        .then((h) => h, () => null)
        .then((h) => {
          if (!alive) return;
          fails = h === null ? fails + 1 : 0;
          const step = trackStep({ ...track, fails }, h, Date.now());
          if (step.kind === 'progress') {
            if (step.left >= 0) setPending(step.left);
            return;
          }
          setTrack(null);
          setPending(0);
          toast(step.kind === 'done' ? '整理完了' : step.message);
        });
    };
    const timer = setInterval(poll, 3_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [track, toast]);

  async function onPick(days: 1 | 7 | 30) {
    setOpen(false);
    setBusy(true);
    try {
      // 补拉前的 pending 作基线：群里本来就在排队的消息不算进「整理中」
      const base = await getHealth().then((h) => h.pending, () => 0);
      const res = await syncNow(days);
      if (res.messages === 0) {
        toast('没有漏掉的消息');
        return;
      }
      toast(`补回 ${res.messages} 条消息，正在整理…`);
      setPending(res.messages);
      setTrack({ total: res.messages, base, startedAt: Date.now() });
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  if (isLanReadonly()) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="补拉历史消息"
        aria-expanded={open}
        disabled={!online || busy}
        title={online ? '补拉群历史消息' : '先连上 QQ'}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg
          viewBox="0 0 24 24"
          className={`h-4 w-4 ${busy || (tracking && pending > 0) ? 'animate-spin' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
        </svg>
        <span className="hidden sm:inline">刷新</span>
        {tracking && pending > 0 && (
          <span className="rounded-full bg-blue-100 px-1.5 text-[11px] font-medium text-blue-700">
            整理中 {pending}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-52 rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          <p className="px-3 pb-1 pt-2 text-xs text-slate-400">往前补拉群历史消息</p>
          {OPTIONS.map((o) => (
            <button
              key={o.days}
              type="button"
              onClick={() => void onPick(o.days)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              <span>{o.label}</span>
              {o.hint && <span className="max-w-24 text-right text-[11px] leading-tight text-slate-400">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
