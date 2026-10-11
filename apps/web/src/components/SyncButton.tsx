// 顶栏「补拉历史」按钮（FR-16）：点开菜单选 1 / 7 / 30 天，同时补拉 QQ 与微信中已开启监听的群。
// 补拉后轮询 health.pending：按钮旁显示所有启用群的待整理总数；
// 超时 / 没配 AI / 连续读不到 health 时停止跟踪（判定见 lib/syncTrack.ts）。
// QQ 不在线且微信未在采集时禁用；局域网只读访问（写接口 403）整颗按钮不渲染。
import { useEffect, useRef, useState } from 'react';
import { getHealth } from '../api/client';
import { errorText, toastError } from '../lib/errors';
import { syncAllHistory, type HistorySyncProgress } from '../lib/historySync';
import { type SyncTrack, trackStep } from '../lib/syncTrack';
import { useConnectStatus } from './ConnectStatus';
import { useToast } from './Toast';

const OPTIONS: { days: 1 | 7 | 30; label: string; hint?: string }[] = [
  { days: 1, label: '补回最近 1 天' },
  { days: 7, label: '补回最近 7 天' },
  { days: 30, label: '补回最近 30 天', hint: '消息多时会消耗较多 AI 额度' },
];

interface PullProgress {
  qq: boolean;
  qqDone: boolean;
  wechat: boolean;
  wechatTotal: number | null;
  wechatDone: number;
  wechatSkipped: number;
  page: number;
  group: string | null;
  messages: number;
}

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
  const [stopping, setStopping] = useState(false);
  const stopRequested = useRef(false);
  const [pull, setPull] = useState<PullProgress | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [pending, setPending] = useState(0); // 所有启用群的待整理总数，实时新消息可使其增加
  const [track, setTrack] = useState<Omit<SyncTrack, 'fails'> | null>(null);
  const tracking = track !== null;
  const rootRef = useRef<HTMLDivElement>(null);

  const qqOnline = conn?.state === 'online';
  const wechatOnline = conn?.wechat === 'collecting';
  const online = qqOnline || wechatOnline;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

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
          toast(step.kind === 'done' ? '已启用群当前没有待整理的消息' : step.message);
        });
    };
    const timer = setInterval(poll, 3_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [track, toast]);

  async function onPick(days: 1 | 7 | 30) {
    if (!conn || busy) return;
    stopRequested.current = false;
    setStopping(false);
    setOpen(false);
    setOutcome(null);
    setBusy(true);
    setPull({ qq: qqOnline, qqDone: !qqOnline, wechat: wechatOnline, wechatTotal: wechatOnline ? null : 0,
      wechatDone: 0, wechatSkipped: 0, page: 0, group: null, messages: 0 });
    try {
      const res = await syncAllHistory(days, {
        epoch: conn.account_epoch, qq: qqOnline, wechat: wechatOnline, alive: () => mounted.current && !stopRequested.current,
        onProgress: (progress: HistorySyncProgress) => {
          if (!mounted.current) return;
          setPull((previous) => {
            if (!previous) return previous;
            if (progress.kind === 'qq_done') return { ...previous, qqDone: true };
            if (progress.kind === 'wechat_start') return { ...previous, wechatTotal: progress.total };
            if (progress.kind === 'wechat_request') return { ...previous, page: progress.page, group: progress.group_id };
            if (progress.kind === 'wechat_page') return { ...previous, page: progress.page, messages: progress.messages };
            return { ...previous, wechatDone: progress.completed,
              wechatSkipped: previous.wechatSkipped + (progress.skipped ? 1 : 0), page: 0, group: null, messages: progress.messages };
          });
        },
      });
      if (!mounted.current) return;
      const failures = (res.qq?.failures ?? 0) + (res.wechat?.failed ? 1 : 0);
      const skipped = res.wechat?.skipped ?? [];
      if (res.cancelled) setOutcome('已停止后续补拉；已读取的消息保留，尚未完成的群可再次补拉。');
      if (res.errors.length || failures || skipped.length) {
        const parts = [
          ...(res.qq ? [`${res.qq.failures} 个 QQ 群未补全`] : []),
          ...(res.wechat ? [`${skipped.length} 个微信群跳过`] : []),
          ...res.errors.map(({ platform, error }) => `${platform}补拉失败：${errorText(error)}`),
        ];
        setOutcome(`补拉结束：${parts.join('，')}。请检查群状态后重试。`);
      }
      if (res.errors.length > 0) toastError(toast, res.errors[0].error);
      else if (failures > 0) toast(`有 ${failures} 个群可能没补全，建议稍后再补拉一次`);
      if (skipped.length > 0) {
        const notSynced = skipped.every((s) => s.reason === 'WECHAT_MESSAGE_SELECTED_GROUP_NOT_FOUND');
        toast(`微信有 ${skipped.length} 个群读取失败，已跳过${notSynced ? '（电脑上还没有这些群的记录）' : ''}，其余群继续补拉`, 'error');
      }
      const messages = (res.qq?.messages ?? 0) + (res.wechat?.messages ?? 0);
      if (messages === 0) {
        if (!res.cancelled && failures === 0 && skipped.length === 0 && res.errors.length === 0) toast('本次范围内没有新增消息');
        return;
      }
      toast(`补回 ${messages} 条消息，正在整理…`);
      setPending(0);
      setTrack({ total: messages, base: 0, startedAt: Date.now() });
    } catch (e) {
      if (mounted.current) { setOutcome('补拉中断，请检查连接后重试。'); toastError(toast, e); }
    } finally {
      if (mounted.current) { setBusy(false); setPull(null); setStopping(false); }
    }
  }

  if (isLanReadonly()) return null;

  const progressText = pull && [
    pull.qq ? `QQ ${pull.qqDone ? '已结束' : '补拉中，暂无法估算剩余时间'}` : null,
    pull.wechat ? pull.wechatTotal === null ? '微信准备中'
      : `微信已尝试 ${pull.wechatDone}/${pull.wechatTotal} 群${pull.wechatSkipped ? `，跳过 ${pull.wechatSkipped} 群` : ''}${pull.page ? `，当前第 ${pull.page} 页` : ''}` : null,
    pull.messages > 0 ? `微信已读取 ${pull.messages} 条` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="补拉历史消息"
        aria-expanded={open}
        disabled={!online || busy}
        title={online ? '补拉已开启监听的群的历史消息' : '先连上 QQ 或开启微信群监听'}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1.5 rounded-md px-1.5 text-xs text-slate-500 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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
        <span className="hidden sm:inline">{busy ? '补拉中…' : '补拉历史'}</span>
        {tracking && pending > 0 && (
          <span title="所有已启用群的待整理消息；有新消息进入时会增加"
            className="rounded-full bg-blue-100 px-1.5 text-[11px] font-medium text-blue-700">
            全局待整理 {pending}
          </span>
        )}
      </button>

      {busy && pull && (
        <div role="status" className="fixed inset-x-3 top-16 z-40 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-lg sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-1 sm:w-72">
          <div className="mb-1.5" aria-live="polite">{progressText}</div>
          {pull.group && <p className="mb-1.5 break-all">正在读取群 {pull.group} 的第 {pull.page} 页…</p>}
          {stopping ? <p className="mb-1.5">正在等待当前请求结束，随后停止后续微信补拉；已发起的 QQ 补拉仍会完成。</p>
            : pull.wechat && <button type="button" className="mb-1.5 underline" onClick={() => {
              stopRequested.current = true; setStopping(true);
            }}>停止后续补拉</button>}
          {pull.wechat && <div role="progressbar" aria-label="微信历史读取进度" aria-valuemin={0}
            aria-valuemax={pull.wechatTotal ?? undefined} aria-valuenow={pull.wechatTotal === null ? undefined : pull.wechatDone}
            aria-valuetext={pull.wechatTotal === null ? '微信准备中' : `已尝试 ${pull.wechatDone}/${pull.wechatTotal} 群，跳过 ${pull.wechatSkipped} 群`}
            className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full bg-emerald-500 transition-[width] duration-300 ${pull.wechatTotal === null ? 'animate-pulse' : ''}`}
              style={{ width: pull.wechatTotal === null ? '35%' : `${pull.wechatTotal === 0 ? 100 : pull.wechatDone / pull.wechatTotal * 100}%` }} />
          </div>}
          {pull.qq && !pull.qqDone && <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100" aria-label="QQ 正在补拉">
            <div className="h-full w-1/3 animate-pulse bg-sky-500" />
          </div>}
        </div>
      )}

      {outcome && !busy && <div role="alert" className="fixed inset-x-3 top-16 z-40 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-lg sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-1 sm:w-72">
        <span>{outcome}</span>
        <button type="button" aria-label="关闭补拉结果" title="关闭" onClick={() => setOutcome(null)} className="ml-2 float-right text-base leading-none">×</button>
      </div>}

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-60 rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          <p className="px-3 pb-1 pt-2 text-xs text-slate-400">
            只补拉已开启监听的 QQ 群和微信群；微信只能补回已同步到电脑的记录。待整理数字为全部启用群的积压。
          </p>
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
