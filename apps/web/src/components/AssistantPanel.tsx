import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AssistantCapability, AssistantPlan, AssistantReply, AssistantResult } from '../../../../shared/assistant';
import { assistantRequest } from '../api/assistant';
import AssistantMemories from './AssistantMemories';
import { applyPetAssistantSettings } from '../lib/petAssistant';

type Entry = { id: number; role: 'bot' | 'user'; text: string; results?: AssistantResult[]; context?: boolean };
const examples = ['今天有哪些待办？', '帮我调整提醒设置', '查看你能操作的功能', '我想保存一条长期偏好'];
const policyLabel = { read: '查询', confirm: '修改，需确认', destructive: '破坏性操作，请仔细核对', external: '外发或联网操作，请核对范围', user_step: '需要你在页面完成' };
const pageLinks = new Set(['/', '/week', '/groups', '/groups?platform=wechat', '/settings', '/connect', '/demo']);
const downloadLinks = new Set(['/api/settings/data/backup', '/api/export.ics']);
const buttonClass = 'rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50';
const fieldLabels: Record<string, string> = { visible: '显示桌宠', style: '说话风格', reset_image: '恢复默认形象', reset_position: '恢复默认位置', id: '编号', title: '标题', name: '名称', text: '内容', status: '状态', course: '课程', course_name: '课程', location: '地点', description: '说明', changes: '修改内容', rule: '规则', action: '作用', event_types: '事项类型', enabled: '启用', done: '完成', note: '备注', level: '重要性', deadline_at: '截止时间', start_at: '开始时间', end_at: '结束时间', before_minutes: '提前提醒（分钟）', daily_limit: '每日提醒上限', group_id: '群编号', group_name: '群名称', events: '事项', todos: '待办', courses: '课程', rules: '规则', items: '项目', semester_start: '第一周周一', term_name: '学期', weekday: '星期', weeks: '教学周', teacher: '教师', message: '说明', recent_suppressions: '最近未加入日程', source_count: '来源数', source: '来源', current_space: '当前空间', scope: '范围', version: '版本', expected_version: '核对版本', expected_updated_at: '核对更新时间', updated_at: '更新时间', created_at: '创建时间', action_required: '需要做什么', has_more: '仍有更多', inserted: '新增消息数', phase: '阶段', platform: '平台', days: '历史天数', messages: '消息数', groups: '群数', count: '数量', summary: '摘要', revision: '课表版本', expected_revision: '核对课表版本', active: '进行中', completed: '已完成', cancelled: '已取消', failed: '失败', remaining: '剩余', total: '总计', data: '内容' };
const valueLabels: Record<string, string> = { active: '进行中', done: '已完成', cancelled: '已取消', pending_confirm: '待确认', assignment: '作业', exam: '考试', meeting: '会议', activity: '活动', announcement: '通知', other: '其他', exclude_calendar: '不加入日程', note: '普通偏好', current_space: '当前空间' };
function AssistantData({ value, field = '', depth = 0 }: { value: unknown; field?: string; depth?: number }) {
  if (value === null || value === undefined) return <span>未设置</span>;
  if (depth > 5) return <span>内容较复杂，请前往相应页面核对。</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value === 'number') return <span>{field.endsWith('_at') && value > 1e11 ? new Date(value).toLocaleString() : value}</span>;
  if (typeof value === 'string') return <span className="whitespace-pre-wrap break-words">{valueLabels[value] ?? (value || '未填写')}</span>;
  if (Array.isArray(value)) return value.length ? <div className="space-y-1">{value.slice(0, 100).map((item, index) => <div key={index} className="border-l border-slate-200 pl-2"><AssistantData value={item} field={field} depth={depth + 1} /></div>)}{value.length > 100 && <p>共 {value.length} 项，这里显示前 100 项；可在对应页面查看全部。</p>}</div> : <span>暂无</span>;
  if (typeof value === 'object') return <dl className="space-y-1">{Object.entries(value).filter(([key]) => !/key|token|secret|password|credential/i.test(key)).map(([key, item]) => <div key={key}><dt className="text-slate-500">{fieldLabels[key] ?? key}</dt><dd className="pl-2"><AssistantData value={item} field={key} depth={depth + 1} /></dd></div>)}</dl>;
  return null;
}

function Result({ result, epoch }: { result: AssistantResult; epoch: string }) {
  const nav = useNavigate();
  const [error, setError] = useState('');
  const download = async (href: string) => {
    setError('');
    try {
      const response = await fetch(href, { headers: { 'X-ClassRep-Account-Epoch': epoch }, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`下载失败（${response.status}）`);
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = href.includes('backup') ? 'ClassRep.classrep-backup' : 'ClassRep.ics'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <div className={`mt-2 rounded-lg border p-2 text-xs ${result.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
    <p className="font-medium">{result.requiresUser ? '需要你操作' : result.ok ? '服务端已确认' : '未完成'}</p>
    <p className="whitespace-pre-wrap">{result.message}</p>
    {result.data !== undefined && <details className="mt-2"><summary className="cursor-pointer">查看返回内容</summary><div className="mt-2 max-h-64 overflow-auto"><AssistantData value={result.data} /></div></details>}
    {result.href && pageLinks.has(result.href) && <button className={`${buttonClass} mt-2`} onClick={() => nav(result.href!)}>前往相应页面</button>}
    {result.href && downloadLinks.has(result.href) && <button className={`${buttonClass} mt-2`} onClick={() => void download(result.href!)}>下载到本机</button>}
    {result.tool === 'settings.pet.image' && result.requiresUser && <button className={`${buttonClass} mt-2`} onClick={() => window.dispatchEvent(new Event('classrep:pet-open-settings'))}>打开桌宠形象设置</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

/** User text may propose actions, but only the explicit confirmation button can execute a plan. */
type PanelProps = { epoch: string; style?: string; onClose: () => void; notices?: readonly { id: number; text: string }[] };
export default function AssistantPanel(props: PanelProps) { return <AssistantPanelBody key={props.epoch} {...props} />; }
function AssistantPanelBody({ epoch, style, onClose, notices = [] }: PanelProps) {
  const [tab, setTab] = useState<'chat' | 'memory' | 'capabilities'>('chat');
  const [entries, setEntries] = useState<Entry[]>([{ id: 0, role: 'bot', text: '我是课代表小助手。可以查询日程、完成事项、调整设置或保存长期偏好。修改前会展示计划，只有你点击确认才执行。', context: false }]);
  const [capabilities, setCapabilities] = useState<AssistantCapability[]>([]);
  const [plan, setPlan] = useState<AssistantPlan>();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const operation = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const session = useRef<Promise<unknown> | null>(null);
  const mounted = useRef(true);
  const nextId = useRef(1);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void assistantRequest<{ capabilities: AssistantCapability[] }>(epoch, '/api/assistant/capabilities', 'GET', undefined, abort.signal).then(data => { if (!abort.signal.aborted) setCapabilities(data.capabilities); }).catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); clearInterval(timer); };
  }, [epoch]);
  useEffect(() => { list.current?.scrollTo?.({ top: list.current.scrollHeight }); }, [entries, plan, busy]);
  function append(reply: AssistantReply) { setEntries(prev => [...prev, { id: nextId.current++, role: 'bot', text: reply.text, results: reply.results }]); setPlan(reply.plan); }
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    const abort = new AbortController(); controller.current = abort;
    try { await work(abort.signal); }
    catch (e) { if (mounted.current && !abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current) setBusy(false); operation.current = false; }
  }
  function send(raw: string) {
    const message = raw.trim(); if (!message || operation.current || plan) return;
    setTab('chat'); setDraft('');
    const history = entries.filter(entry => entry.context !== false && !entry.results).slice(-8).map(({ role, text }) => ({ role, text: text.slice(0, 2000) }));
    setEntries(prev => [...prev, { id: nextId.current++, role: 'user', text: message }]);
    void run(async signal => {
      if (!session.current) session.current = assistantRequest(epoch, '/api/assistant/session', 'POST', {}, signal).catch(e => { session.current = null; throw e; });
      await session.current;
      const reply = await assistantRequest<AssistantReply>(epoch, '/api/assistant/chat', 'POST', { message, history, style }, signal);
      if (mounted.current && !signal.aborted) append(reply);
    });
  }
  function decide(confirm: boolean) {
    if (!plan || operation.current) return;
    const id = plan.id;
    void run(async signal => {
      if (confirm) {
        const reply = await assistantRequest<AssistantReply>(epoch, `/api/assistant/plans/${encodeURIComponent(id)}/confirm`, 'POST', { confirmed: true }, signal);
        if (mounted.current && !signal.aborted) {
          const results = reply.results?.map(result => {
            if (!result.browserAction) return result;
            const action = result.browserAction;
            const authorized = plan.actions.some(candidate => candidate.tool === 'settings.pet' && Object.keys(candidate.args).length === Object.keys(action.patch).length && Object.entries(candidate.args).every(([key, value]) => action.patch[key as keyof typeof action.patch] === value));
            if (!result.ok || result.tool !== 'settings.pet' || action.kind !== 'pet_settings' || !authorized) return { ...result, ok: false, message: '浏览器操作与已确认计划不符，未应用本地设置。' };
            try { applyPetAssistantSettings(action.patch); return { ...result, message: '本浏览器的桌宠设置已保存并应用（各空间共用外观）。不会修改其他设备。' }; }
            catch (error) { return { ...result, ok: false, message: error instanceof Error ? error.message : '本地桌宠设置未能保存' }; }
          });
          append({ ...reply, results }); window.dispatchEvent(new Event('classrep:resumed'));
        }
      } else {
        await assistantRequest(epoch, `/api/assistant/plans/${encodeURIComponent(id)}/cancel`, 'POST', {}, signal);
        if (mounted.current && !signal.aborted) { setPlan(undefined); setEntries(prev => [...prev, { id: nextId.current++, role: 'bot', text: '已取消这次计划，没有执行其中的操作。', context: false }]); }
      }
    });
  }
  return <div role="dialog" aria-label="课代表小助手" className="pet-pop flex max-h-[min(680px,85vh)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl" onPointerDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}>
    <div className="flex items-center justify-between border-b bg-slate-50 px-3 py-2"><div><p className="text-sm font-medium">课代表小助手</p><p className="text-[11px] text-slate-500">使用你在设置中配置的 LLM · 当前空间</p></div><button aria-label="关闭助手" className={buttonClass} onClick={onClose}>✕</button></div>
    <nav className="flex gap-2 border-b px-3 py-2" aria-label="助手面板"><button aria-pressed={tab === 'chat'} className={buttonClass} onClick={() => setTab('chat')}>对话</button><button aria-pressed={tab === 'memory'} className={buttonClass} onClick={() => setTab('memory')}>长期记忆</button><button aria-pressed={tab === 'capabilities'} className={buttonClass} onClick={() => setTab('capabilities')}>我能做什么</button></nav>
    {error && <p role="alert" className="px-3 py-2 text-sm text-red-700">{error}</p>}
    {tab === 'memory' && <div className="overflow-y-auto"><AssistantMemories key={epoch} epoch={epoch} /></div>}
    {tab === 'capabilities' && <div className="space-y-2 overflow-y-auto p-3 text-sm"><p className="text-xs text-slate-500">以下来自服务器实际工具列表。账号登录、凭证、文件选择等需要你亲自在对应页面完成；助手不会读取密钥或代替你授权。</p>{capabilities.map(capability => <article key={capability.name} className="rounded-lg border p-2"><p className="font-medium">{capability.label}</p><p className="text-xs text-slate-500">{policyLabel[capability.policy]} · {capability.description}</p></article>)}{!capabilities.length && <p>暂时未能读取能力列表。</p>}</div>}
    {tab === 'chat' && <>
      <div ref={list} className="min-h-24 space-y-3 overflow-y-auto p-3 text-sm" aria-live="polite">
        {notices.slice(-2).map(notice => <p key={notice.id} className="rounded bg-amber-50 p-2 text-xs text-amber-800">{notice.text}</p>)}
        {entries.map(entry => <div key={entry.id} className={`rounded-xl p-2.5 ${entry.role === 'user' ? 'ml-8 bg-slate-900 text-white' : 'mr-3 bg-slate-50 text-slate-800'}`}><p className="whitespace-pre-wrap break-words">{entry.text}</p>{entry.results?.map((result, index) => <Result key={index} result={result} epoch={epoch} />)}</div>)}
        {busy && <p role="status">正在处理，请稍候。关闭面板不会撤销已经确认的操作。</p>}
        {plan && <section aria-label="待确认操作" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3"><p className="font-medium">操作预览 · 当前空间</p><p>{plan.summary}</p>{plan.actions.some(action => action.tool === 'settings.pet') && <p className="text-xs">桌宠外观和显示设置由本浏览器的各空间共用；不会修改其他设备。</p>}{plan.actions.map((action, index) => <div key={index} className="rounded-lg border border-amber-200 bg-white p-2"><p>{index + 1}. {action.label}</p><p className="text-xs text-amber-800">{policyLabel[action.policy]}</p><div className="mt-2 max-h-48 overflow-auto text-xs"><AssistantData value={action.args} /></div></div>)}<p className="text-xs">{now >= plan.expiresAt ? '计划已过期，请取消后重新描述。' : '请核对对象和修改内容；回复“确认”不会执行，请点击下面按钮。'}</p><div className="flex gap-2"><button disabled={busy || now >= plan.expiresAt} className="rounded-lg bg-indigo-700 px-3 py-2 text-xs text-white disabled:opacity-50" onClick={() => decide(true)}>确认执行这些操作</button><button disabled={busy} className={buttonClass} onClick={() => decide(false)}>取消计划</button></div></section>}
      </div>
      {!plan && <div className="flex flex-wrap gap-1 px-3 pb-2">{examples.map(example => <button disabled={busy} className={buttonClass} key={example} onClick={() => example.includes('操作的功能') ? setTab('capabilities') : send(example)}>{example}</button>)}</div>}
      <form className="flex gap-2 border-t p-2" onSubmit={e => { e.preventDefault(); send(draft); }}><input aria-label="给助手的消息" maxLength={2000} disabled={busy || !!plan} className="min-w-0 flex-1 rounded-lg border px-2 py-2 text-sm disabled:bg-slate-100" placeholder={plan ? '请先确认或取消计划' : '描述你想完成的事情…'} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') onClose(); }} /><button type="submit" disabled={busy || !!plan || !draft.trim()} className="rounded-lg bg-slate-900 px-3 text-sm text-white disabled:opacity-50">发送</button></form>
    </>}
  </div>;
}
