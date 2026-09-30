# -*- coding: utf-8 -*-
r"""候选行级真实感对比：真实剧本 vs 新版生成器探针 vs v4。

候选 = 按线上 BATCH=30 攒批后、经 isNoise 过滤剩下的消息。
用与 train/.cache/noise_ratio.py 同一套近似 isNoise 口径（关键词/长度）。
"""
import json
import os
import re
import statistics
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

NOISE = re.compile(r"^(哈+|哈哈+|收到|好的?|嗯+|哦+|在吗|谢谢|\+1|同问|顶|赞|😂|🤣|\[图片\]|\[表情\])")
TIME = re.compile(r"(\d{1,2}[：:]\d{2}|周[一二三四五六日末]|星期[一二三四五六日]|下周|本周|明天|后天|今晚|明晚|\d{1,2}\s*月\s*\d{1,2}|\d{1,2}\s*号)")


def noisy(t: str) -> bool:
    t = (t or "").strip()
    return len(t) <= 6 or bool(NOISE.match(t))


def candidates(path: str) -> list[str]:
    out: list[str] = []
    for f in os.listdir(path):
        if not f.endswith(".json"):
            continue
        o = json.load(open(os.path.join(path, f), encoding="utf-8"))
        msgs = o.get("messages", [])
        for i in range(0, len(msgs), 30):
            for m in msgs[i:i + 30]:
                t = m.get("text", "") or ""
                if t and not noisy(t):
                    out.append(t)
    return out


for label, path in (
    ("真实剧本 data/mock", "data/mock"),
    ("旧生成 scenarios", "train/data/scenarios"),
    ("新探针 realprobe", "train/data/scenarios-realprobe"),
):
    cs = candidates(path)
    if not cs:
        print(f"{label:<22} 无数据")
        continue
    chars = [len(c) for c in cs]
    tms = sum(1 for c in cs if TIME.search(c))
    print(
        f"{label:<22} 候选 {len(cs):>6} 条 | 字/条 中位 {statistics.median(chars):>4.0f} 均值 {sum(chars)/len(chars):>5.1f}"
        f" | 含时间 {100*tms/len(cs):>5.1f}%"
    )
