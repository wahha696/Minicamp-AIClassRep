import { useEffect, useState } from 'react';
import { assistantRequest } from '../api/assistant';
import type { AssistantMemoryRule as MemoryRule, AssistantMemoryState as Memories, AssistantMemoryEventType, AssistantSuppressionDetail } from '../../../../shared/assistant-memory';

const kinds = [['assignment', '作业'], ['exam', '考试'], ['meeting', '会议'], ['activity', '活动'], ['announcement', '通知'], ['other', '其他']] as const;
const inputClass = 'w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm';

export default function AssistantMemories({ epoch }: { epoch: string }) {
  const [data, setData] = useState<Memories>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<MemoryRule | null>();
  const [remove, setRemove] = useState<number>();
  const [text, setText] = useState('');
  const [course, setCourse] = useState('');
  const [action, setAction] = useState<'exclude_calendar' | 'note'>('note');
  const [types, setTypes] = useState<AssistantMemoryEventType[]>([]);
  const [sources, setSources] = useState<AssistantSuppressionDetail>();
  const refresh = async () => setData(await assistantRequest<Memories>(epoch, '/api/assistant/memories'));
  useEffect(() => { const controller = new AbortController(); void assistantRequest<Memories>(epoch, '/api/assistant/memories', 'GET', undefined, controller.signal).then(setData).catch((e: unknown) => { if (!controller.signal.aborted) setError(String(e instanceof Error ? e.message : e)); }); return () => controller.abort(); }, [epoch]);
  const mutate = async (path: string, method: string, body?: unknown) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await assistantRequest(epoch, path, method, body); await refresh(); setEdit(undefined); setRemove(undefined); window.dispatchEvent(new Event('classrep:resumed')); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  function startEdit(rule: MemoryRule | null) { setEdit(rule); setText(rule?.text ?? ''); setCourse(rule?.course ?? ''); setAction(rule?.action ?? 'note'); setTypes(rule?.event_types ?? []); }
  return <section className="space-y-3 p-3 text-sm" aria-label="助手长期记忆">
    <p className="rounded-lg bg-indigo-50 p-2 text-xs leading-relaxed text-indigo-800">只属于当前空间。日程排除规则对后续整理生效，已有日程和原始聊天保留。普通偏好用于助手回答，不会自动变成筛选规则。你可随时修改、停用或删除。</p>
    <p className="text-xs leading-relaxed text-slate-500">请先在群管理中绑定课程名称，规则仅按该名称精确匹配；没有绑定课程的群不会被排除。规则只影响新事项，已有事项的更新和取消照常处理。停用或删除规则不会自动恢复此前未加入的事项，可在下方追溯原始来源。</p>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {!data && !error && <p role="status">正在读取记忆…</p>}
    {data?.rules.length === 0 && <p className="text-slate-500">暂无长期记忆。只有你明确保存的规则才会生效。</p>}
    {data?.rules.map(rule => <article key={rule.id} className="space-y-2 rounded-lg border border-slate-200 p-2">
      <p className="whitespace-pre-wrap">{rule.text}</p>
      <p className="text-xs text-slate-500">{rule.enabled ? '已启用' : '已停用'} · {rule.action === 'note' ? '普通偏好' : `不加入日程：${rule.course ?? ''} / ${rule.event_types.map(t => kinds.find(k => k[0] === t)?.[1] ?? t).join('、')}`}</p>
      <div className="flex gap-3 text-xs text-indigo-700">
        <button disabled={busy} onClick={() => startEdit(rule)}>修改</button>
        <button disabled={busy} onClick={() => void mutate(`/api/assistant/memories/${rule.id}`, 'PATCH', { enabled: !rule.enabled })}>{rule.enabled ? '停用' : '启用'}</button>
        <button disabled={busy} onClick={() => setRemove(rule.id)}>删除</button>
      </div>
      {remove === rule.id && <div className="space-x-3 rounded bg-red-50 p-2 text-xs"><span>确定删除这条偏好？</span><button disabled={busy} onClick={() => void mutate(`/api/assistant/memories/${rule.id}`, 'DELETE')}>确认删除</button><button onClick={() => setRemove(undefined)}>保留</button></div>}
    </article>)}
    {edit === undefined ? <button className="rounded-lg border border-indigo-300 px-3 py-1.5 text-indigo-700" onClick={() => startEdit(null)}>新增长期偏好</button> : <form className="space-y-2 rounded-lg border border-indigo-200 p-2" onSubmit={e => { e.preventDefault(); void mutate(edit ? `/api/assistant/memories/${edit.id}` : '/api/assistant/memories', edit ? 'PATCH' : 'POST', { text: text.trim(), action, course: action === 'exclude_calendar' ? course.trim() : '', event_types: action === 'exclude_calendar' ? types : [], enabled: edit?.enabled ?? true }); }}>
      <label className="block">偏好内容<textarea aria-label="偏好内容" required maxLength={500} className={inputClass} value={text} onChange={e => setText(e.target.value)} /></label>
      <label className="block">作用<select aria-label="偏好作用" className={inputClass} value={action} onChange={e => setAction(e.target.value as typeof action)}><option value="note">普通偏好（助手回答参考）</option><option value="exclude_calendar">指定课程事项不加入日程</option></select></label>
      {action === 'exclude_calendar' && <><label className="block">课程名称<input aria-label="偏好课程名称" required className={inputClass} value={course} onChange={e => setCourse(e.target.value)} /></label><fieldset><legend>排除的事项类型</legend><div className="flex flex-wrap gap-2">{kinds.map(([kind, label]) => <label key={kind} className="flex gap-1"><input type="checkbox" checked={types.includes(kind)} onChange={e => setTypes(prev => e.target.checked ? [...prev, kind] : prev.filter(t => t !== kind))} />{label}</label>)}</div></fieldset></>}
      <div className="flex gap-3"><button disabled={busy || !text.trim() || (action === 'exclude_calendar' && (!course.trim() || !types.length))} className="rounded bg-indigo-700 px-3 py-1 text-white disabled:opacity-50" type="submit">保存偏好</button><button type="button" onClick={() => setEdit(undefined)}>取消</button></div>
    </form>}
    {!!data?.recent_suppressions.length && <div className="space-y-2 border-t pt-2"><p className="font-medium">最近按偏好未加入日程</p>{data.recent_suppressions.map(item => <div key={item.id}><p>{item.title} · {item.course}</p><button className="text-xs text-indigo-700" onClick={() => { setError(''); void assistantRequest<AssistantSuppressionDetail>(epoch, `/api/assistant/memories/suppressions/${item.id}`).then(setSources).catch(e => setError(e instanceof Error ? e.message : String(e))); }}>查看 {item.source_count} 条原始来源</button></div>)}</div>}
    {sources !== undefined && <div className="rounded-lg bg-slate-50 p-2"><div className="flex justify-between"><span>原始来源（只读）</span><button onClick={() => setSources(undefined)}>关闭来源</button></div><div className="max-h-48 space-y-2 overflow-auto text-xs">{sources.sources.map(source => <article key={`${source.group_id}:${source.message_id}`} className="border-t pt-2"><p className="text-slate-500">{source.group_name} · {source.sender_name} · {new Date(source.sent_at).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{source.text}</p></article>)}{sources.sources.length === 0 && <p>原消息已不在本地保留范围内。</p>}</div></div>}
  </section>;
}
