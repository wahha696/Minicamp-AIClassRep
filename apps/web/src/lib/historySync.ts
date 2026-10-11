// 统一「补拉历史」：QQ 与微信只补拉当前已开启监听的群。
// QQ 走 /api/sync（后端只取 enabled 的 onebot 群）；微信取正在采集的群逐个翻页补齐，
// 某个群读取失败时后端会按保存进度重启采集并告知跳过，这里换用新的 intake_id 继续下一个群。
import { getWechatIntake, refreshWechatHistory, syncNow } from '../api/client';

export type HistoryDays = 1 | 7 | 30;
/** 单群翻页上限，防止异常情况下无限续页 */
export const WECHAT_MAX_PAGES = 200;

export interface WechatSkipped { group_id: string; reason: string }
export interface HistorySyncResult {
  qq: { groups: number; messages: number; failures: number } | null;
  wechat: { groups: number; messages: number; skipped: WechatSkipped[]; failed: boolean } | null;
  errors: { platform: 'QQ' | '微信'; error: unknown }[];
  cancelled?: true;
}

export type HistorySyncProgress =
  | { kind: 'qq_done' }
  | { kind: 'wechat_start'; total: number }
  | { kind: 'wechat_request'; completed: number; total: number; page: number; group_id: string }
  | { kind: 'wechat_page'; completed: number; total: number; page: number; messages: number }
  | { kind: 'wechat_group_done'; completed: number; total: number; messages: number; skipped: boolean };

async function syncWechat(days: HistoryDays, epoch: string, alive: () => boolean,
  out: { groups: number; messages: number; skipped: WechatSkipped[] },
  onProgress?: (progress: HistorySyncProgress) => void): Promise<boolean> {
  const intake = await getWechatIntake();
  if (!alive()) return false;
  if (!intake.collecting || !intake.intake_id) throw new Error('微信已停止监听，请恢复监听后重新补拉历史');
  if (intake.scope?.account_epoch !== epoch) throw new Error('微信连接或空间已变化，请重新确认监听状态后补拉');
  let intakeId = intake.intake_id;
  const total = intake.groups.length;
  onProgress?.({ kind: 'wechat_start', total });
  for (const [index, { group_id }] of intake.groups.entries()) {
    if (!alive()) break;
    const request = (continue_existing: boolean) => refreshWechatHistory({ expected_account_epoch: epoch, intake_id: intakeId,
      group_id, days, approve_history_read: true, continue_existing });
    let pageNumber = 1;
    onProgress?.({ kind: 'wechat_request', completed: index, total, page: pageNumber, group_id });
    let page = await request(false);
    while (true) {
      out.messages += page.inserted;
      onProgress?.({ kind: 'wechat_page', completed: index, total, page: pageNumber, messages: out.messages });
      if (page.skipped || !page.has_more || pageNumber >= WECHAT_MAX_PAGES || !alive()) break;
      pageNumber++;
      onProgress?.({ kind: 'wechat_request', completed: index, total, page: pageNumber, group_id });
      page = await request(true);
    }
    // Leaving the page or stopping the batch does not mean the page limit failed.
    if (!alive() && page.has_more && !page.skipped) break;
    const skipReason = page.skipped ?? (page.has_more ? 'WECHAT_HISTORY_PAGE_LIMIT' : null);
    if (skipReason) {
      out.skipped.push({ group_id, reason: skipReason });
      if (page.intake_id) intakeId = page.intake_id;
    } else out.groups += 1;
    onProgress?.({ kind: 'wechat_group_done', completed: index + 1, total, messages: out.messages, skipped: !!skipReason });
  }
  return true;
}

export async function syncAllHistory(days: HistoryDays, options: {
  epoch: string; qq: boolean; wechat: boolean; alive?: () => boolean;
  onProgress?: (progress: HistorySyncProgress) => void;
}): Promise<HistorySyncResult> {
  const alive = options.alive ?? (() => true);
  if (!alive()) return { qq: null, wechat: null, errors: [], cancelled: true };
  const wechatOut = { groups: 0, messages: 0, skipped: [] as WechatSkipped[] };
  const [qq, wechat] = await Promise.allSettled([
    options.qq ? syncNow(days).finally(() => options.onProgress?.({ kind: 'qq_done' })) : Promise.resolve(null),
    options.wechat ? syncWechat(days, options.epoch, alive, wechatOut, options.onProgress) : Promise.resolve(false),
  ]);
  const errors = [
    ...(qq.status === 'rejected' ? [{ platform: 'QQ' as const, error: qq.reason }] : []),
    ...(wechat.status === 'rejected' ? [{ platform: '微信' as const, error: wechat.reason }] : []),
  ];
  return {
    qq: qq.status === 'fulfilled' && qq.value ? { ...qq.value, failures: qq.value.failures ?? 0 } : null,
    wechat: wechat.status === 'rejected' ? { ...wechatOut, failed: true } : wechat.value ? { ...wechatOut, failed: false } : null,
    errors,
    ...(!alive() ? { cancelled: true as const } : {}),
  };
}
