"""Rule-layer parallel to model score (align G1-1 / KEEP_WORD; prefer Jev FP discipline)."""
from __future__ import annotations

import re

PLACEHOLDER = re.compile(r"\[(?:图片|表情|at|卡片|转发|文件|语音|视频|消息)\]")
EMOJI_PUNCT = re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\u200D\uFE0F]", re.UNICODE)
DIGIT = re.compile(r"[0-9０-９]")
TIME_WORD = re.compile(
    r"[今明后昨][天晚早]|[周星期礼拜][一二三四五六日天末]|星期|本周|下周|这周|"
    r"早上|上午|中午|下午|傍晚|晚上|凌晨|截止|ddl|"
    r"\d{1,2}\s*[:：点]\s*\d{0,2}|[一二三四五六七八九十两]\s*点",
    re.I,
)
PURE_ACK = re.compile(
    r"^(?:(?:收到|好的|好滴|好呀|好啊|好耶|ok|OK|嗯+|哈+|6+|\+1|谢谢|谢谢老师|谢谢提醒|"
    r"知道了|1+|啊+|草|？+|\?+|顶不住|哈哈+|好的老师|好的谢谢)"
    r"(?:[，,]\s*(?:谢谢(?:老师|提醒)?|知道了|收到|准时到|一定去|马上去[^\s]{0,6}))?"
    r"[!！。~～,，、.… ]*)+$",
    re.I,
)
# Definitive change/cancel — not rumors/questions
KEEP_WORD = re.compile(
    r"(?<![吗呢吧听说是不是有没有])(?:"
    r"取消了|取消啦|取消吧|班会取消|考试取消|停课|作废|"
    r"改期|改到|改在|改为|改成|改回|改线上|改线下|改网课|改时间|改地点|"
    r"换(?:了|成|到|教室|课|地点|时间|老师)|挪到|推迟|延期|延后|提前|暂停|"
    r"补课|调课|复课|恢复上课|不交了|不收了|不用交|不用上|不开了|照常|"
    r"撤回|补交|补考|缓考|重修|记得带|别忘了"
    r")",
    re.I,
)
QUESTIONISH = re.compile(r"[吗？\?]|是不是|有没有|听说|能不能|可不可以")
SCHEDULE_CORE = re.compile(
    r"考试|小测|期中|期末|作业|实验报告|提交|截止|ddl|班会|开会|学代会|"
    r"年级大会|集合|签到|补考|缓考|逾期|学习通|问卷|通知",
    re.I,
)
MEET_TIME = re.compile(
    r"(?:[今明后]晚|[今明后]天|上午|下午|晚上|中午|早上)?\s*"
    r"(?:\d{1,2}|[一两二三四五六七八九十]+)\s*(?:[:：点]|点半|半)|"
    r"\d{1,2}\s*[:：]\s*\d{2}|"
    r"[一二三四五六七八九十两]点(?:左右|半)?",
    re.I,
)
SHORT_CONFIRM = re.compile(
    r"^(?:带上|要带|要|去|报名|报名了|报名！|我去|到|到场|签到|准时到|可以|行|走|"
    r"带学生证|带身份证|我报名)[!！。~～]*$"
)
UNDATED_HANGOUT = re.compile(
    r"(?:约饭|约吃|开黑|有人去吗|谁去食堂|一起去(?:食堂|图书馆|操场)|"
    r"打羽毛球|吃饭吗|时间地点待定|有人一起|晚上谁去|有人去操场|有人拼外卖)",
    re.I,
)


def message_text(row: dict) -> str:
    return str((row.get("message") or {}).get("text") or "").strip()


def compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


def is_placeholder_or_empty(text: str) -> bool:
    t = PLACEHOLDER.sub("", text)
    t = re.sub(r"\s+", "", t)
    core = EMOJI_PUNCT.sub("", t)
    core = re.sub(r"[\W_]+", "", core, flags=re.UNICODE)
    return not core


def ctx_has_schedule(row: dict) -> bool:
    for c in row.get("context") or []:
        t = str(c.get("text") or "")
        if SCHEDULE_CORE.search(t) or MEET_TIME.search(t) or TIME_WORD.search(t):
            if KEEP_WORD.search(t) or SCHEDULE_CORE.search(t) or MEET_TIME.search(t):
                return True
    return False


def fuse_score(model_score: float, row: dict) -> float:
    text = message_text(row)
    s = float(model_score)
    c = compact(text)

    if is_placeholder_or_empty(text):
        return min(s, 0.05)

    # Attendance / timed confirm is not a pure ack
    if re.search(r"准时到|点前交|点到|一定去|马上去交", text) and not QUESTIONISH.search(text):
        if PURE_ACK.match(c) or text.startswith("好的") or text.startswith("收到"):
            return max(s, 0.72)
    if PURE_ACK.match(c):
        return min(s, 0.05)

    # Undated hangout / vague invites — hard drop (Jev does this)
    if UNDATED_HANGOUT.search(text) and not MEET_TIME.search(text):
        return min(s, 0.12)

    # Rumor / question about cancel/reschedule — do NOT hard-boost
    if QUESTIONISH.search(text) and re.search(r"取消|改期|改线上|改到|不交|逾期|补交", text):
        return min(max(s, 0.25), 0.55)  # uncertain band; no urgent

    # Definitive keep-alive change on the message itself
    if KEEP_WORD.search(text) and not QUESTIONISH.search(text):
        return max(s, 0.88)

    # Short confirm fragment completing a schedule thread
    if ctx_has_schedule(row) and SHORT_CONFIRM.match(c):
        return max(s, 0.72)

    # Clear schedule + concrete time on message
    if SCHEDULE_CORE.search(text) and (MEET_TIME.search(text) or DIGIT.search(text) or TIME_WORD.search(text)):
        # complaints / chatter containing keywords without logistics
        if re.search(r"太快了|跟不上|好麻烦|好慌|多到爆炸|红点", text):
            return min(s, 0.25)
        return max(s, 0.78)

    # Meeting/council logistics (not complaints)
    if re.search(r"(?:学代会|班会|年级大会).*(?:改|取消|集合|签到|参加|全体|提案|时间|点)|"
                 r"(?:明天|下周|周[一二三四五六日天]).*(?:班会|学代会|年级大会)", text):
        return max(s, 0.75)
    if re.search(r"学代会|班会", text) and re.search(r"麻烦|听起来|不想", text):
        return min(s, 0.15)

    # Concrete clock-time meetup / arrival
    if MEET_TIME.search(text) and re.search(r"见|集合|食堂|操场|门口|火锅|球场|上线|签到|礼堂|教室|到|老位置|来一起", text):
        return max(s, 0.70)

    # Carpool / study-room logistics
    if re.search(r"拼车|高铁站", text) and (TIME_WORD.search(text) or MEET_TIME.search(text)):
        if not QUESTIONISH.search(text) or re.search(r"还差|差一个", text):
            return max(s, 0.65)
    if re.search(r"研讨间|组队复习|我去订", text) and (ctx_has_schedule(row) or re.search(r"复习|提纲|考试|线代", " ".join(str(c.get("text") or "") for c in (row.get("context") or [])))):
        return max(s, 0.65)

    # Short time reply in schedule context
    if ctx_has_schedule(row) and len(c) <= 12 and (MEET_TIME.search(text) or c in {"几点", "几点？", "啥时候", "什么时候"}):
        return max(s, 0.55)

    # Urgent ceiling: vague / question / pure complaint should not hit ≥0.8
    vague = re.search(
        r"晚点通知|具体(?:时间|地点)?(?:我还在定|等通知|确认后发|另通知)|初步定|先这样|等通知|"
        r"如果下雨|待定|还没收齐|有没有问题",
        text,
    )
    question = (QUESTIONISH.search(text) or re.search(r"还是电子版|手写拍照还是|链接能再发", text)) and not KEEP_WORD.search(text)
    complaint = re.search(r"太快了|跟不上|好麻烦|好慌|顶不住|多到爆炸|怎么这么多|数据处理好麻烦|一直转圈|今天有炸鸡", text)
    chatter = re.search(r"^(?:好吧|好耶|我也来|尽快哦.{0,6})$", c)
    roster_only = re.search(r"名单|群文件", text) and not MEET_TIME.search(text) and not KEEP_WORD.search(text)
    if s >= 0.8 and (vague or question or complaint or chatter or roster_only):
        return min(s, 0.72)  # keep in uncertain band, not urgent

    return s


def fuse_scores(model_scores: list[float], rows: list[dict]) -> list[float]:
    return [fuse_score(s, r) for s, r in zip(model_scores, rows)]
