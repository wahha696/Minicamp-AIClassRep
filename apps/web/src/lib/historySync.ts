// History reads belong to the server. Navigating away only detaches this observer.
import type { HistoryJobDTO } from '../../../../shared/history-jobs';

export type HistoryDays = 1 | 7 | 30;
export function historyError(code: string): string {
  const messages: Record<string, string> = {
    HISTORY_PAGE_UNAVAILABLE: '当前页未能读取，请检查 QQ 连接后恢复补拉',
    HISTORY_CURSOR_STALLED: '记录游标未前进，已暂停以避免重复读取，请检查客户端后恢复',
    HISTORY_INVALID_PAGE: '客户端返回的记录格式异常，请检查客户端后恢复',
    HISTORY_SCOPE_CHANGED: '账号或空间已变化，请回到原空间并确认监听后恢复',
    HISTORY_INTERRUPTED: '后台曾重启，已保存进度，请恢复未完成部分',
    HISTORY_WECHAT_UNAVAILABLE: '微信当前无法读取，请检查连接和群监听后恢复',
    HISTORY_STORAGE_FAILED: '记录保存失败，请检查本机磁盘后恢复',
  };
  return messages[code] ?? code;
}
export function historyRunning(job: HistoryJobDTO): boolean {
  return job.status === 'running' || job.status === 'cancelling';
}
export function historyPlatform(job: HistoryJobDTO): string {
  return job.platform === 'qq' ? 'QQ' : '微信';
}
export function historyStatus(job: HistoryJobDTO): string {
  const labels: Record<HistoryJobDTO['status'], string> = {
    running: '补拉中', cancelling: '正在停止后续补拉', cancelled: '已取消',
    completed: '补拉完成', failed: '部分记录未补全', interrupted: '后台重启后中断',
  };
  return labels[job.status];
}
/** Never estimate a percentage from message count; the full history size is unknown. */
export function historyProgress(job: HistoryJobDTO): string {
  return `${historyPlatform(job)} ${historyStatus(job)} · 已补入 ${job.messages} 条 · 已完成 ${job.groups_completed}/${job.groups_total} 群 · 已读取 ${job.pages} 页`;
}
