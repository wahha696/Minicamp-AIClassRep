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

/**
 * 变更/取消保活词（成熟度评估 A01）：「取消了」「不交了」「改线上」这类消息很短、
 * 也没有时间词，却极可能是否定/修改前面某条通知的关键信息——它们必须先留着交给
 * LLM 结合上下文判断，规则层无权丢弃。误放过的代价只是多一次 LLM 调用。
 */
const KEEP_WORD =
  /取消|改期|改到|改在|改为|改成|改回|改线上|改线下|改网课|改时间|改地点|换(?:了|成|到|教室|课|地点|时间|老师)|挪到|推迟|延期|延后|提前|暂停|停课|补课|调课|复课|恢复|不上|不考|不交|不收|不用交|不用上|不开|不办|照常|作废|撤回|补交|补考|缓考|重修|记得|别忘/i;

export function isNoise(text: string): boolean {
  const t = text.replace(PLACEHOLDER, '').replace(/\s+/g, '');
  const core = t.replace(EMOJI_PUNCT, '');
  if (!core) return true;
  if (KEEP_WORD.test(t)) return false;
  if (ACK.test(t)) return true;
  return [...core].length < 4 && !DIGIT.test(core) && !TIME_WORD.test(core);
}
