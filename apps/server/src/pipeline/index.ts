// 流水线对外的三个函数（00-总约定.md §6）。实现在 scheduler.ts / extract.ts。
import { db } from '../db/index.js';
import { getJevConfig, getLlmConfig } from '../ai-settings.js';
import type { PipelineStats } from '../types.js';
import { jevStats, llmStats } from './stats.js';

export { runPipelineNow, startScheduler } from './scheduler.js';

/**
 * includeAccountData=false 用于账号库切换/挂载失败时的公开健康检查：不能查询仍挂着的旧库，
 * 也不能把旧账号留在内存里的调用计数暴露给新会话。服务配置状态仍可安全报告。
 */
export function getPipelineStats(includeAccountData = true): PipelineStats {
  let filtered = 0;
  if (includeAccountData) {
    try {
      filtered = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE filtered_out = 1').get() as { n: number }).n;
    } catch {
      // 库没打开时 /health 照样能返回
    }
  }
  return {
    filtered_count: filtered,
    jev_filtered_count: includeAccountData ? jevStats.filtered : 0,
    jev_called_count: includeAccountData ? jevStats.called : 0,
    llm_called_count: includeAccountData ? llmStats.called : 0,
    llm: !getLlmConfig().apiKey ? 'unconfigured' : includeAccountData ? llmStats.llm : 'ok',
    jev: !getJevConfig().enabled
      ? 'disabled'
      : !getJevConfig().apiKey
        ? 'unconfigured'
        : includeAccountData
          ? jevStats.state
          : 'ok',
  };
}
