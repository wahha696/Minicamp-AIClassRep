// 事件详情抽屉（D4，FR-8 + FR-12）：电脑右侧滑出，手机底部全屏。
// 内容：基本信息、危机等级（4 格分段选择器，手动设级锁定 / 可交还 AI）、置信度、
// 「查看来源」（原文高亮）、「变更记录」、完成/取消/恢复、导出这一条。
import { useEffect, useState, type ReactNode } from 'react';
import { eventIcsUrl, getEvent, patchEvent, resolveEventProposal } from '../api/client';
import type {
  EventDetailDTO,
  EventEditableField,
  EventPatch,
  EventProposalDTO,
  EventStatus,
  Level,
} from '../api/types';
import { FIELD_TEXT, fieldValueText, highlightSegments, historyLines } from '../lib/detail';
import { toastError } from '../lib/errors';
import { LEVEL_LABEL, levelStyle, STATUS_TEXT, typeMeta } from '../lib/eventMeta';
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
  const [editing, setEditing] = useState(false);

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

  /** 写入冲突或失败后重新取详情，避免页面继续拿过期并发令牌反复提交。 */
  async function refreshLatestDetail(eventId: number) {
    try {
      setDetail(await getEvent(eventId));
    } catch {
      // 原写入错误已经通过 toast 告知；刷新失败不再叠加第二条错误。
    }
  }

  async function setStatus(status: EventStatus, doneText: string) {
    if (!detail) return;
    setBusy(true);
    try {
      const e = await patchEvent(detail.id, {
        status,
        expected_version: detail.version,
        expected_updated_at: detail.updated_at,
      });
      setDetail(e);
      toast(doneText);
      onChanged?.();
    } catch (e) {
      toastError(toast, e);
      await refreshLatestDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  /** 手动调级（level 1~4 → 锁定；null → 交还 AI） */
  async function setLevel(level: Level | null) {
    if (!detail) return;
    setBusy(true);
    try {
      const e = await patchEvent(detail.id, {
        level,
        expected_version: detail.version,
        expected_updated_at: detail.updated_at,
      });
      setDetail(e);
      toast(level === null ? '已交还 AI 评估' : `等级已设为「${LEVEL_LABEL[level]}」，AI 更新不会覆盖`);
      onChanged?.();
    } catch (e) {
      toastError(toast, e);
      await refreshLatestDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  async function resolveProposal(proposalId: number, decision: 'accept' | 'reject') {
    if (!detail) return;
    setBusy(true);
    try {
      const next = await resolveEventProposal(
        detail.id,
        proposalId,
        decision,
        detail.version,
        detail.updated_at,
      );
      setDetail(next);
      toast(decision === 'accept' ? '已接受这条修改' : '已保留原安排');
      onChanged?.();
    } catch (e) {
      toastError(toast, e);
      await refreshLatestDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  async function saveManualEdit(patch: EventPatch) {
    if (!detail) return;
    setBusy(true);
    try {
      const next = await patchEvent(detail.id, {
        ...patch,
        expected_version: detail.version,
        expected_updated_at: detail.updated_at,
      });
      setDetail(next);
      setEditing(false);
      toast('已保存人工修正；这些字段会受到保护');
      onChanged?.();
    } catch (e) {
      toastError(toast, e);
      await refreshLatestDetail(detail.id);
    } finally {
      setBusy(false);
    }
  }

  async function unlockFields(fields: EventEditableField[]) {
    if (!detail || fields.length === 0) return;
    setBusy(true);
    try {
      const next = await patchEvent(detail.id, {
        unlock_fields: fields,
        expected_version: detail.version,
        expected_updated_at: detail.updated_at,
      });
      setDetail(next);
      toast('已允许 AI 按后续通知更新这些字段');
      onChanged?.();
    } catch (e) {
      toastError(toast, e);
      await refreshLatestDetail(detail.id);
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
          {detail && (
            <Body
              detail={detail}
              showSources={showSources}
              onToggleSources={() => setShowSources((v) => !v)}
              busy={busy}
              onSetLevel={(l) => void setLevel(l)}
              editing={editing}
              onStartEdit={() => setEditing(true)}
              onCancelEdit={() => setEditing(false)}
              onSaveEdit={(patch) => void saveManualEdit(patch)}
              onResolveProposal={(proposalId, decision) => void resolveProposal(proposalId, decision)}
              onConfirmCurrent={() => void setStatus('active', '已确认当前安排')}
              onUnlockFields={(fields) => void unlockFields(fields)}
            />
          )}
        </div>

        {detail && (
          <footer className="flex flex-wrap gap-2 border-t border-slate-200 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {detail.status === 'pending_confirm' ? (
              <span className="py-2 text-sm font-medium text-amber-800">请先处理待确认修改，再标记完成或取消</span>
            ) : detail.status === 'done' || detail.status === 'cancelled' ? (
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
            {detail.start_at !== null || detail.deadline_at !== null ? (
              <a
                href={eventIcsUrl(detail.id)}
                download
                className="ml-auto rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                导出这一条
              </a>
            ) : (
              <span />
            )}
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

const PROPOSAL_KIND_TEXT: Record<EventProposalDTO['kind'], string> = {
  create: '新增安排',
  update: '修改安排',
  cancel: '取消安排',
};

function proposalReason(proposal: EventProposalDTO): string {
  if (proposal.reason === 'manual_lock_conflict') {
    return '这条通知与之前的人工修改冲突。受保护字段没有被自动覆盖，请你决定采用哪一版。';
  }
  return `AI 对这条通知的识别把握为 ${Math.round(proposal.confidence * 100)}%，因此保留了原安排等待确认。`;
}

function ProposalReview({
  detail,
  busy,
  onResolve,
  onStartEdit,
  onConfirmCurrent,
}: {
  detail: EventDetailDTO;
  busy: boolean;
  onResolve: (proposalId: number, decision: 'accept' | 'reject') => void;
  onStartEdit: () => void;
  onConfirmCurrent: () => void;
}) {
  const proposals = detail.pending_proposals ?? [];
  return (
    <section className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3" aria-labelledby="pending-review-title">
      <h3 id="pending-review-title" className="font-semibold text-amber-950">
        待确认修改
      </h3>
      <p className="mt-1 text-sm text-amber-900">
        当前安排仍完整保留。核对新通知后，可以接受、保留原安排，或直接填写正确内容。
      </p>

      {proposals.length === 0 ? (
        <div className="mt-3 rounded-lg bg-white/70 p-3 text-sm text-slate-700">
          <p>这条待确认记录来自旧版本，没有保存结构化差异。请查看来源后确认当前安排，或人工修正。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onConfirmCurrent}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              确认当前安排
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onStartEdit}
              className="rounded-lg border border-amber-400 bg-white px-3 py-2 text-sm font-medium text-amber-900 disabled:opacity-60"
            >
              人工修改时间和地点
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {proposals.map((proposal) => {
            const sources = detail.sources.filter((source) => proposal.source_message_ids.includes(source.message_id));
            return (
              <article key={proposal.id} className="rounded-lg border border-amber-200 bg-white p-3" aria-label={`${PROPOSAL_KIND_TEXT[proposal.kind]}提案`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">{PROPOSAL_KIND_TEXT[proposal.kind]}</span>
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                    置信度 {Math.round(proposal.confidence * 100)}%
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600">{proposalReason(proposal)}</p>
                <dl className="mt-2 divide-y divide-slate-100 rounded border border-slate-100">
                  {Object.entries(proposal.changes).map(([field, change]) => (
                    <div key={field} className="grid grid-cols-[4.5rem_1fr] gap-2 px-2 py-2 text-sm">
                      <dt className="text-slate-500">{FIELD_TEXT[field] ?? field}</dt>
                      <dd className="min-w-0 break-words text-slate-800">
                        <del className="text-slate-400">{fieldValueText(field, change?.from)}</del>
                        <span className="mx-1.5 text-slate-400" aria-hidden>→</span>
                        <span className="font-medium text-slate-900">{fieldValueText(field, change?.to)}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
                {sources.length > 0 && (
                  <div className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600">
                    <div className="font-medium text-slate-500">触发原因：来源通知</div>
                    {sources.map((source) => (
                      <p key={source.message_id} className="mt-0.5 whitespace-pre-wrap break-words">“{source.text}”</p>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onResolve(proposal.id, 'accept')}
                    className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
                  >
                    {proposal.kind === 'cancel' ? '接受取消' : proposal.kind === 'create' ? '确认新增' : '接受修改'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onResolve(proposal.id, 'reject')}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
                  >
                    {proposal.kind === 'create' ? '拒绝新增' : '保留原安排'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onStartEdit}
                    className="rounded-lg border border-amber-400 px-3 py-2 text-sm font-medium text-amber-900 disabled:opacity-60"
                  >
                    人工修改
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

const TIME_FIELDS = ['start_at', 'end_at', 'deadline_at'] as const;

function datetimeInputValue(value: number | null): string {
  if (value === null) return '';
  return new Date(value + 8 * 3_600_000).toISOString().slice(0, 16);
}

function parseDatetimeInput(value: string): number | null {
  if (value === '') return null;
  const parsed = Date.parse(`${value}:00+08:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

function ManualEditForm({
  detail,
  busy,
  onSave,
  onCancel,
}: {
  detail: EventDetailDTO;
  busy: boolean;
  onSave: (patch: EventPatch) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(detail.title);
  const [description, setDescription] = useState(detail.description);
  const [startAt, setStartAt] = useState(datetimeInputValue(detail.start_at));
  const [endAt, setEndAt] = useState(datetimeInputValue(detail.end_at));
  const [deadlineAt, setDeadlineAt] = useState(datetimeInputValue(detail.deadline_at));
  const [location, setLocation] = useState(detail.location ?? '');
  const [actionRequired, setActionRequired] = useState(detail.action_required ?? '');
  const [formError, setFormError] = useState<string>();

  function submit() {
    const nextTitle = title.trim();
    if (nextTitle === '') {
      setFormError('标题不能为空');
      return;
    }
    const patch: EventPatch = {};
    if (nextTitle !== detail.title) patch.title = nextTitle;
    if (description !== detail.description) patch.description = description;
    const timeDrafts = { start_at: startAt, end_at: endAt, deadline_at: deadlineAt };
    for (const field of TIME_FIELDS) {
      const raw = timeDrafts[field];
      if (raw !== datetimeInputValue(detail[field])) patch[field] = parseDatetimeInput(raw);
    }
    const nextLocation = location.trim() || null;
    if (nextLocation !== detail.location) patch.location = nextLocation;
    const nextAction = actionRequired.trim() || null;
    if (nextAction !== detail.action_required) patch.action_required = nextAction;

    const nextStart = patch.start_at !== undefined ? patch.start_at : detail.start_at;
    const nextEnd = patch.end_at !== undefined ? patch.end_at : detail.end_at;
    if (nextStart !== null && nextEnd !== null && nextEnd <= nextStart) {
      setFormError('结束时间必须晚于开始时间');
      return;
    }
    if (Object.keys(patch).length === 0) {
      setFormError('请至少修改一项内容');
      return;
    }
    setFormError(undefined);
    onSave(patch);
  }

  const inputClass = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100';
  return (
    <section className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3" aria-labelledby="manual-edit-title">
      <h3 id="manual-edit-title" className="font-semibold text-sky-950">人工修正事件</h3>
      <p className="mt-1 text-xs text-sky-800">保存后，改过的字段会受到保护；后续群通知有差异时会再次请你确认。</p>
      <div className="mt-3 space-y-3">
        <label className="block text-sm text-slate-700">
          标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
        </label>
        <label className="block text-sm text-slate-700">
          说明
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className={inputClass} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm text-slate-700">
            开始时间
            <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className={inputClass} />
          </label>
          <label className="block text-sm text-slate-700">
            结束时间
            <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} className={inputClass} />
          </label>
          <label className="block text-sm text-slate-700">
            截止时间
            <input type="datetime-local" value={deadlineAt} onChange={(e) => setDeadlineAt(e.target.value)} className={inputClass} />
          </label>
          <label className="block text-sm text-slate-700">
            地点
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="可留空" className={inputClass} />
          </label>
        </div>
        <label className="block text-sm text-slate-700">
          要求
          <textarea value={actionRequired} onChange={(e) => setActionRequired(e.target.value)} rows={2} className={inputClass} />
        </label>
      </div>
      {formError && <p role="alert" className="mt-2 text-sm text-rose-700">{formError}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          保存人工修正
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
        >
          取消编辑
        </button>
      </div>
    </section>
  );
}

function Body({
  detail,
  showSources,
  onToggleSources,
  busy,
  onSetLevel,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onResolveProposal,
  onConfirmCurrent,
  onUnlockFields,
}: {
  detail: EventDetailDTO;
  showSources: boolean;
  onToggleSources: () => void;
  busy: boolean;
  onSetLevel: (level: Level | null) => void;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (patch: EventPatch) => void;
  onResolveProposal: (proposalId: number, decision: 'accept' | 'reject') => void;
  onConfirmCurrent: () => void;
  onUnlockFields: (fields: EventEditableField[]) => void;
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
        {/* B15：只有群通知触发的改动（带来源消息）才亮「已更新」；自己调级/改状态不算 */}
        {detail.history.some((h) => h.source_message_id !== null) && (
          <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">已按最新通知更新</span>
        )}
      </div>
      <h2 className="mt-2 text-xl font-bold leading-snug text-slate-900">{detail.title}</h2>
      {detail.description && <p className="mt-1 text-sm text-slate-500">{detail.description}</p>}

      {detail.status === 'pending_confirm' && (
        <ProposalReview
          detail={detail}
          busy={busy}
          onResolve={onResolveProposal}
          onStartEdit={onStartEdit}
          onConfirmCurrent={onConfirmCurrent}
        />
      )}

      {editing && (
        <ManualEditForm
          key={`${detail.id}-${detail.version}`}
          detail={detail}
          busy={busy}
          onSave={onSaveEdit}
          onCancel={onCancelEdit}
        />
      )}

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
        <Row label="危机等级">
          <div>
            <div className="flex gap-1" role="group" aria-label="危机等级">
              {([1, 2, 3, 4] as Level[]).map((l) => {
                const lv = levelStyle(detail.type, l);
                const active = detail.level === l;
                return (
                  <button
                    key={l}
                    type="button"
                    disabled={busy}
                    aria-pressed={active}
                    onClick={() => onSetLevel(l)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 ${
                      active
                        ? `${lv.bg} ${lv.text} ring-1 ring-current`
                        : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {LEVEL_LABEL[l]}
                  </button>
                );
              })}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
              <span>{detail.level_locked ? '你设定的（AI 更新不会覆盖）' : 'AI 评估'}</span>
              {detail.level_locked && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSetLevel(null)}
                  className="text-sky-600 underline underline-offset-2 hover:text-sky-700 disabled:opacity-60"
                >
                  交还 AI
                </button>
              )}
            </div>
          </div>
        </Row>
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

      {detail.manual_locked_fields.length > 0 && (
        <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          <p>
            已保护人工修改：
            {detail.manual_locked_fields.map((field) => FIELD_TEXT[field] ?? field).join('、')}。新通知有差异时会先请你确认。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onUnlockFields(detail.manual_locked_fields)}
            className="mt-1 font-medium text-sky-700 underline underline-offset-2 disabled:opacity-60"
          >
            允许 AI 按后续通知更新
          </button>
        </div>
      )}

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
            {lines.map((l, i) => (
              <li key={i} className="text-sm">
                <div className="text-xs text-slate-400">
                  {l.manual ? '手动调整' : `${l.version} 版`} · {l.when}
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
