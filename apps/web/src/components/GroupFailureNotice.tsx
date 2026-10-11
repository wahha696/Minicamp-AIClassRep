import type { GroupProcessingFailureDTO, ProcessingFailureReason } from '../api/types';

const REASONS: Record<ProcessingFailureReason, string> = {
  unconfigured: '还没有配置 AI，请先到设置页完成配置。',
  network: '暂时连接不上 AI 服务。',
  authentication: 'AI 服务拒绝了当前密钥，请检查设置。',
  rate_limit: 'AI 服务请求受限，请检查额度或稍后再试。',
  invalid_output: 'AI 返回的内容格式不正确，未完成整理。',
  truncated: 'AI 返回的内容被截断，未完成整理。',
  storage: '无法保存整理结果，请检查电脑磁盘和文件权限。',
  processing: '整理过程中出现异常。',
};

export default function GroupFailureNotice({ failure, enabled, readonly, busy, onRetry }: {
  failure: GroupProcessingFailureDTO;
  enabled: boolean;
  readonly: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  const retryTime = failure.next_retry_at ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(failure.next_retry_at)) : null;

  return (
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-900" role="status">
      <p className="font-medium">
        {!enabled ? '已关闭监听，待处理消息尚未整理'
          : failure.paused ? `连续失败 ${failure.failed_attempts} 次，已暂停自动整理`
          : failure.failed_attempts === 0 ? '已恢复，等待重新整理' : '整理未完成，消息已保留'}
      </p>
      <p>{failure.failed_attempts > 0 && REASONS[failure.reason]}还有 {failure.pending_count} 条消息待整理。</p>
      {failure.state_saved === false && <p>暂停状态暂时无法保存，重启后可能再次尝试。请检查磁盘空间和文件权限。</p>}
      {enabled && !failure.paused && retryTime && <p>预计 {retryTime} 后自动重试，其他群继续整理。</p>}
      {readonly ? <p>请在电脑上重试或修改 AI 配置。</p> : (
        <button type="button" onClick={onRetry} disabled={busy || !enabled || failure.failed_attempts === 0}
          className="mt-1.5 rounded border border-amber-300 bg-white px-2 py-1 font-medium hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? '提交中…' : failure.failed_attempts === 0 ? '重试中…' : '重试整理'}
        </button>
      )}
    </div>
  );
}
