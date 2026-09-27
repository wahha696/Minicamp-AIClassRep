// Jev 快判：一批消息一次请求，每条消息各问一个窄问题，返回每条的 noul 概率（「含日程信息」的概率）。
// 这里只给分数，怎么用分数（丢弃 / 立刻处理 / 攒批）由 scheduler.ts 决定。
// 失败时返回 null，由流水线把候选原样交给 LLM；失败后歇 JEV_BACKOFF_MS，免得每批都白等一次超时。
import { z } from 'zod';
import { getJevConfig } from '../ai-settings.js';
import type { Message } from '../types.js';
import { jevStats } from './stats.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

// ---------- 路由阈值（校准见 jev-calibrate.ts；两种错误代价不对等：误丢一条通知 ≫ 多调一次 LLM） ----------

/** 低于它才丢弃（不送 LLM）。只有在「真通知的最低分」明显高于它时才可以往上调。 */
export const JEV_DROP_BELOW = 0.2;
/** 不低于它视为「确定是通知」：跳过攒批等待，立刻交给 LLM 抽取 */
export const JEV_URGENT_AT = 0.8;
/** Jev 失败后多久内不再调用（期间候选直接交给 LLM） */
export const JEV_BACKOFF_MS = 30_000;

const answerSchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const responseSchema = z.object({ answers: z.record(z.string(), answerSchema) });

let backoffUntil = 0;

/** 配置了且不在失败退避期内（修复计划 3.2：读运行时配置，网页上改 key 立即生效） */
export function jevAvailable(now = Date.now()): boolean {
  const cfg = getJevConfig();
  return cfg.enabled && cfg.apiKey !== '' && now >= backoffUntil;
}

/** 测试用：清掉失败退避 */
export function resetJevBackoff(): void {
  backoffUntil = 0;
}

/** 返回与 candidates 一一对应的分数；未配置、退避中、候选为空或失败时返回 null */
export async function scoreWithJev(
  candidates: Message[],
  context: Message[],
  groupName: string,
): Promise<number[] | null> {
  if (!jevAvailable() || candidates.length === 0) return null;
  const cfg = getJevConfig();

  const questions = Object.fromEntries(candidates.map((_, i) => [
    `message_${i}`,
    {
      type: 'noul',
      instructions: `结合群聊上下文，\`messages[${i}]\` 是否提供可能影响学生日程或待办的具体信息？只判断这条消息，其他消息仅作上下文。`,
      criteria: {
        true: '考试、作业、会议、活动、通知的时间、地点、要求，或其改期、取消、补充、确认；已说定具体时间或日期的聚餐、吃饭、出游、打球等约定也算；零碎但可与上下文拼成这些信息的片段也算。',
        false: '纯闲聊、寒暄、表情、无关讨论，或没有说定时间的随口提议、询问，例如“晚上约饭吗”。',
      },
    },
  ]));

  jevStats.called++;
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        state: {
          group_name: groupName,
          previous_messages: context.map(({ sender_name, text }) => ({ sender_name, text })),
          messages: candidates.map(({ sender_name, text }) => ({ sender_name, text })),
        },
        questions,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = responseSchema.parse(await res.json());
    const scores = candidates.map((_, i) => {
      const score = result.answers[`message_${i}`]?.noul;
      if (score === undefined) throw new Error('缺少消息判断结果');
      return score;
    });
    jevStats.state = 'ok';
    jevStats.lastMs = Date.now() - t0;
    return scores;
  } catch (error) {
    jevStats.state = 'error';
    backoffUntil = Date.now() + JEV_BACKOFF_MS;
    // 不打印请求内容和密钥；错误只影响这一层，原有 LLM 继续处理。
    const why = error instanceof Error ? `${error.name}${error.message.startsWith('HTTP') ? ` ${error.message}` : ''}` : 'unknown';
    console.warn(`[pipeline] Jev 快判失败（${why}），${JEV_BACKOFF_MS / 1000}s 内候选直接交给 LLM`);
    return null;
  }
}
