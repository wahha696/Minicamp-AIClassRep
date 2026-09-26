// 流水线的内存状态：extract 写，index.ts 的 getPipelineStats 读。
// filtered_count 不在这里，它直接从库里 COUNT。
import type { PipelineStats } from '../types.js';

export const llmStats: { llm: PipelineStats['llm']; called: number } = {
  llm: 'unconfigured',
  called: 0,
};
