import { useEffect, useRef, useState } from 'react';
import type { WechatIntakeDTO, WechatIssueDTO } from '../../../../shared/wechat';
import { getWechatIntake, getWechatIssues, retryWechatIssues } from '../api/client';

const issueText: Record<string, string> = {
  DELIVERY_MESSAGE_TYPE_UNSUPPORTED: '暂不支持的图片、语音或其他消息',
  DELIVERY_COMPRESSED_FIELD_UNSUPPORTED: '消息压缩格式暂不支持',
  DELIVERY_TEXT_NOT_DECODED: '文字尚未成功解码',
  DELIVERY_TEXT_CONFLICT: '文字字段不一致，需核对',
  DELIVERY_TEXT_INVALID: '文字编码暂不支持',
  DELIVERY_TEXT_LIMIT: '文字过长，暂未整理',
  DELIVERY_MESSAGE_METADATA_INVALID: '消息时间或来源需核对',
  DELIVERY_NAMES_UNAVAILABLE: '群名或成员信息暂不可用',
};
const failures: Record<string, string> = {
  WECHAT_MESSAGE_ZSTD_PACKAGE_UNAVAILABLE: '微信文字解码组件缺失，请更新或重新安装课代表，原有消息保留。',
  WECHAT_MESSAGE_ZSTD_PACKAGE_VERSION_UNSUPPORTED: '微信文字解码组件版本不匹配，请更新课代表，原有消息保留。',
  WECHAT_MESSAGE_LOCAL_RECEIPT_NOT_INITIALIZED: '保存的读取进度缺失，已停止，避免自动跳过消息。',
  WECHAT_MESSAGE_LOCAL_RECEIPT_ACTIVATION_MISMATCH: '选群状态与读取进度不一致，原有消息已保留。',
  WECHAT_MESSAGE_MESSAGE_SOURCE_UNAVAILABLE: '当前微信状态或版本无法读取，请核对电脑微信后重试。',
  WECHAT_MESSAGE_SELECTED_GROUP_NOT_FOUND: '电脑上还没有这个群的消息记录，请先在微信中确认群消息已同步。',
  WECHAT_MESSAGE_NOT_CURRENT: '账号或空间已变化，请重新确认所选群。',
};
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:opacity-40';

/** Local parent supplies the verified saved selection. Mounting only polls our
 * status; no source, history, AI or message storage starts without an action.
 */
export default function WechatMessagesPanel({ epoch, connectionId, groups }: {
  epoch: string; connectionId: string; catalogId: string;
  groups: { group_id: string; name: string | null }[]; selectionDirty: boolean;
}) {
  const [status, setStatus] = useState<WechatIntakeDTO | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [statusError, setStatusError] = useState('');
  const [group, setGroup] = useState(groups[0]?.group_id ?? '');
  const [issues, setIssues] = useState<WechatIssueDTO[]>([]);
  const alive = useRef(true), serial = useRef(0), reading = useRef<Promise<void> | null>(null);
  const statusId = useRef<string | null>(null);
  async function read() {
    const next = await getWechatIntake();
    if (!alive.current) return;
    setStatusError('');
    if (next.scope && (next.scope.account_epoch !== epoch || next.scope.connection_id !== connectionId)) {
      ++serial.current; statusId.current = null; setStatus(null); setIssues([]);
      setError('微信连接已变化，请刷新群管理；若仍未连接，请到连接页重新连接微信。'); return;
    }
    if (statusId.current !== next.intake_id) {
      ++serial.current; setIssues([]); statusId.current = next.intake_id;
    }
    setStatus(next);
  }
  function load() {
    if (reading.current) return reading.current;
    const pending = read(); reading.current = pending;
    void pending.finally(() => { if (reading.current === pending) reading.current = null; }).catch(() => {});
    return pending;
  }
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await load(); }
      catch (caught) { if (alive.current) { setStatus(null); setStatusError(caught instanceof Error ? caught.message : '采集状态暂不可用。'); } }
      if (alive.current) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { alive.current = false; ++serial.current; clearTimeout(timer); };
  }, []);
  async function act(work: () => Promise<void>) {
    const ticket = serial.current;
    setBusy(true); setError(''); setNotice('');
    try { await work(); if (alive.current) await load(); }
    catch (caught) { if (alive.current && ticket === serial.current) setError(caught instanceof Error ? caught.message : '操作未完成，原有消息保留。'); }
    finally { if (alive.current) setBusy(false); }
  }
  const context = status?.intake_id ? { expected_account_epoch: epoch, intake_id: status.intake_id } : null;
  const running = status?.collecting === true;
  const deferred = status?.groups.reduce((sum, row) => sum + row.deferred, 0) ?? 0;
  const pending = status?.groups.reduce((sum, row) => sum + row.pending, 0) ?? 0;
  const issueCounts = new Map<string, number>();
  for (const issue of issues) issueCounts.set(issue.reason, (issueCounts.get(issue.reason) ?? 0) + 1);
  return <section className="space-y-3 border-t border-slate-100 pt-4">
    <h3 className="text-sm font-semibold text-slate-900">监听状态</h3>
    <p role="status" className="text-sm text-slate-600">{!status ? statusError ? '暂时无法确认采集状态，正在重新核对。' : '正在核对采集状态…' : status.state === 'opening' ? '正在准备读取…'
      : running ? `正在监听 ${status.groups.length} 个群，待入库 ${pending} 条。` : '未监听微信群，原有消息和进度保留。'}</p>
    {status?.last_received_at && <p className="text-xs text-slate-500">最近入库：{new Date(status.last_received_at).toLocaleString('zh-CN')}</p>}
    {status?.error && <p role="alert" className="text-sm text-rose-600">{failures[status.error] ?? '微信采集已停止，原有消息和进度保留，请检查连接后重试。'}</p>}
    <details className="text-xs text-slate-500">
      <summary className="cursor-pointer">采集与补收规则</summary>
      <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed">
        <li>首次从启用时开始，不自动读取历史。</li>
        <li>暂停或程序重启后，按已保存进度补收。</li>
        <li>取消群后再启用，从当时开始；停用期间的记录可用页面顶部的「补拉历史」补回。</li>
      </ul>
    </details>
    {deferred > 0 && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">有 {deferred} 条消息暂未支持或解码，已保留，不影响正常文字整理。</p>}
    {running && context && <>
      <details className="rounded-xl border border-slate-200 p-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-700">未整理消息</summary>
      <div className="mt-3 space-y-3">
      <label className="block space-y-1 text-sm">要管理的微信群
        <select aria-label="要管理的微信群" className="block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2 text-sm" value={group} disabled={busy}
          onChange={(event) => { setGroup(event.target.value); setIssues([]); }}>
          {groups.map((row) => <option key={row.group_id} value={row.group_id}>{row.name || '未命名群'}（{row.group_id}）</option>)}
        </select></label>
      <button className={button} disabled={busy || !group} onClick={() => void act(async () => {
        const ticket = serial.current;
        const rows = await getWechatIssues({ ...context, group_id: group });
        if (alive.current && ticket === serial.current) { setIssues(rows); if (!rows.length) setNotice('这个群没有待重试的消息。'); }
      })}>查看暂未整理的消息</button>
      {!!issues.length && <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm">
        <ul className="space-y-1">{[...issueCounts].map(([reason, count]) => <li key={reason} className="flex items-start justify-between gap-3">
          <span>{issueText[reason] ?? '待重试的消息'}</span><span className="shrink-0 text-xs">{count} 条</span>
        </li>)}</ul>
        <button className={button} disabled={busy} onClick={() => void act(async () => {
          await retryWechatIssues({ ...context, group_id: group, event_ids: issues.map((row) => row.event_id) });
          if (alive.current) { setIssues([]); setNotice('已安排重试；仍不支持的消息继续保留。'); }
        })}>重试以上消息</button>
        <p className="text-xs text-slate-500">每批最多 100 条。只重试解码，不自动识图或转写；成功后按 AI 配置整理。</p>
      </div>}
      </div></details>
    </>}
    {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}
    {statusError && <p role="alert" className="text-sm text-rose-600">{statusError}</p>}
    {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
  </section>;
}
