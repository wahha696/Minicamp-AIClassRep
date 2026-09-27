// 群管理页 /groups（D6，FR-10 + FR-13）：群名、消息数、事件数、对应课程下拉、监听开关、删除本群数据。
import { useCallback, useState } from 'react';
import { deleteGroupData, getGroups, getTimetable, patchGroup } from '../api/client';
import type { GroupDTO } from '../api/types';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';
import {
  enabledIds,
  filterGroups,
  groupsToChange,
  loadPresets,
  matchesPreset,
  presetChanges,
  reverseChanges,
  runInBatches,
  savePresets,
  toChanges,
  upsertPreset,
  type GroupChange,
  type GroupPreset,
} from '../lib/groups';

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
  // 正在批量改：'on' 全开 / 'off' 全关 / 'undo' 撤销 / 'preset:名字' 套用预设
  const [busy, setBusy] = useState<string | null>(null);
  // 最近一次批量操作（一键全开/全关、套用预设），用来「撤销」；单独拨一个开关后就不能再撤销了
  const [lastBulk, setLastBulk] = useState<GroupChange[] | null>(null);
  const [presets, setPresets] = useState<GroupPreset[]>(loadPresets);
  const [presetName, setPresetName] = useState<string | null>(null); // 非 null = 正在输入新预设的名字
  // 课表里的课程名去重（保持课表里的顺序）；没导入课表就不显示下拉
  const courseNames = [...new Set((timetable.data?.courses ?? []).map((c) => c.name))];

  function updatePresets(next: GroupPreset[]) {
    setPresets(next);
    savePresets(next);
  }

  /** 批量改开关（每批 8 个并发）。undoable：成功后可以撤销回去 */
  async function applyChanges(changes: GroupChange[], busyKey: string, doneText: string, undoable: boolean) {
    setBusy(busyKey);
    setPending((p) => ({ ...p, ...Object.fromEntries(changes.map((c) => [c.group.group_id, c.enabled])) }));
    try {
      const failed = await runInBatches(changes, 8, (c) => patchGroup(c.group.group_id, { enabled: c.enabled }));
      await refresh();
      const ok = changes.length - failed;
      if (failed > 0) {
        toast(`${ok} 个成功，${failed} 个失败（在手机上操作会失败，请在电脑上操作）`, 'error');
        setLastBulk(null);
      } else if (undoable) {
        setLastBulk(changes);
        toast(doneText, 'info', { label: '撤销', onClick: () => void undo(changes) });
      } else {
        setLastBulk(null);
        toast(doneText);
      }
    } finally {
      setPending((p) => {
        const next = { ...p };
        for (const c of changes) delete next[c.group.group_id];
        return next;
      });
      setBusy(null);
    }
  }

  function undo(changes: GroupChange[]) {
    return applyChanges(reverseChanges(changes), 'undo', '已撤销，恢复到之前的选择', false);
  }

  /** 一键全开 / 全关：只作用于当前列表里显示的群（搜索时就是搜索结果） */
  async function onBulk(enabled: boolean) {
    if (!shown) return;
    const targets = groupsToChange(shown, enabled);
    if (targets.length === 0) {
      toast(enabled ? '已经全部开启了' : '已经全部关闭了');
      return;
    }
    await applyChanges(
      toChanges(targets, enabled),
      enabled ? 'on' : 'off',
      enabled ? `已开启 ${targets.length} 个群的监听` : `已关闭 ${targets.length} 个群的监听`,
      true,
    );
  }

  /** 套用预设：作用于全部群（不管搜索框），预设里的开、其他的关 */
  async function onApplyPreset(p: GroupPreset) {
    if (!data) return;
    const changes = presetChanges(data, p);
    if (changes.length === 0) {
      toast(`现在就是「${p.name}」`);
      return;
    }
    const on = data.filter((g) => p.ids.includes(g.group_id)).length;
    await applyChanges(changes, `preset:${p.name}`, `已切换到「${p.name}」：监听 ${on} 个群`, true);
  }

  function onSavePreset() {
    if (!data || presetName === null) return;
    const name = presetName.trim();
    if (!name) {
      toast('给预设起个名字吧', 'error');
      return;
    }
    const ids = enabledIds(data);
    if (ids.length === 0) {
      toast('现在一个群都没开，先打开要监听的群再保存', 'error');
      return;
    }
    const exists = presets.some((p) => p.name === name);
    updatePresets(upsertPreset(presets, { name, ids }));
    setPresetName(null);
    toast(exists ? `已更新预设「${name}」（${ids.length} 个群）` : `已保存预设「${name}」（${ids.length} 个群）`);
  }

  function onDeletePreset(p: GroupPreset) {
    const before = presets;
    updatePresets(presets.filter((x) => x !== p));
    toast(`已删除预设「${p.name}」`, 'info', { label: '撤销', onClick: () => updatePresets(before) });
  }

  async function onToggle(g: GroupDTO, enabled: boolean) {
    setLastBulk(null);
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
        <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
          <div className="min-w-0 flex-1">
            <div className="relative">
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

            {shown && shown.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-slate-500">
                  {query.trim() ? `找到 ${shown.length} 个群` : `共 ${shown.length} 个群`}，监听中{' '}
                  {shown.filter((g) => pending[g.group_id] ?? g.enabled).length} 个
                </span>
                <div className="flex flex-wrap gap-2">
                  {lastBulk && (
                    <button
                      type="button"
                      onClick={() => void undo(lastBulk)}
                      disabled={busy !== null}
                      title="恢复到刚才那次批量操作之前的选择"
                      className="rounded-lg border border-amber-200 px-3 py-1.5 text-amber-700 hover:bg-amber-50 disabled:opacity-60"
                    >
                      {busy === 'undo' ? '撤销中…' : '↶ 撤销刚才的操作'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void onBulk(true)}
                    disabled={busy !== null}
                    className="rounded-lg border border-emerald-200 px-3 py-1.5 text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                  >
                    {busy === 'on' ? '开启中…' : query.trim() ? '全部开启（搜索结果）' : '一键全部开启'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onBulk(false)}
                    disabled={busy !== null}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {busy === 'off' ? '关闭中…' : query.trim() ? '全部关闭（搜索结果）' : '一键全部关闭'}
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
                          {/* 重新导入课表后旧课名没了：照实显示，别让下拉框假装成「自动」 */}
                          {g.course_name && !courseNames.includes(g.course_name) && (
                            <option value={g.course_name}>{g.course_name}（课表中已不存在）</option>
                          )}
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
          </div>

          {/* 右侧边栏：预设（手机上排在列表上面） */}
          <aside className="order-first rounded-xl border border-slate-200 bg-white p-4 lg:sticky lg:top-20 lg:order-last lg:w-64 lg:shrink-0">
            <h2 className="font-semibold text-slate-900">预设</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              选好要监听的群后存成预设；误点一键全开 / 全关，点一下预设就能恢复
            </p>

            {presets.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {presets.map((p) => {
                  const active = matchesPreset(data, p);
                  const count = data.filter((g) => p.ids.includes(g.group_id)).length;
                  return (
                    <li
                      key={p.name}
                      className={`flex items-center overflow-hidden rounded-lg border text-sm ${
                        active ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-700'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void onApplyPreset(p)}
                        disabled={busy !== null}
                        title={active ? '当前就是这个预设' : `只监听这 ${count} 个群，其他群全部关闭`}
                        className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-60"
                      >
                        <span className="w-3 shrink-0">{active && '✓'}</span>
                        <span className="truncate">{busy === `preset:${p.name}` ? '切换中…' : p.name}</span>
                        <span className="ml-auto shrink-0 text-xs opacity-60">{count} 个群</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeletePreset(p)}
                        aria-label={`删除预设「${p.name}」`}
                        title="删除预设（不会改动群的开关）"
                        className="px-2.5 py-2 text-slate-400 hover:text-rose-600"
                      >
                        ×
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {presetName === null ? (
              <button
                type="button"
                onClick={() => setPresetName(`预设 ${presets.length + 1}`)}
                className="mt-3 w-full rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600"
              >
                ＋ 把当前选择存为预设
              </button>
            ) : (
              <form
                className="mt-3 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  onSavePreset();
                }}
              >
                <input
                  autoFocus
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => e.key === 'Escape' && setPresetName(null)}
                  maxLength={20}
                  aria-label="预设名字"
                  placeholder="如「重要的群」"
                  className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
                <div className="flex gap-2 text-sm">
                  <button type="submit" className="flex-1 rounded-lg bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700">
                    保存（{enabledIds(data).length} 个群）
                  </button>
                  <button type="button" onClick={() => setPresetName(null)} className="px-2 text-slate-500 hover:text-slate-700">
                    取消
                  </button>
                </div>
              </form>
            )}
          </aside>
        </div>
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
