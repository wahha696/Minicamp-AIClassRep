import { useState, type ReactNode } from 'react';
import type { WorkspaceStatus } from '../../../../shared/workspaces';
import { renameWorkspace } from '../api/client';

export default function WorkspacePanel({ status, epoch, onChanged, children }: {
  status: WorkspaceStatus; epoch: string; onChanged: () => Promise<unknown> | void;
  children?: ReactNode;
}) {
  const label = status.current?.name ?? '我的空间';
  const [draft, setDraft] = useState<{ name: string; epoch: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (!draft || !draft.name.trim()) return;
    setBusy(true); setError('');
    try {
      await renameWorkspace(draft.name.trim(), draft.epoch);
      await onChanged(); setDraft(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '空间名称保存失败，请重试'); }
    finally { setBusy(false); }
  }
  return <section aria-label="课代表空间" className="space-y-5 rounded-lg border border-slate-200 bg-white p-4 sm:p-6">
    <header className="space-y-2">
      <p className="text-xs font-medium text-slate-500">课代表空间</p>
      {draft ? <form onSubmit={event => { event.preventDefault(); void save(); }} className="flex flex-wrap items-center gap-2">
        <input aria-label="空间名称" autoFocus value={draft.name} disabled={busy} maxLength={256}
          onChange={event => setDraft({ ...draft, name: event.target.value })}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <button type="submit" disabled={busy || !draft.name.trim()} className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-40">保存</button>
        <button type="button" disabled={busy} onClick={() => { setDraft(null); setError(''); }} className="px-2 py-2 text-sm text-slate-500">取消</button>
      </form> : <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 break-all text-xl font-semibold text-slate-900">{label}</h2>
        <button type="button" onClick={() => { setDraft({ name: label, epoch }); setError(''); }}
          className="shrink-0 py-1 text-sm text-slate-500 underline-offset-4 hover:underline">改名</button>
      </div>}
      {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
    </header>
    {children}
  </section>;
}
