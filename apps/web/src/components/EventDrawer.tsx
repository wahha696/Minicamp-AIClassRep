// 事件详情抽屉（D4，FR-8）：电脑右侧滑出，手机底部全屏。
// 内容：基本信息、置信度、「查看来源」（原文高亮）、「变更记录」、完成/取消/恢复、导出这一条。
import { useEffect, useState, type ReactNode } from 'react';
import { eventIcsUrl, getEvent, patchEvent } from '../api/client';
import type { EventDetailDTO, EventStatus } from '../api/types';
import { highlightSegments, historyLines } from '../lib/detail';
import { toastError } from '../lib/errors';
import { STATUS_TEXT, typeMeta } from '../lib/eventMeta';
import { formatWhen } from '../lib/time';
import { useToast } from './Toast';

interface Props {
  id: number | null; // null = 关闭
  onClose: () => void;
  onChanged?: () => void; // 状态改了，让列表页刷新
}

export default function EventDrawer({ id, onClose, onChanged }: Props) {
  if (id === null) return null;
  // key：换一条事件时整个抽屉重置（折叠状态、数据）
  return <Drawer key={id} id={id} onClose={onClose} onChanged={onChanged} />;
}

function Drawer({ id, onClose, onChanged }: { id: number } & Omit<Props, 'id'>) {
  const toast = useToast();
  const [detail, setDetail] = useState<EventDetailDTO>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showSources, setShowSources] = useState(false);

  useEffect(() => {
    let alive = true;
    getEvent(id).then(
      (d) => alive && setDetail(d),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : '读取失败'),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  // Esc 关闭；打开期间背景不滚动
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  async function setStatus(status: EventStatus, doneText: string) {
    if (!detail) return;
    setBusy(true);
    try {
      const e = await patchEvent(detail.id, status);
      setDetail({ ...detail, ...e });
      toast(doneText);
      onChanged?.();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="事件详情">
      <div className="absolute inset-0 animate-[fade-in_.2s_ease-out] bg-slate-900/40" onClick={onClose} />
      <aside className="absolute inset-0 flex animate-[drawer-up_.25s_ease-out] flex-col bg-white shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:w-[28rem] md:animate-[drawer-left_.25s_ease-out]">
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <span className="text-sm text-slate-500">事件详情</span>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 rounded-md px-2 py-1 text-xl leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
          {!detail && !error && (
            <div className="space-y-3" aria-busy>
              <div className="h-7 w-2/3 animate-pulse rounded bg-slate-200" />
              <div className="h-24 animate-pulse rounded bg-slate-100" />
            </div>
          )}
          {detail && <Body detail={detail} showSources={showSources} onToggleSources={() => setShowSources((v) => !v)} />}
        </div>

        {detail && (
          <footer className="flex flex-wrap gap-2 border-t border-slate-200 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {detail.status === 'done' || detail.status === 'cancelled' ? (
              <Btn onClick={() => setStatus('active', '已恢复')} disabled={busy} primary>
                恢复
              </Btn>
            ) : (
              <>
                <Btn onClick={() => setStatus('done', '已标记完成')} disabled={busy} primary>
                  标记完成
                </Btn>
                <Btn onClick={() => setStatus('cancelled', '已标记取消')} disabled={busy}>
                  标记取消
                </Btn>
              </>
            )}
            <a
              href={eventIcsUrl(detail.id)}
              download
              className="ml-auto rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              导出这一条
            </a>
          </footer>
        )}
      </aside>
    </div>
  );
}

function Btn({ children, primary, ...rest }: { children: ReactNode; primary?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60 ${
        primary ? 'bg-slate-900 text-white hover:bg-slate-700' : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-sm">
      <dt className="w-16 shrink-0 text-slate-400">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-slate-800">{children}</dd>
    </div>
  );
}

const STATUS_STYLE: Record<EventStatus, string> = {
  active: 'bg-emerald-50 text-emerald-700',
  pending_confirm: 'bg-amber-50 text-amber-700',
  done: 'bg-slate-100 text-slate-500',
  cancelled: 'bg-slate-100 text-slate-500 line-through',
};

function Body({
  detail,
  showSources,
  onToggleSources,
}: {
  detail: EventDetailDTO;
  showSources: boolean;
  onToggleSources: () => void;
}) {
  const meta = typeMeta(detail.type);
  const pct = Math.round(Math.min(1, Math.max(0, detail.confidence)) * 100);
  const lines = historyLines(detail.history);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded px-1.5 py-0.5 text-xs font-medium" style={{ color: meta.color, backgroundColor: `${meta.color}1a` }}>
          {meta.label}
        </span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[detail.status]}`}>{STATUS_TEXT[detail.status]}</span>
        {detail.history.length > 0 && (
          <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">已按最新通知更新</span>
        )}
      </div>
      <h2 className="mt-2 text-xl font-bold leading-snug text-slate-900">{detail.title}</h2>
      {detail.description && <p className="mt-1 text-sm text-slate-500">{detail.description}</p>}

      <dl className="mt-4 divide-y divide-slate-100">
        {detail.start_at !== null && <Row label="开始">{formatWhen(detail.start_at)}</Row>}
        {detail.end_at !== null && <Row label="结束">{formatWhen(detail.end_at)}</Row>}
        {detail.deadline_at !== null && (
          <Row label="截止">
            <span className="font-medium text-red-600">{formatWhen(detail.deadline_at)}</span>
          </Row>
        )}
        {detail.start_at === null && detail.deadline_at === null && <Row label="时间">待定</Row>}
        {detail.location && <Row label="地点">{detail.location}</Row>}
        {detail.action_required && <Row label="要求">{detail.action_required}</Row>}
        <Row label="来源群">{detail.group_name}</Row>
        <Row label="置信度">
          <div className="flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-400' : 'bg-rose-400'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-10 text-right tabular-nums text-slate-600">{pct}%</span>
          </div>
        </Row>
      </dl>

      <section className="mt-5">
        <button
          type="button"
          onClick={onToggleSources}
          aria-expanded={showSources}
          className="flex w-full items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          <span>查看来源（{detail.sources.length} 条群消息）</span>
          <span className={`transition-transform ${showSources ? 'rotate-90' : ''}`} aria-hidden>
            ›
          </span>
        </button>
        {showSources && (
          <ul className="mt-2 space-y-2">
            {detail.sources.length === 0 && <li className="px-3 text-sm text-slate-400">没有记录来源消息</li>}
            {detail.sources.map((s) => (
              <li key={s.message_id} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex justify-between gap-2 text-xs text-slate-400">
                  <span className="truncate font-medium text-slate-600">{s.sender_name}</span>
                  <span className="shrink-0">{formatWhen(s.sent_at)}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">
                  {highlightSegments(s.text).map((seg, i) =>
                    seg.hit ? (
                      <mark key={i} className="rounded bg-yellow-200 px-0.5 text-slate-900">
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {lines.length > 0 && (
        <section className="mt-5">
          <h3 className="text-sm font-medium text-slate-700">变更记录</h3>
          <ol className="mt-2 space-y-2 border-l-2 border-slate-200 pl-3">
            {lines.map((l) => (
              <li key={l.version} className="text-sm">
                <div className="text-xs text-slate-400">
                  {l.version} 版 · {l.when}
                </div>
                <div className="mt-0.5 text-slate-700">
                  {l.changes.map((c, i) => (
                    <span key={c.field}>
                      {i > 0 && '；'}
                      {c.label}：<del className="text-slate-400">{c.from}</del> → <span className="font-medium">{c.to}</span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
