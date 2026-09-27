// 设置页「回收站」一栏：最近 30 天从日历上消失的事——你取消的、群里取消的、群里改期 / 改地点前的旧版本。
// 每行末尾一个恢复按钮：取消的 → 回到日历；改期的 → 时间地点改回原来的。30 天后自动不再显示。
import { useState } from 'react';
import { getTrash, restoreTrash } from '../api/client';
import type { TrashItemDTO } from '../api/types';
import { useToast } from './Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';
import { trashLine } from '../lib/trash';

export default function TrashSection() {
  const { data, error, loading, refresh } = usePolling(getTrash, 15_000);
  const toast = useToast();
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const list = data;

  async function onRestore(item: TrashItemDTO) {
    setRestoringId(item.id);
    try {
      await restoreTrash(item.id);
      toast(item.kind === 'cancelled' ? `「${item.event.title}」已恢复到日历` : '已恢复成原来的安排');
    } catch (e) {
      toastError(toast, e);
    } finally {
      // 失败多半是「已经不在回收站」（比如别的页面刚恢复过），同样刷新一下
      await refresh();
      setRestoringId(null);
    }
  }

  return (
    <>
      <h2 className="mt-10 text-lg font-semibold text-slate-900">回收站</h2>
      <p className="mt-1 text-sm text-slate-500">
        取消的事件、群里改期前的旧安排都在这里，点「恢复」就回到日历上。超过 30 天自动清除。
      </p>

      {error && !list && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error.message}
          <button type="button" onClick={() => void refresh()} className="ml-3 font-medium underline">
            重试
          </button>
        </div>
      )}

      {loading && <div className="mt-3 h-24 animate-pulse rounded-xl bg-slate-200/60" aria-busy />}

      {list && (
        <section className="mt-3 rounded-xl border border-slate-200 bg-white">
          {list.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-400">回收站是空的。</p>
          ) : (
            <ul className="divide-y divide-slate-50">
              {list.map((item) => {
                const line = trashLine(item);
                return (
                  <li key={item.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-slate-800">{line.title}</span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                            item.kind === 'cancelled' ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {line.badge}
                        </span>
                      </div>
                      {line.changes.length > 0 ? (
                        <div className="mt-1 text-xs text-slate-600">
                          {line.changes.map((c, i) => (
                            <span key={c.field}>
                              {i > 0 && '；'}
                              {c.label}：原 <span className="font-medium text-slate-800">{c.from}</span>
                              <span className="text-slate-400"> → 现 {c.to}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        line.meta && <div className="mt-1 text-xs text-slate-500">{line.meta}</div>
                      )}
                      {item.source_text && (
                        <div className="mt-1 truncate text-xs text-slate-400" title={item.source_text}>
                          「{item.source_text}」
                        </div>
                      )}
                      <div className="mt-1 text-[11px] text-slate-300">{line.expires}</div>
                    </div>
                    <button
                      type="button"
                      disabled={restoringId !== null}
                      onClick={() => void onRestore(item)}
                      className="shrink-0 self-center rounded-lg border border-emerald-200 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                    >
                      {restoringId === item.id ? '恢复中…' : line.action}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
