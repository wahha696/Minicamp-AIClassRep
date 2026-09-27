// 今日页的待办框（FR-15）：群待办 + 手动待办混排，按等级降序。
// 勾上先弹「是否确认完成」（可勾「下次不再提醒」），确认后完成（群待办 PATCH events，手动待办 PATCH todos），Toast 带「撤销」。
// 「+」展开输入行回车添加手动待办；群待办点标题开 EventDrawer，手动待办点标题就地编辑。
import { useCallback, useState } from 'react';
import { createTodo, patchEvent, patchTodo } from '../api/client';
import type { EventStatus, Level, TodosDTO } from '../api/types';
import { toastError } from '../lib/errors';
import { LEVEL_LABEL, levelStyle } from '../lib/eventMeta';
import { SKIP_DONE_CONFIRM_KEY, readFlag, writeFlag } from '../lib/status';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './Toast';

interface Props {
  data: TodosDTO | undefined;
  loading: boolean;
  /** 勾选 / 新增 / 编辑后让外层重新拉数据 */
  onChanged: () => void;
  /** 点群待办标题 → 打开事件详情抽屉 */
  onOpenEvent: (id: number) => void;
}

type Row = {
  kind: 'event' | 'manual';
  id: number;
  title: string;
  note: string;
  level: Level;
  type: string; // event 行的真实类型，决定徽标色相；手动待办固定 'other'
  status: EventStatus; // event 行勾选前的状态，撤销时恢复（待确认的不能撤销成进行中）；手动待办固定 'active'
  created_at: number;
};

function toRows(data: TodosDTO): Row[] {
  const rows: Row[] = [
    ...data.events.map((e) => ({
      kind: 'event' as const,
      id: e.id,
      title: e.title,
      note: e.group_name,
      level: e.level,
      type: e.type as string,
      status: e.status,
      created_at: e.created_at,
    })),
    ...data.manual.map((t) => ({
      kind: 'manual' as const,
      id: t.id,
      title: t.title,
      note: t.note,
      level: t.level,
      type: 'other',
      status: 'active' as const,
      created_at: t.created_at,
    })),
  ];
  // 等级降序，同级先来的在前
  return rows.sort((a, b) => b.level - a.level || a.created_at - b.created_at);
}

export default function TodoBox({ data, loading, onChanged, onOpenEvent }: Props) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // 等待确认完成的那一行；非 null 时弹窗打开，这一行的勾先显示为已勾
  const [confirming, setConfirming] = useState<Row | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const cancelConfirm = useCallback(() => setConfirming(null), []);

  const rows = data ? toRows(data) : [];

  async function check(row: Row) {
    const key = `${row.kind}-${row.id}`;
    setBusyId(key);
    try {
      if (row.kind === 'event') await patchEvent(row.id, { status: 'done' });
      else await patchTodo(row.id, { done: true });
      onChanged();
      toast(`已完成「${row.title}」`, 'info', {
        label: '撤销',
        onClick: () => {
          void (async () => {
            try {
              if (row.kind === 'event') await patchEvent(row.id, { status: row.status });
              else await patchTodo(row.id, { done: false });
              onChanged();
            } catch (e) {
              toastError(toast, e);
            }
          })();
        },
      });
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusyId(null);
    }
  }

  /** 点勾：没关提醒就先弹确认，关了就直接完成 */
  function onCheck(row: Row) {
    if (readFlag(SKIP_DONE_CONFIRM_KEY) === '1') {
      void check(row);
      return;
    }
    setDontAskAgain(false);
    setConfirming(row);
  }

  function onConfirmDone() {
    if (!confirming) return;
    if (dontAskAgain) writeFlag(SKIP_DONE_CONFIRM_KEY, '1'); // 点「否」时不记，免得误勾后再也不提醒
    const row = confirming;
    setConfirming(null);
    void check(row);
  }

  async function addManual() {
    const title = draft.trim();
    if (!title) {
      setAdding(false);
      return;
    }
    try {
      await createTodo({ title });
      setDraft('');
      setAdding(false);
      onChanged();
      toast(`已添加待办「${title}」`);
    } catch (e) {
      toastError(toast, e);
    }
  }

  async function saveEdit(row: Row) {
    const title = editDraft.trim();
    setEditingId(null);
    if (!title || title === row.title) return;
    try {
      await patchTodo(row.id, { title });
      onChanged();
    } catch (e) {
      toastError(toast, e);
    }
  }

  return (
    <section
      aria-label="待办"
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
    >
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-700">
          待办{rows.length > 0 && <span className="ml-1 font-normal text-slate-400">{rows.length}</span>}
        </h2>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          aria-expanded={adding}
          aria-label="添加手动待办"
          className="rounded-md px-2 py-0.5 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          +
        </button>
      </header>

      {adding && (
        <div className="border-b border-slate-100 px-4 py-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addManual();
              if (e.key === 'Escape') setAdding(false);
            }}
            onBlur={() => draft.trim() === '' && setAdding(false)}
            placeholder="写点什么，回车添加"
            className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="space-y-2 p-4" aria-busy>
          <div className="h-8 animate-pulse rounded bg-slate-100" />
          <div className="h-8 animate-pulse rounded bg-slate-100" />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400">没有待办</p>
      ) : (
        <ul className="divide-y divide-slate-50">
          {rows.map((row) => {
            const lv = levelStyle(row.type, row.level);
            const key = `${row.kind}-${row.id}`;
            const editing = row.kind === 'manual' && editingId === row.id;
            return (
              <li key={key} className="flex items-center gap-2.5 px-4 py-2.5">
                <input
                  type="checkbox"
                  checked={confirming !== null && `${confirming.kind}-${confirming.id}` === key}
                  disabled={busyId === key}
                  onChange={() => onCheck(row)}
                  aria-label={`完成「${row.title}」`}
                  className="h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 accent-slate-700"
                />
                {editing ? (
                  <input
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveEdit(row);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    onBlur={() => void saveEdit(row)}
                    className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-0.5 text-sm focus:border-blue-400 focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (row.kind === 'event') onOpenEvent(row.id);
                      else {
                        setEditingId(row.id);
                        setEditDraft(row.title);
                      }
                    }}
                    className="min-w-0 flex-1 truncate text-left text-sm text-slate-800 hover:text-slate-900"
                    title={row.kind === 'manual' ? '点一下就地改名' : row.title}
                  >
                    {row.title}
                  </button>
                )}
                <span className={`shrink-0 rounded px-1 text-xs font-medium leading-4 ${lv.bg} ${lv.text}`}>
                  {LEVEL_LABEL[row.level]}
                </span>
                {row.note && !editing && (
                  <span className="hidden shrink-0 truncate text-xs text-slate-400 sm:inline" title={row.note}>
                    {row.note}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title="是否确认完成？"
        confirmText="是"
        cancelText="否"
        onConfirm={onConfirmDone}
        onCancel={cancelConfirm}
        footer={
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="h-3.5 w-3.5 accent-slate-700"
            />
            下次不再提醒
          </label>
        }
      >
        「{confirming?.title}」完成后会从待办里移走。
      </ConfirmDialog>
    </section>
  );
}
