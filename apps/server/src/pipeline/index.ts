// 流水线对外的三个函数（00-总约定.md §6）。实现在 scheduler.ts / extract.ts。
import { db } from '../db/index.js';
import { getJevConfig, getLlmConfig } from '../ai-settings.js';
import { env } from '../env.js';
import type { PipelineStats } from '../types.js';
import { localJevAvailable } from './jev-local.js';
import { jevStats, llmStats } from './stats.js';

export { runPipelineNow, startScheduler } from './scheduler.js';

function jevStatusLabel(): PipelineStats['jev'] {
  const cfg = getJevConfig();
  if (!cfg.enabled) return 'disabled';
  const mode = env.FASTJUDGE_MODE;
  if (mode === 'local') return localJevAvailable() ? jevStats.state : 'unconfigured';
  if (mode === 'dual') {
    if (!cfg.apiKey && !localJevAvailable()) return 'unconfigured';
    return jevStats.state;
  }
  return !cfg.apiKey ? 'unconfigured' : jevStats.state;
}

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
    jev: jevStatusLabel(),
  };
}
