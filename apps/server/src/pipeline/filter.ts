// 规则过滤（FR-3.1）：丢掉明显的噪声消息，剩下的才交给 LLM。
// 宁可放过、不可错杀：真通知被过滤就再也找不回来，闲聊漏过去只是多花一点 LLM 调用。

/** 消息段转文本时产生的占位符（见分工 A4 segmentsToText） */
const PLACEHOLDER = /\[(?:图片|表情|at|卡片|转发|文件|语音|视频|消息)\]/g;

/** emoji（含零宽连接符、变体选择符）与标点：剥掉后什么都不剩，说明只是在刷表情 / 问号 */
const EMOJI_PUNCT = /[\p{Extended_Pictographic}\u200D\uFE0F\p{P}]/gu;

const DIGIT = /[0-9０-９]/;

const TIME_WORD =
  /[今明后昨][天晚早]|[周星期礼拜][一二三四五六日天末]|星期|本周|下周|这周|早上|上午|中午|下午|傍晚|晚上|凌晨|截止|ddl|点|号|月|日/i;

/** 纯附和；允许连着说（「收到收到」「好的谢谢」），结尾可带语气标点 */
const ACK =
  /^(?:(?:收到|好的|好滴|ok|嗯+|哈+|6+|\+1|谢谢|知道了|1+|啊+|草|？+|\?+)[!！。~～,，、.]*)+$/i;

export function isNoise(text: string): boolean {
  const t = text.replace(PLACEHOLDER, '').replace(/\s+/g, '');
  const core = t.replace(EMOJI_PUNCT, '');
  if (!core) return true;
  if (ACK.test(t)) return true;
  return [...core].length < 4 && !DIGIT.test(core) && !TIME_WORD.test(core);
}
