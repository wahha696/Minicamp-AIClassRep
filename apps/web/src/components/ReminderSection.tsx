import { useState } from 'react';
import { getReminderSettings, saveReminderTimes } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { errorText, toastError } from '../lib/errors';
import { useToast } from './Toast';

export default function ReminderSection() {
  const { data, error, refresh } = usePolling(getReminderSettings, 30_000);
  const [draft, setDraft] = useState<{ times: string; dailyLimit: string } | null>(null);
  const times = draft?.times ?? data?.before_minutes.map(minutes => minutes / 60).join(', ') ?? '24, 2';
  const dailyLimit = draft?.dailyLimit ?? String(data?.daily_limit ?? 10);
  const dirty = draft !== null;
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    if (busy || !data) return;
    const hours = times.split(/[,，]/).map(value => value.trim());
    const minutes = hours.map(value => Math.round(Number(value) * 60));
    const limit = Number(dailyLimit);
    if (!hours.length || hours.some(value => !/^\d+(\.\d+)?$/.test(value))
      || minutes.some(value => !Number.isSafeInteger(value) || value <= 0)
      || new Set(minutes).size !== minutes.length || minutes.length > 16) {
      toast('请填写不重复的正数小时，多个时间用逗号隔开（最多 16 个）', 'error'); return;
    }
    if (!/^\d+$/.test(dailyLimit) || !Number.isSafeInteger(limit) || limit <= 0) {
      toast('每天提醒上限请填写正整数', 'error'); return;
    }
    setBusy(true);
    try { await saveReminderTimes(minutes, limit); await refresh(); setDraft(null); toast('已保存提醒设置；自动提醒仍关闭'); }
    catch (error) { toastError(toast, error); }
    finally { setBusy(false); }
  }
  return <section className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex items-center justify-between gap-4">
      <div><h3 className="text-sm font-semibold text-slate-800">消息提醒</h3>
        <p className="mt-1 text-sm text-slate-500">默认关闭，由你主动开启。只在截止前提醒，同一时刻的多件事项合并发送。</p></div>
      <button type="button" role="switch" aria-label="消息提醒" aria-checked={false} disabled
        className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-400">已关闭</button>
    </div>
    <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">手机提醒尚在验证，完成渠道接入和扫码绑定后可开启。目前不会自动发送通知。</p>
    {error && <p role="status" className="mt-3 text-sm text-rose-700">{errorText(error)} <button type="button" onClick={() => void refresh()} className="underline">重试</button></p>}
    <label className="mt-4 block text-sm text-slate-700" htmlFor="reminder-hours">截止前多少小时提醒</label>
    <div className="mt-2 flex gap-2">
      <input id="reminder-hours" value={times} maxLength={256} disabled={!data || !!error || busy}
        onChange={event => { setDraft({ times: event.target.value, dailyLimit }); }}
        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50" />
      <button type="button" disabled={!dirty || !data || !!error || busy} onClick={() => void save()}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50">{busy ? '保存中…' : '保存'}</button>
    </div>
    <p className="mt-2 text-xs text-slate-500">默认 24、2 小时各一次，按精确时长计算。用逗号分隔，支持小数，保存到最接近的整分钟。仅保存在当前课代表空间，不开启后台运行。</p>
    <label htmlFor="reminder-limit" className="mt-4 block text-sm text-slate-700">每天提醒上限（条）</label>
    <input id="reminder-limit" inputMode="numeric" value={dailyLimit} maxLength={16} disabled={!data || !!error || busy}
      onChange={event => { setDraft({ times, dailyLimit: event.target.value }); }}
      className="mt-2 w-32 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-50" />
    <p className="mt-2 text-xs text-slate-500">默认每天最多 10 条，同一时刻合并后算一条；渠道仍可能有额外额度限制。不设安静时段。离线恢复后，尚未截止的事项补发一次，已截止不补发。</p>
  </section>;
}
