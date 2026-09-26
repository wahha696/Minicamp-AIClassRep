// 流水线的内存状态：extract 写，index.ts 的 getPipelineStats 读。
// filtered_count 不在这里，它直接从库里 COUNT。
import type { PipelineStats } from '../types.js';

/** llm：最近一次调用的结果；配了 key 但还没调用过算 ok（没配 key 由 getPipelineStats 报 unconfigured） */
export const llmStats: { llm: PipelineStats['llm']; called: number; failed: number } = {
  llm: 'ok',
  called: 0,
  failed: 0, // 累计连不上 AI 的次数；调度器靠它判断这批要不要留着重试
};

export const jevStats: { state: 'ok' | 'error'; called: number; filtered: number } = {
  state: 'ok',
  called: 0,
  filtered: 0,
};
