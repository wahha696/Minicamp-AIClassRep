// Jev 快判：一批消息一次请求，每条消息各问一个窄问题。失败时返回 null，由流水线交给原有 LLM。
import { z } from 'zod';
import { env } from '../env.js';
import type { Message } from '../types.js';
import { jevStats } from './stats.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// 这是保守的初始路由值，不代表已在真实群聊上校准。低于它才丢弃。
export const JEV_DROP_BELOW = 0.2;

const answerSchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const responseSchema = z.object({ answers: z.record(z.string(), answerSchema) });

export async function filterWithJev(
  candidates: Message[],
  context: Message[],
  groupName: string,
): Promise<Message[] | null> {
  if (!env.ENABLE_JEV || !env.TYPESAFE_API_KEY || candidates.length === 0) return null;

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
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.JEV_MODEL,
        state: {
          group_name: groupName,
          previous_messages: context.map(({ sender_name, text }) => ({ sender_name, text })),
          messages: candidates.map(({ sender_name, text }) => ({ sender_name, text })),
        },
        questions,
      }),
      signal: AbortSignal.timeout(env.JEV_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = responseSchema.parse(await res.json());
    const scores = candidates.map((_, i) => {
      const score = result.answers[`message_${i}`]?.noul;
      if (score === undefined) throw new Error('缺少消息判断结果');
      return score;
    });
    jevStats.state = 'ok';
    return candidates.filter((_, i) => scores[i]! >= JEV_DROP_BELOW);
  } catch (error) {
    jevStats.state = 'error';
    // 不打印请求内容和密钥；错误只影响这一层，原有 LLM 继续处理。
    console.warn(`[pipeline] Jev 快判失败，已交给 LLM：${error instanceof Error ? error.name : 'unknown'}`);
    return null;
  }
}
