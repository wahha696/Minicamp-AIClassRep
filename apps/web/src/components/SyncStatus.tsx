import { getSyncStatus } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { formatWhen } from '../lib/time';
import ReadStatus from './ReadStatus';

export default function SyncStatus() {
  const result = usePolling(getSyncStatus, 10000);
  const incomplete = (result.data ?? []).filter(group => group.complete !== 1);
  return <section className="mt-6" aria-label="QQ 历史补齐结果">
    <ReadStatus error={result.error} cached={result.data !== undefined} lastSuccessAt={result.lastSuccessAt} onRetry={() => void result.refresh()} />
    {incomplete.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <h2 className="font-semibold">{incomplete.length} 个 QQ 群历史可能未补全</h2>
      <ul className="mt-2 space-y-2">{incomplete.map(group => <li key={group.group_id}>
        <span className="font-medium">{group.name}</span>：{group.reason === 'page_cap' ? '消息较多，达到本次翻页上限' : group.reason === 'page_error' ? '读取历史时发生错误' : '补齐未完成'}
        <p className="text-xs">最近同步 {formatWhen(group.last_sync_at)}{group.oldest_at === null ? '' : `；本次最早读到 ${formatWhen(group.oldest_at)}`}</p>
      </li>)}</ul>
      <p className="mt-2 text-xs">可稍后重试或缩小范围；达到翻页上限时，重复刷新同一范围未必能补到更早记录。微信补读结果在群管理的微信群中查看。</p>
    </div>}
  </section>;
}
