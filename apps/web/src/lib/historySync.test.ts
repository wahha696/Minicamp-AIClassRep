import { expect, it } from 'vitest';
import type { HistoryJobDTO } from '../../../../shared/history-jobs';
import { historyProgress, historyRunning, historyStatus } from './historySync';
const job: HistoryJobDTO = { id: 'mock', platform: 'qq', days: 30, status: 'running', created_at: 0, updated_at: 0,
  groups_total: 4, groups_completed: 1, pages: 29, messages: 213, current_group_id: null, error: null, retryable: false, groups: [] };
it('报告服务端已入库条数、页数、成功群，不估算未知总量', () => {
  expect(historyProgress(job)).toBe('QQ 补拉中 · 已补入 213 条 · 已完成 1/4 群 · 已读取 29 页');
});
it('取消请求未完成前仍视为运行，失败与中断不误报成功', () => {
  expect(historyRunning({ ...job, status: 'cancelling' })).toBe(true);
  expect(historyRunning({ ...job, status: 'cancelled' })).toBe(false);
  expect(historyStatus({ ...job, status: 'failed' })).toBe('部分记录未补全');
  expect(historyStatus({ ...job, status: 'interrupted' })).toBe('后台重启后中断');
});
