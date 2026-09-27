// 设置页 /settings：「课表」导入（FR-13，原 /timetable 页）+「长期记忆」开关与 AI 学到的偏好规则（FR-12，逐条删 / 清空）。
// 关闭记忆开关后规则不再进 AI 提示词，但手动调级仍会被记下。
// 「待办」：勾选待办时是否弹确认（对应待办弹窗里的「下次不再提醒」，存在本机）。
// 「回收站」：最近 30 天取消的事件、群里改期前的旧安排，逐条恢复（TrashSection）。
import { useCallback, useState } from 'react';
import { clearMemory, deleteMemoryRule, getMemory, setMemoryEnabled } from '../api/client';
import ConfirmDialog from '../components/ConfirmDialog';
import TimetableSection from '../components/TimetableSection';
import TrashSection from '../components/TrashSection';
import { useToast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';
import { LEVEL_LABEL, levelStyle } from '../lib/eventMeta';
import { SKIP_DONE_CONFIRM_KEY, readFlag, writeFlag } from '../lib/status';

export default function Settings() {
  const { data, error, loading, refresh } = usePolling(getMemory, 10_000);
  const toast = useToast();
  const [toggling, setToggling] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDone, setConfirmDone] = useState(() => readFlag(SKIP_DONE_CONFIRM_KEY) !== '1');

  function onToggleConfirmDone() {
    const next = !confirmDone;
    setConfirmDone(next);
    writeFlag(SKIP_DONE_CONFIRM_KEY, next ? '0' : '1');
    toast(next ? '勾选待办时会先确认' : '勾选待办后直接完成，不再确认');
  }

  const onToggle = useCallback(async () => {
    if (!data) return;
    const next = !data.enabled;
    setToggling(true);
    try {
      await setMemoryEnabled(next);
      await refresh();
      toast(next ? '长期记忆已开启' : '长期记忆已关闭，AI 定等级不再参考偏好（你的调整仍会记录）');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setToggling(false);
    }
  }, [data, refresh, toast]);

  async function onDeleteRule(id: number) {
    setDeletingId(id);
    try {
      await deleteMemoryRule(id);
      await refresh();
      toast('已删除这条规则');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setDeletingId(null);
    }
  }

  async function onClear() {
    setClearing(true);
    try {
      await clearMemory();
      await refresh();
      toast('已清空全部记忆');
      setConfirmClear(false);
    } catch (e) {
      toastError(toast, e);
    } finally {
      setClearing(false);
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">设置</h1>

      <div className="mt-6">
        <TimetableSection />
      </div>

      <h2 className="mt-10 text-lg font-semibold text-slate-900">待办</h2>
      <section className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">勾选待办时确认</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-500">
              开启后勾选待办会先问「是否确认完成」，防止误点。只对这台电脑的浏览器生效。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={confirmDone}
            aria-label="勾选待办时确认"
            onClick={onToggleConfirmDone}
            className="shrink-0"
          >
            <span
              className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${
                confirmDone ? 'bg-emerald-500' : 'bg-slate-300'
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                  confirmDone ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        </div>
      </section>

      <h2 className="mt-10 text-lg font-semibold text-slate-900">长期记忆</h2>
      <p className="mt-1 text-sm text-slate-500">你在日程详情里调整等级，AI 会记下来，以后定等级时参考。</p>

      {error && !data && (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error.message}
          <button type="button" onClick={() => void refresh()} className="ml-3 font-medium underline">
            重试
          </button>
        </div>
      )}

      {loading && (
        <div className="mt-3 space-y-3" aria-busy>
          <div className="h-24 animate-pulse rounded-xl bg-slate-200/60" />
          <div className="h-40 animate-pulse rounded-xl bg-slate-200/60" />
        </div>
      )}

      {data && (
        <>
          {/* 长期记忆开关 */}
          <section className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-800">开启长期记忆</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">
                  开启后 AI 定等级时会参考下面的偏好；关闭后不参考，但你的调整仍会被记下。
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={data.enabled}
                aria-label="长期记忆"
                disabled={toggling}
                onClick={() => void onToggle()}
                className="shrink-0 disabled:opacity-60"
              >
                <span
                  className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${
                    data.enabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      data.enabled ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </span>
              </button>
            </div>
          </section>

          {/* 规则列表 */}
          <section className="mt-4 rounded-xl border border-slate-200 bg-white">
            <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-800">学到的偏好</h3>
              <span className="text-xs text-slate-400">基于 {data.feedback_count} 次调整</span>
            </header>

            {data.rules.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">
                还没有学到偏好。在事件详情里调整几次等级，这里就会出现。
              </p>
            ) : (
              <ul className="divide-y divide-slate-50">
                {data.rules.map((r) => {
                  const lv = levelStyle('other', r.level);
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="min-w-0 flex-1 text-sm text-slate-800">{r.text}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${lv.bg} ${lv.text}`}>
                        {LEVEL_LABEL[r.level]}
                      </span>
                      <button
                        type="button"
                        disabled={deletingId === r.id}
                        onClick={() => void onDeleteRule(r.id)}
                        className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-60"
                      >
                        删除
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* 没总结出规则时也可能攒了调级记录，同样允许清空 */}
            {(data.rules.length > 0 || data.feedback_count > 0) && (
              <div className="border-t border-slate-100 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  className="rounded-lg border border-rose-200 px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-50"
                >
                  清空全部记忆
                </button>
              </div>
            )}
          </section>
        </>
      )}

      <TrashSection />

      <ConfirmDialog
        open={confirmClear}
        title="清空全部记忆？"
        confirmText="清空"
        danger
        focusCancel
        busy={clearing}
        onConfirm={() => void onClear()}
        onCancel={() => setConfirmClear(false)}
      >
        将删除所有学到的偏好规则与调级记录，无法恢复。
      </ConfirmDialog>
    </section>
  );
}
