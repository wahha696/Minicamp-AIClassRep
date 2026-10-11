// 群管理页 /groups（D6，FR-10 + FR-13）：群名、消息数、事件数、对应课程下拉、监听开关、删除本群数据。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import WechatPanel from '../components/WechatPanel';
import { useConnectStatus } from '../components/ConnectStatus';
import { deleteGroupData, getGroups, getHealth, getTimetable, patchGroup, retryGroup } from '../api/client';
import type { GroupDTO } from '../api/types';
import type { WechatCatalogDTO } from '../../../../shared/wechat';
import { getWechatIntake } from '../api/client';
import { changeWechatListening } from '../lib/wechat-listening';
import ConfirmDialog from '../components/ConfirmDialog';
import GroupFailureNotice from '../components/GroupFailureNotice';
import SyncStatus from '../components/SyncStatus';
import ReadStatus from '../components/ReadStatus';
import { useToast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';
import { accountKey } from '../lib/account';
import {
  enabledIds,
  filterGroups,
  groupsToChange,
  keepOrder,
  loadPresets,
  matchesPreset,
  presetChanges,
  reverseChanges,
  runInBatches,
  savePresets,
  sortEnabledFirst,
  toChanges,
  upsertPreset,
  wechatBusinessGroupId,
  type GroupChange,
  type GroupPreset,
} from '../lib/groups';

export default function Groups() {
  const [params, setParams] = useSearchParams();
  const platform = params.get('platform') === 'wechat' ? 'wechat' : params.get('platform') === 'other' ? 'other' : 'qq';
  const { data: connection, refresh } = useConnectStatus();
  const workspace = connection?.workspace;
  const [installationId, setInstallationId] = useState<string>();
  const [installationChecked, setInstallationChecked] = useState(false);
  useEffect(() => {
    let active = true;
    void getHealth().then(health => {
      if (active && typeof health.installation_id === 'string' && health.installation_id) setInstallationId(health.installation_id);
    }).catch(() => { /* Manual entry remains available without a storage identity. */ })
      .finally(() => { if (active) setInstallationChecked(true); });
    return () => { active = false; };
  }, []);
  return <section>
    <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">群管理</h1>
    <div role="tablist" aria-label="群来源" className="mt-5 flex gap-6 border-b border-slate-200">
      {([['qq', 'QQ 群'], ['wechat', '微信群'], ['other', '演示与导入']] as const).map(([id, label]) =>
        <button key={id} role="tab" aria-selected={platform === id} onClick={() => setParams({ platform: id })}
          className={`border-b-2 px-1 py-3 text-sm ${platform === id ? 'border-blue-600 font-semibold text-blue-700' : 'border-transparent text-slate-500'}`}>{label}</button>)}
    </div>
    {platform === 'wechat' && (workspace && connection && installationChecked ? <WechatPanel mode="groups" available={workspace.wechat_available}
      unavailableReason={workspace.wechat_unavailable_reason} local={['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)}
      epoch={connection.account_epoch}
      installationId={installationId}
        account={workspace.current?.bindings.find(b => b.platform === 'wechat')?.account_id}
      onChanged={refresh} renderGroups={(catalog, reload) => <GroupList platform="wechat" wechat={{ catalog, reload,
        epoch: connection.account_epoch, account: workspace.current?.bindings.find(b => b.platform === 'wechat')?.account_id }} />} />
      : <p className="mt-5 text-sm text-slate-500">正在读取微信连接状态…</p>)}
    {platform !== 'wechat' && <GroupList key={platform} platform={platform} />}
  </section>;
}

function GroupList({ platform, wechat }: { platform: 'qq' | 'wechat' | 'other'; wechat?: {
  catalog: WechatCatalogDTO; reload(): Promise<void>; epoch: string; account?: string;
} }) {
  const { data: allGroups, error, loading, refresh, lastSuccessAt } = usePolling(getGroups, 10_000);
  const intake = usePolling(() => platform === 'wechat' ? getWechatIntake() : Promise.resolve(null), 2000);
  const [directory, setDirectory] = useState<{ id: string; source: string; name: string }[]>([]);
  const [directoryError, setDirectoryError] = useState(false);
  const offer = wechat?.catalog.catalog;
  const account = wechat?.account;
  useEffect(() => {
    let active = true;
    setDirectory([]);
    setDirectoryError(false);
    if (account && offer) void Promise.all(offer.groups.map(async row => ({
      id: await wechatBusinessGroupId(account, row.group_id), source: row.group_id, name: row.name || '未命名群',
    }))).then(rows => { if (active) setDirectory(rows); }).catch(() => { if (active) setDirectoryError(true); });
    return () => { active = false; };
  }, [account, offer?.catalog_id]);
  const stored = allGroups?.filter(g => platform === 'other' ? (g.platform ?? 'qq') !== 'qq' && g.platform !== 'wechat'
    : (g.platform ?? 'qq') === platform);
  const listening = intake.data?.collecting && intake.data.scope?.account_epoch === wechat?.epoch
    && intake.data.scope?.connection_id === wechat?.catalog.scope?.connection_id;
  const activeSources = new Set(listening ? intake.data?.groups.map(row => row.group_id) : []);
  const data = stored && [...stored.map(g => {
    const row = directory.find(row => row.id === g.group_id);
    return row && wechat ? { ...g, enabled: activeSources.has(row.source), collecting: activeSources.has(row.source) }
      : g.platform === 'wechat' ? { ...g, enabled: g.collecting === true } : g;
  }), ...directory.filter(row => !stored.some(g => g.group_id === row.id)).map(row => ({
    group_id: row.id, name: row.name, enabled: activeSources.has(row.source), collecting: activeSources.has(row.source), platform: 'wechat' as const,
    message_count: 0, event_count: 0, course_name: null,
  }))];
  const timetable = usePolling(getTimetable, 60_000);
  const toast = useToast();
  // 开关刚点下、后端还没返回时先按用户的选择显示（乐观更新）；失败就撤回
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [toDelete, setToDelete] = useState<GroupDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  const readonly = !['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(window.location.hostname);
  const [query, setQuery] = useState('');
  const mounted = useRef(true), owner = useRef(accountKey('group-actions'));
  const current = () => mounted.current && owner.current === accountKey('group-actions');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // 进页面拿到第一份数据时排一次：监听中的群在前。之后拨开关不挪位置，刷新页面才重新排
  const orderRef = useRef<string[] | null>(null);
  if (data && orderRef.current === null) orderRef.current = sortEnabledFirst(data).map((g) => g.group_id);
  const ordered = data && orderRef.current ? keepOrder(data, orderRef.current) : null;
  const sourceIds = new Map(directory.map(row => [row.id, row.source]));
  const groupsById = new Map(ordered?.map(g => [g.group_id, g]));
  const shown = ordered ? filterGroups(ordered.map(g => ({ ...g, name: `${g.name} ${sourceIds.get(g.group_id) ?? ''}` })), query)
    .map(g => groupsById.get(g.group_id)!) : null;
  // 正在批量改：'on' 全开 / 'off' 全关 / 'undo' 撤销 / 'preset:名字' 套用预设
  const [busy, setBusy] = useState<string | null>(null);
  // Toast actions retain old renders: use a live lock as well as disabled controls.
  const selectionBusy = useRef(false);
  // 最近一次批量操作（一键全开/全关、套用预设），用来「撤销」；单独拨一个开关后就不能再撤销了
  const [lastBulk, setLastBulk] = useState<GroupChange[] | null>(null);
  const [presets, setPresets] = useState<GroupPreset[]>(() => loadPresets(platform));
  const [presetName, setPresetName] = useState<string | null>(null); // 非 null = 正在输入新预设的名字
  // 课表里的课程名去重（保持课表里的顺序）；没导入课表就不显示下拉
  const courseNames = [...new Set((timetable.data?.courses ?? []).map((c) => c.name))];
  const editing = busy !== null || Object.keys(pending).length > 0 || deleting;
  const selectionUnavailable = Boolean(wechat && (!offer || !account || directory.length !== offer.groups.length));

  function updatePresets(next: GroupPreset[]) {
    if (!current()) return;
    setPresets(next);
    savePresets(next, platform);
  }

  async function saveChanges(changes: GroupChange[]): Promise<number> {
    if (!wechat || !offer || !directory.length) return runInBatches(changes, platform === 'wechat' ? 1 : 8,
      change => current() ? patchGroup(change.group.group_id, { enabled: change.enabled }) : Promise.reject(new Error('GROUP_SPACE_CHANGED')));
    const catalogChanges = changes.filter(change => directory.some(row => row.id === change.group.group_id));
    if (catalogChanges.length) {
      try {
        await changeWechatListening(wechat.catalog, wechat.epoch, catalogChanges.map(change => ({
          source: directory.find(row => row.id === change.group.group_id)!.source, enabled: change.enabled,
        })), () => owner.current === accountKey('group-actions'));
      } finally {
        await Promise.allSettled([wechat.reload(), intake.refresh(), refresh()]);
      }
    }
    return runInBatches(changes.filter(change => !catalogChanges.includes(change)), 1,
      change => current() ? patchGroup(change.group.group_id, { enabled: change.enabled }) : Promise.reject(new Error('GROUP_SPACE_CHANGED')));
  }

  /** 批量改开关（每批 8 个并发）。undoable：成功后可以撤销回去 */
  async function applyChanges(changes: GroupChange[], busyKey: string, doneText: string, undoable: boolean) {
    if (!current() || readonly || editing || selectionUnavailable || selectionBusy.current) return;
    selectionBusy.current = true;
    setBusy(busyKey);
    setPending((p) => ({ ...p, ...Object.fromEntries((data ?? []).map(g => [g.group_id, g.enabled])),
      ...Object.fromEntries(changes.map((c) => [c.group.group_id, c.enabled])) }));
    try {
      const failed = await saveChanges(changes);
      if (!current()) return;
      await refresh();
      if (!current()) return;
      const ok = changes.length - failed;
      if (failed > 0) {
        toast(`${ok} 个成功，${failed} 个失败，请核对平台连接和群状态后重试`, 'error');
        setLastBulk(null);
      } else if (undoable) {
        setLastBulk(changes);
        toast(doneText, 'info', { label: '撤销', onClick: () => void undo(changes) });
      } else {
        setLastBulk(null);
        toast(doneText);
      }
    } catch (e) {
      if (current()) { setLastBulk(null); toastError(toast, e); }
    } finally {
      setPending({});
      setBusy(null);
      selectionBusy.current = false;
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
    await applyChanges(changes, `preset:${p.name}`, `已切换到「${p.name}」：开启 ${on} 个群`, true);
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
    if (!current() || readonly || editing || selectionUnavailable || selectionBusy.current) return;
    selectionBusy.current = true;
    setLastBulk(null);
    setPending((p) => ({ ...p, ...Object.fromEntries((data ?? []).map(row => [row.group_id, row.enabled])), [g.group_id]: enabled }));
    try {
      if (await saveChanges([{ group: g, enabled }])) throw new Error('群开关保存失败，请核对连接后重试');
      await refresh();
      if (current()) toast(enabled ? `已开启「${g.name}」的监听` : `已关闭「${g.name}」的监听，新消息不再生成日程`);
    } catch (e) {
      if (current()) toastError(toast, e);
    } finally {
      setPending({});
      selectionBusy.current = false;
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

  async function onRetry(g: GroupDTO) {
    setRetrying((previous) => ({ ...previous, [g.group_id]: true }));
    try {
      await retryGroup(g.group_id);
      await refresh();
      toast(`已开始重新整理「${g.name}」，结果会在这里更新`);
    } catch (e) {
      toastError(toast, e);
    } finally {
      setRetrying(({ [g.group_id]: _, ...rest }) => rest);
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
      <p className="mt-2 flex items-start gap-1.5 text-sm text-slate-500">
        <span aria-hidden>🔒</span>
        数据保存在你的电脑上，已整理的原始消息按保留期自动清理
      </p>

      <ReadStatus error={error} cached={data !== undefined} lastSuccessAt={lastSuccessAt} onRetry={() => void refresh()} />
      {directoryError && <p role="alert" className="mt-3 text-sm text-rose-600">微信群列表未能准备，请刷新页面重试。</p>}
      {platform === 'qq' && <SyncStatus />}

      {loading && (
        <div className="mt-6 space-y-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-200/60" />
          ))}
        </div>
      )}

      {data && data.length === 0 && (
        <div className="mt-10 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-slate-500">
          {platform === 'wechat' ? '还没有微信群，请先读取群列表。' : platform === 'qq' ? '还没有 QQ 群。连接 QQ 后，收到消息的群会出现在这里。' : '暂无演示或导入的群。'}
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
                placeholder={`搜索${platform === 'wechat' ? '微信' : platform === 'qq' ? 'QQ' : ''}群名或群号，打几个字就行，如「高数班」`}
                aria-label="搜索群"
                className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </div>

            {shown && shown.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-slate-500">
                  {query.trim() ? `找到 ${shown.length} 个群` : `共 ${shown.length} 个群`}，已开启{' '}
                  {shown.filter((g) => pending[g.group_id] ?? g.enabled).length} 个
                </span>
                <div className="flex flex-wrap gap-2">
                  {lastBulk && (
                    <button
                      type="button"
                      onClick={() => void undo(lastBulk)}
                      disabled={editing || readonly || selectionUnavailable}
                      title="恢复到刚才那次批量操作之前的选择"
                      className="rounded-lg border border-amber-200 px-3 py-1.5 text-amber-700 hover:bg-amber-50 disabled:opacity-60"
                    >
                      {busy === 'undo' ? '撤销中…' : '↶ 撤销刚才的操作'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void onBulk(true)}
                    disabled={editing || readonly || selectionUnavailable}
                    className="rounded-lg border border-emerald-200 px-3 py-1.5 text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
                  >
                    {busy === 'on' ? '开启中…' : query.trim() ? '全部开启（搜索结果）' : '一键全部开启'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void onBulk(false)}
                    disabled={editing || readonly || selectionUnavailable}
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
                      <div className="min-w-0 w-full flex-none sm:w-auto sm:flex-1">
                        <div className={`truncate font-medium ${enabled ? 'text-slate-900' : 'text-slate-400'}`} title={g.name}>
                          {g.name}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">
                          {sourceIds.has(g.group_id) && <span className="block break-all">{sourceIds.get(g.group_id)}</span>}
                          {g.platform && `${({ qq: 'QQ', wechat: '微信', demo: '演示', import: '导入', unknown: '未知来源' })[g.platform]} · `}
                          {g.message_count} 条消息 · {g.event_count} 个日程
                          {!enabled && ' · 已关闭'}
                        {enabled && g.platform === 'wechat' && (selectionBusy.current ? ' · 正在更新监听' : g.collecting ? ' · 正在监听' : ' · 正在启动监听')}
                        </div>
                        {g.processing_failure && (
                          <GroupFailureNotice failure={g.processing_failure} enabled={enabled} readonly={readonly}
                            busy={Boolean(retrying[g.group_id])} onRetry={() => void onRetry(g)} />
                        )}
                      </div>

                      {courseNames.length > 0 && (
                        <select
                          aria-label={`「${g.name}」对应课程`}
                          value={g.course_name ?? ''}
                          disabled={editing || readonly || !stored?.some(row => row.group_id === g.group_id)}
                          title={!stored?.some(row => row.group_id === g.group_id) ? '请先开启此群，再绑定课程' : undefined}
                          onChange={(e) => void onCourseChange(g, e.target.value)}
                          className="min-w-0 w-full max-w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-600 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 sm:w-auto sm:max-w-48"
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
                        disabled={editing || readonly || selectionUnavailable}
                        label={`监听「${g.name}」`}
                        onChange={(v) => void onToggle(g, v)}
                      />

                      <button
                        type="button"
                        onClick={() => setToDelete(g)}
                        disabled={empty || editing || readonly}
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
                        disabled={editing || readonly || selectionUnavailable}
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
        将删除该群的消息及来源记录；仍有其他群来源的合并事项会保留。已删除的消息会被记为已处理，之后补拉历史也不会重新导入。此操作无法恢复。
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
      className="flex shrink-0 items-center gap-2 text-sm text-slate-500 disabled:opacity-60"
    >
      <span className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`}>
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`}
        />
      </span>
      <span className="w-8 text-left">{checked ? '开启' : '关闭'}</span>
    </button>
  );
}
