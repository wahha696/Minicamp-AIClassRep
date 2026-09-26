// 流水线对外的三个函数（00-总约定.md §6）。实现在 scheduler.ts / extract.ts。
import { db } from '../db/index.js';
import { getLlmConfig } from '../llm-settings.js';
import { env } from '../env.js';
import type { PipelineStats } from '../types.js';
import { jevStats, llmStats } from './stats.js';

export { runPipelineNow, startScheduler } from './scheduler.js';

export function getPipelineStats(): PipelineStats {
  let filtered = 0;
  try {
    filtered = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE filtered_out = 1').get() as { n: number }).n;
  } catch {
    // 库没打开时 /health 照样能返回
  }
  return {
    filtered_count: filtered,
    jev_filtered_count: jevStats.filtered,
    jev_called_count: jevStats.called,
    llm_called_count: llmStats.called,
    llm: getLlmConfig().apiKey ? llmStats.llm : 'unconfigured',
    jev: !env.ENABLE_JEV ? 'disabled' : !env.TYPESAFE_API_KEY ? 'unconfigured' : jevStats.state,
  };
}
