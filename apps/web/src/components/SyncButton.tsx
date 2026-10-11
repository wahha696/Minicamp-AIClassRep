import { useEffect, useRef, useState } from 'react';
import type { HistoryJobDTO } from '../../../../shared/history-jobs';
import { getHealth } from '../api/client';
import { cancelHistoryJob, getHistoryJobs, retryHistoryJob, startHistoryJob } from '../api/history-jobs';
import { errorText } from '../lib/errors';
import { historyError, historyPlatform, historyProgress, historyRunning, type HistoryDays } from '../lib/historySync';
import { trackStep } from '../lib/syncTrack';
import { useAccess, useConnectStatus } from './ConnectStatus';

const OPTIONS: HistoryDays[] = [1, 7, 30];
const POLL_MS = 3_000;

export default function SyncButton() {
  const { data: conn } = useConnectStatus();
  const { readonly } = useAccess();
  const epoch = conn?.account_epoch;
  const scope = useRef(epoch);
  scope.current = epoch;
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<HistoryJobDTO[]>([]);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [processingNote, setProcessingNote] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const mounted = useRef(true);
  const actionLock = useRef(false);
  const controlSequence = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const running = jobs.some(historyRunning);
  const online = conn?.state === 'online' || conn?.wechat === 'collecting';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  useEffect(() => {
    setJobs([]); setReady(false); setConnectionError(null); setActionError(null);
    setPending(null); setProcessingNote(null); setHidden(false);
    if (!epoch || readonly) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (actionLock.current) return;
        const sequence = controlSequence.current;
        const result = await getHistoryJobs(epoch);
        if (!alive || sequence !== controlSequence.current) return;
        // A control response can be newer than an already in-flight status read.
        setJobs(previous => result.jobs.map(job => {
          const known = previous.find(item => item.id === job.id);
          return known && known.updated_at > job.updated_at ? known : job;
        }));
        setReady(true); setConnectionError(null); setActionError(null);
        if (result.jobs.some(job => job.messages > 0)) {
          const health = await getHealth().catch(() => null);
          if (!alive) return;
          const step = trackStep({ total: 0, base: 0, startedAt: 0, fails: 0 }, health, Date.now());
          if (step.kind === 'progress') {
            if (step.left >= 0) setPending(step.left);
            setProcessingNote(step.message ?? null);
          } else {
            setPending(step.kind === 'done' ? 0 : health?.pending ?? null);
            setProcessingNote(step.kind === 'stop' ? step.message : null);
          }
        }
      } catch (error) {
        if (alive) { setConnectionError(errorText(error)); setReady(false); }
      } finally {
        if (alive) timer = setTimeout(() => void poll(), POLL_MS);
      }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [epoch, readonly]);

  const accept = (job: HistoryJobDTO) => setJobs(previous => [...previous.filter(item => item.platform !== job.platform), job]);

  async function start(days: HistoryDays) {
    if (!epoch || !ready || running || actionLock.current) return;
    actionLock.current = true; setWorking(true); setOpen(false); setHidden(false); setActionError(null);
    controlSequence.current++;
    const requestEpoch = epoch;
    try {
      const platforms = [conn?.state === 'online' ? 'qq' as const : null, conn?.wechat === 'collecting' ? 'wechat' as const : null]
        .filter((platform): platform is 'qq' | 'wechat' => platform !== null);
      const results = await Promise.allSettled(platforms.map(platform => startHistoryJob(requestEpoch, platform, days)));
      if (!mounted.current || scope.current !== requestEpoch) return;
      const errors: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') accept(result.value.job);
        else errors.push(`${platforms[index] === 'qq' ? 'QQ' : '微信'}：${errorText(result.reason)}`);
      });
      if (errors.length) { setActionError(errors.join('；')); setReady(false); }
    } finally {
      actionLock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  async function control(job: HistoryJobDTO, action: 'cancel' | 'retry') {
    if (!epoch || actionLock.current || !ready) return;
    actionLock.current = true; setWorking(true); setActionError(null); setHidden(false);
    controlSequence.current++;
    const requestEpoch = epoch;
    try {
      const result = await (action === 'cancel' ? cancelHistoryJob : retryHistoryJob)(requestEpoch, job.id);
      if (mounted.current && scope.current === requestEpoch) accept(result.job);
    } catch (error) {
      if (mounted.current && scope.current === requestEpoch) { setActionError(errorText(error)); setReady(false); }
    } finally {
      actionLock.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  if (readonly) return null;
  const showPanel = !hidden && (jobs.length > 0 || connectionError || actionError);
  return <div ref={rootRef} className="relative shrink-0">
    <button type="button" aria-label="补拉历史消息" aria-expanded={open} disabled={!online || working || running || !ready}
      title={running ? '后台正在补拉，可查看进度或停止后续补拉' : online ? '补回已开启监听的群的历史消息' : '请先连接 QQ 或开启微信群监听'}
      onClick={() => setOpen(value => !value)}
      className="flex h-9 items-center gap-1.5 rounded-md px-1.5 text-xs text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50">
      <svg viewBox="0 0 24 24" className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
      </svg>
      <span className="hidden sm:inline">{running ? '补拉中…' : '补拉历史'}</span>
      {pending !== null && pending > 0 && <span title="全部启用群的待整理数，实时新消息进入时可能增加" className="rounded-full bg-blue-100 px-1.5 text-blue-700">全局待整理 {pending}</span>}
    </button>
    {hidden && jobs.length > 0 && <button type="button" className="text-xs underline" onClick={() => setHidden(false)}>查看补拉结果</button>}
    {showPanel && <div role="status" className="fixed inset-x-3 top-16 z-40 max-h-[70vh] overflow-auto rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-lg sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-1 sm:w-80">
      {(connectionError || actionError) && <p role="alert" className="mb-2 text-amber-800">{connectionError || actionError} 后台任务状态以重连后的进度为准。</p>}
      {connectionError && jobs.length > 0 && <p className="mb-2">以下为最后确认的进度，连接恢复后会自动更新。</p>}
      {jobs.map(job => <section key={job.id} aria-label={`${historyPlatform(job)} 补拉进度`} className="mb-2 border-b border-slate-100 pb-2 last:border-0">
        <p aria-live="polite">{historyProgress(job)}</p>
        {job.platform === 'qq' && job.status === 'running' && job.waiting_since != null && <p className="mt-1 text-amber-800" aria-live="polite">
          QQ 尚未返回当前页，处理状态未知；正在继续等待原请求，已存进度保留，可以取消。无需重新补拉。
        </p>}
        {job.current_group_id && historyRunning(job) && <p className="mt-1 break-all">当前群：{job.current_group_id}，正在读取第 {(job.groups.find(group => group.group_id === job.current_group_id)?.pages ?? 0) + 1} 页</p>}
        {job.error && <p className="mt-1 text-amber-800">原因：{historyError(job.error)}</p>}
        {job.groups.filter(group => group.error).map(group => <p key={group.group_id} className="mt-1 break-all text-amber-800">{group.group_id}：{historyError(group.error!)}</p>)}
        {job.status === 'cancelling' && <p className="mt-1">{job.platform === 'qq'
          ? '正在取消等待，保留已保存进度。'
          : '当前页保存后停止，已补入记录保留。'}</p>}
        {job.status === 'running' && <button type="button" disabled={working || !ready} onClick={() => void control(job, 'cancel')} className="mt-1 underline disabled:opacity-50">停止 {historyPlatform(job)} 后续补拉</button>}
        {job.status === 'running' && <p className="mt-1 text-slate-400">{job.platform === 'qq'
          ? '停止会取消当前等待，保留已保存进度。'
          : '停止会在当前页保存后生效。'}</p>}
        {!historyRunning(job) && job.retryable && <><p className="mt-1">已补入记录保留；重试会恢复未完成部分，重复消息自动去重。</p><button type="button" disabled={working || !ready || running} onClick={() => void control(job, 'retry')} className="mt-1 underline disabled:opacity-50">恢复 {historyPlatform(job)} 补拉</button></>}
      </section>)}
      {running && <p>耗时取决于记录量；可以切换页面或刷新，回来后会重新连接进度。</p>}
      {processingNote && <p className="mt-1">{processingNote}</p>}
      {pending === 0 && jobs.some(job => job.messages > 0) && <p className="mt-1">全部启用群当前没有待整理消息。</p>}
      {!running && <button type="button" aria-label="关闭补拉结果" className="mt-2 underline" onClick={() => setHidden(true)}>收起结果</button>}
    </div>}
    {open && <div className="absolute right-0 top-full z-40 mt-1 w-60 rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
      <p className="px-3 pb-1 pt-2 text-xs text-slate-400">只补回已开启监听的 QQ 群和微信群。微信只能读取已同步到电脑的记录。任务在后台持续执行，可停止和恢复。</p>
      {OPTIONS.map(days => <button key={days} type="button" onClick={() => void start(days)} className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">补回最近 {days} 天{days === 30 && <span className="ml-1 text-xs text-slate-400">消息多时消耗较多 AI 额度</span>}</button>)}
    </div>}
  </div>;
}
