// 流水线入口（规则过滤 → LLM 提取 → Reconcile）。主人是 C。
// B0 只给能编译的空实现。
import type { PipelineStats } from '../types.js';

/** 调度器：自己轮询 messages.processed=0，别人入库后不需要通知它。实现见 C。 */
export function startScheduler(): void {
  // 空实现
}

/** 立即跑一批（演示回放后调用）。实现见 C。 */
export async function runPipelineNow(): Promise<void> {
  // 空实现
}

/** 累计统计，给 /health 用。实现见 C。 */
export function getPipelineStats(): PipelineStats {
  return { filtered_count: 0, llm_called_count: 0, llm: 'unconfigured' };
}
