// 群管理页 /groups（D6，FR-10 + FR-13）：群名、消息数、事件数、对应课程下拉、监听开关、删除本群数据。
import { useCallback, useState } from 'react';
import { deleteGroupData, getGroups, getTimetable, patchGroup } from '../api/client';
import type { GroupDTO } from '../api/types';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';
import { filterGroups, groupsToChange, runInBatches } from '../lib/groups';

export default function Groups() {
  const { data, error, loading, refresh } = usePolling(getGroups, 10_000);
  const timetable = usePolling(getTimetable, 60_000);
  const toast = useToast();
  // 开关刚点下、后端还没返回时先按用户的选择显示（乐观更新）；失败就撤回
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [toDelete, setToDelete] = useState<GroupDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const shown = data ? filterGroups(data, query) : null;
  const [bulk, setBulk] = useState<boolean | null>(null); // 正在一键全开(true) / 全关(false)
  // 课表里的课程名去重（保持课表里的顺序）；没导入课表就不显示下拉
  const courseNames = [...new Set((timetable.data?.courses ?? []).map((c) => c.name))];

  /** 一键全开 / 全关：只作用于当前列表里显示的群（搜索时就是搜索结果） */
  async function onBulk(enabled: boolean) {
    if (!shown) return;
    const targets = groupsToChange(shown, enabled);
    if (targets.length === 0) {
      toast(enabled ? '已经全部开启了' : '已经全部关闭了');
      return;
    }
    setBulk(enabled);
    setPending((p) => ({ ...p, ...Object.fromEntries(targets.map((g) => [g.group_id, enabled])) }));
    try {
      const failed = await runInBatches(targets, 8, (g) => patchGroup(g.group_id, { enabled }));
      await refresh();
      const ok = targets.length - failed;
      if (failed === 0) toast(enabled ? `已开启 ${ok} 个群的监听` : `已关闭 ${ok} 个群的监听`);
      else toast(`${ok} 个成功，${failed} 个失败（在手机上操作会失败，请在电脑上操作）`, 'error');
    } finally {
      setPending((p) => {
        const next = { ...p };
        for (const g of targets) delete next[g.group_id];
        return next;
      });
      setBulk(null);
    }
  }

  async function onToggle(g: GroupDTO, enabled: boolean) {
    setPending((p) => ({ ...p, [g.group_id]: enabled }));
    try {
      await patchGroup(g.group_id, { enabled });
      await refresh();
      toast(enabled ? `已开启「${g.name}」的监听` : `已关闭「${g.name}」的监听，新消息不再生成日程`);
    } catch (e) {
      toastError(toast, e);
    } finally {
      setPending(({ [g.group_id]: _, ...rest }) => rest);
    }
  }

  /** 群↔课程绑定（FR-13）：选「自动」清掉 course_name，让 AI 按群名猜 */
  async function onCourseChange(g: GroupDTO, courseName: string) {
    try {
      await patchGroup(g.group_id, { course_name: courseName === '' ? null : courseName });
      await refresh();
      toast(courseName === '' ? `「${g.name}」回到 AI 判断` : `「${g.name}」对应课程改为「${courseName}」`);
    } catch (e) {
      toastError(toast, e);
    }
  }

  async function onDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await deleteGroupData(toDelete.group_id);
      await refresh();
      toast(`已删除「${toDelete.name}」的数据`);
      setToDelete(null);
    } catch (e) {
      toastError(toast, e);
    } finally {
      setDeleting(false);
    }
  }

  const cancelDelete = useCallback(() => setToDelete(null), []);

  return (
    <section>
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">群管理</h1>
      <p className="mt-2 flex items-start gap-1.5 text-sm text-slate-500">
        <span aria-hidden>🔒</span>
        数据只保存在你的电脑上，原始消息 7 天后自动清理
      </p>

      {error && !data && (
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error.message}
          <button type="button" onClick={() => void refresh()} className="ml-3 font-medium underline">
            重试
          </button>
        </div>
      )}

      {loading && (
        <div className="mt-6 space-y-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
          ))}
        </div>
      )}

      {data && data.length === 0 && (
        <div className="mt-10 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-slate-500">
          还没有接入任何群。连上 QQ 后，收到消息的群会自动出现在这里。
        </div>
      )}

      {data && data.length > 0 && (
        <div className="relative mt-6">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索群名或群号，打几个字就行，如「高数班」"
            aria-label="搜索群"
            className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
      )}

      {shown && shown.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-slate-500">
            {query.trim() ? `找到 ${shown.length} 个群` : `共 ${shown.length} 个群`}，监听中{' '}
            {shown.filter((g) => pending[g.group_id] ?? g.enabled).length} 个
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void onBulk(true)}
              disabled={bulk !== null}
              className="rounded-lg border border-emerald-200 px-3 py-1.5 text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
            >
              {bulk === true ? '开启中…' : query.trim() ? '全部开启（搜索结果）' : '一键全部开启'}
            </button>
            <button
              type="button"
              onClick={() => void onBulk(false)}
              disabled={bulk !== null}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-60"
            >
              {bulk === false ? '关闭中…' : query.trim() ? '全部关闭（搜索结果）' : '一键全部关闭'}
            </button>
          </div>
        </div>
      )}

      {shown && data!.length > 0 && shown.length === 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-500">
          没有找到和「{query.trim()}」相关的群
        </div>
      )}

      {shown && shown.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {shown.map((g) => {
            const enabled = pending[g.group_id] ?? g.enabled;
            const empty = g.message_count === 0 && g.event_count === 0;
            return (
              <li key={g.group_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className={`truncate font-medium ${enabled ? 'text-slate-900' : 'text-slate-400'}`} title={g.name}>
                    {g.name}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-400">
                    {g.message_count} 条消息 · {g.event_count} 个日程
                    {!enabled && ' · 已关闭监听'}
                  </div>
                </div>

                {courseNames.length > 0 && (
                  <select
                    aria-label={`「${g.name}」对应课程`}
                    value={g.course_name ?? ''}
                    onChange={(e) => void onCourseChange(g, e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="">自动（AI 判断）</option>
                    {courseNames.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                )}

                <Switch
                  checked={enabled}
                  disabled={g.group_id in pending}
                  label={`监听「${g.name}」`}
                  onChange={(v) => void onToggle(g, v)}
                />

                <button
                  type="button"
                  onClick={() => setToDelete(g)}
                  disabled={empty}
                  className="rounded-lg border border-rose-200 px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-50 disabled:border-slate-200 disabled:text-slate-300 disabled:hover:bg-transparent"
                >
                  删除本群数据
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={`删除「${toDelete?.name ?? ''}」的数据？`}
        confirmText="删除"
        danger
        busy={deleting}
        onConfirm={() => void onDelete()}
        onCancel={cancelDelete}
      >
        将删除该群的所有消息和日程，无法恢复
      </ConfirmDialog>
    </section>
  );
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-sm text-slate-500 disabled:opacity-60"
    >
      <span className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`}>
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </span>
      <span className="w-8 text-left">{checked ? '监听' : '关闭'}</span>
    </button>
  );
}
