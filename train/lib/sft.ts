// SFT 样本构造的纯函数层：剧本 → 训练批次任务（prompt 仍由 lib/prompts.ts 现场生成）。
// 设计目标：gen-sft-data.ts 只剩「调用教师 + 质量门 + 写文件」，这里负责全部形态逻辑。
import { parseTime } from '../../apps/server/src/pipeline/extract.js';
import {
  type ActiveEventBrief,
  type Message,
  type PromptPair,
  type ScenarioJson,
  buildPromptPair,
  makeBatches,
  scenarioToMessages,
} from './prompts.js';

export interface BatchJob {
  scenario: string;
  template: string;
  /** 剧本内批次序号（断点续跑的去重 key 用） */
  batchIndex: number;
  replayNow: number;
  pair: PromptPair;
  /** 纯负样本剧本（期望 {"events":[]}） */
  negative: boolean;
  /** 剧本声明的期望事件数（宽松一致性检查用；纯质检，不做硬门） */
  expectedCount: number;
}

/** 教师输出里的 think 剥离 + 代码围栏剥离（兜底，deepseek-chat 正常不会带） */
export function stripThink(raw: string): string {
  let t = raw.trim();
  const open = t.search(/<think>/i);
  if (open >= 0) {
    const close = t.search(/<\/think>/i);
    t = close > open ? t.slice(close + 8) : '';
  }
  return t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/** 剧本 → 训练任务列表（1 个剧本通常产 1~2 个批次；超过 maxCandidates 的批对齐生产拆批逻辑切开） */
export function planScenario(
  s: ScenarioJson,
  scenarioName: string,
  replayNow: number,
  maxCandidates: number,
): BatchJob[] {
  const messages = scenarioToMessages(s, replayNow);
  const active: ActiveEventBrief[] = (s.initial_events ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    start_at: e.when ? whenToMs(e.when) : null,
    end_at: null,
    deadline_at: null,
    location: e.location,
    action_required: null,
    level: e.level,
  }));

  const jobs: BatchJob[] = [];
  for (const b of makeBatches(messages)) {
    const chunks = chunkCandidates(b.candidates, maxCandidates);
    for (let k = 0; k < chunks.length; k++) {
      const context = k === 0
        ? b.context
        : [...b.context, ...chunks.slice(0, k).flat()].slice(-10);
      const pair = buildPromptPair(messages, { candidates: chunks[k]!, context }, replayNow, active);
      jobs.push({
        scenario: scenarioName,
        template: s.meta?.template ?? 'unknown',
        batchIndex: jobs.length,
        replayNow,
        pair,
        negative: s.meta?.negative ?? false,
        expectedCount: s.expected?.length ?? 0,
      });
    }
  }
  return jobs;
}

function whenToMs(when: string): number | null {
  const ms = parseTime(when);
  return Number.isNaN(ms) ? null : ms;
}

function chunkCandidates<T>(xs: T[], max: number): T[][] {
  if (xs.length <= 1) return [xs];
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += max) out.push(xs.slice(i, i + max));
  return out;
}
