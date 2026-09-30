// 训练数据管道 ⇆ 生产 prompt 的同源桥（操作手册 §2.2 铁律 1）。
//
// 本文件是唯一允许「接触 prompt 文案」的地方，而它自己不写任何文案——
// system/user prompt 一律现场调用 extract.ts 的 buildSystemPrompt / buildUserPrompt 生成，
// 因此 prompt 永远与生产逐字节一致，不存在「训练版 prompt」这种东西。
// 分批逻辑（BATCH/CONTEXT/isNoise）照抄 scheduler.ts / jev-calibrate.ts 的线上口径。
import {
  PROMPT_VERSION,
  buildSystemPrompt,
  buildUserPrompt,
  type ActiveEventBrief,
  type ExtractInput,
  type ExtractedEvent,
  parseExtraction,
} from '../../apps/server/src/pipeline/extract.js';
import { isNoise } from '../../apps/server/src/pipeline/filter.js';
import type { Message } from '../../apps/server/src/types.js';

export { PROMPT_VERSION, parseExtraction };
export type { ExtractInput, ExtractedEvent, ActiveEventBrief, Message };

/** 线上分批口径（scheduler.ts:27-28，jev-calibrate 同款） */
export const BATCH = 30;
export const CONTEXT = 10;

// ---------- 合成剧本（与 data/mock/*.json 同构，另带期望事件供质量过滤） ----------

export interface ScenarioMessageJson {
  offset_minutes: number;
  sender: string;
  text: string;
}

export interface ExpectedEventJson {
  type: string;
  title: string;
  /** 相对剧本回放时刻的描述，如「下周五 14:00」；仅人读，不参与字节级校验 */
  when?: string;
}

/** 剧本里「日历已有事件」（改期/取消/历史类剧本用；id 从 100 递增） */
export interface InitialEventJson {
  id: number;
  type: 'exam' | 'assignment' | 'meeting' | 'activity' | 'announcement' | 'other';
  title: string;
  /** "YYYY-MM-DD HH:mm"；无则 null */
  when: string | null;
  location: string | null;
  level: number;
}

export interface ScenarioJson {
  /** 剧本标题（人看） */
  title: string;
  group: { id: string; name: string };
  messages: ScenarioMessageJson[];
  /** 期望事件（训练管道质量过滤用，教师模型生成剧本时一并给出） */
  expected?: ExpectedEventJson[];
  /** 剧本回放前已存在于班级日历的事件（update/cancel/历史补齐类剧本） */
  initial_events?: InitialEventJson[];
  /** 生成元信息 */
  meta?: {
    template?: string;
    seed?: number;
    /** true = 纯负样本剧本（期望 {"events":[]}） */
    negative?: boolean;
  };
}

export interface ExpectedEventJson {
  type: string;
  title: string;
  /** 相对剧本回放时刻的描述，如「下周五 14:00」；仅人读，不参与字节级校验 */
  when?: string;
}

/** 剧本 JSON → Message[]（buildDemoMessages 的同款换算：sent_at = replayNow + offset 分钟） */
export function scenarioToMessages(s: ScenarioJson, replayNow: number): Message[] {
  return s.messages.map((m, i) => ({
    message_id: `${s.group.id}-${i + 1}`,
    group_id: s.group.id,
    group_name: s.group.name,
    sender_name: typeof m.sender === 'string' ? m.sender : '',
    text: typeof m.text === 'string' ? m.text : '',
    sent_at: replayNow + (Number.isFinite(m.offset_minutes) ? m.offset_minutes : 0) * 60_000,
  }));
}

/** 和 jev-calibrate.ts 完全一致的攒批：30 条一批，批内去噪声，上下文取此前最近 10 条非噪声 */
export function makeBatches(
  messages: Message[],
): { candidates: Message[]; context: Message[] }[] {
  const out: { candidates: Message[]; context: Message[] }[] = [];
  for (let i = 0; i < messages.length; i += BATCH) {
    const batch = messages.slice(i, i + BATCH);
    const candidates = batch.filter((m) => !isNoise(m.text));
    if (candidates.length === 0) continue;
    const context = messages.slice(0, i).filter((m) => !isNoise(m.text)).slice(-CONTEXT);
    out.push({ candidates, context });
  }
  return out;
}

/** 一次训练样本的 prompt 对（逐字节来自生产构造器）+ 溯源元信息 */
export interface PromptPair {
  system: string;
  user: string;
  prompt_version: number;
  now: number;
  earliest: number;
  /** 本批候选消息 id（教师输出里 source_message_ids 的合法集合） */
  valid_ids: string[];
}

export function buildPromptPair(
  messages: Message[],
  batch: { candidates: Message[]; context: Message[] },
  now: number,
  activeEvents: ActiveEventBrief[] = [],
): PromptPair {
  const earliest = batch.candidates[0]?.sent_at ?? now;
  const input: ExtractInput = {
    groupId: messages[0]?.group_id ?? 'unknown',
    groupName: messages[0]?.group_name ?? '',
    candidates: batch.candidates,
    context: batch.context,
    now,
    activeEvents,
  };
  return {
    system: buildSystemPrompt(now, earliest),
    user: buildUserPrompt(input),
    prompt_version: PROMPT_VERSION,
    now,
    earliest,
    valid_ids: batch.candidates.map((m) => m.message_id),
  };
}

// ---------- 粗略 token 估算（选样/截断预警用，不参与训练） ----------

/** 中文约 1 字/token、英文约 4 字符/token 的混合估算；只用于统计，不要拿来做硬截断 */
export function estTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) /[^\x00-\x7F]/.test(ch) ? cjk++ : other++;
  return cjk + Math.ceil(other / 4);
}
