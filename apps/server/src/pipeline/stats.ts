// 流水线的内存状态：extract 写，index.ts 的 getPipelineStats 读。
// filtered_count 不在这里，它直接从库里 COUNT。
import type { PipelineStats } from '../types.js';

/** llm：最近一次调用的结果；配了 key 但还没调用过算 ok（没配 key 由 getPipelineStats 报 unconfigured） */
export const llmStats: { llm: PipelineStats['llm']; called: number; failed: number; lastMs: number } = {
  llm: 'ok',
  called: 0,
  failed: 0, // 累计连不上 AI 的次数；调度器靠它判断这批要不要留着重试
  lastMs: 0, // 最近一次成功调用耗时
};

export const jevStats: { state: 'ok' | 'error'; called: number; filtered: number; lastMs: number } = {
  state: 'ok',
  called: 0,
  filtered: 0,
  lastMs: 0, // 最近一次成功调用耗时
};

/** 换号时清零（修复计划第一节：计数和状态不跨账号携带） */
export function resetPipelineStats(): void {
  llmStats.llm = 'ok';
  llmStats.called = 0;
  llmStats.failed = 0;
  llmStats.lastMs = 0;
  jevStats.state = 'ok';
  jevStats.called = 0;
  jevStats.filtered = 0;
  jevStats.lastMs = 0;
}
