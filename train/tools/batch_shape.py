# -*- coding: utf-8 -*-
"""量两边批形态：训练样本每条 prompt 的候选消息数 vs 生产 pipeline 实际发出的候选数。

候选行格式：[message_id] 时间 发送人：文本（见 extract.ts fmtMsg）。
"""
import json
import re

MARK = "需要处理的新消息："
LINE = re.compile(r"^\[[^\]]+\] ")


def count_candidates(user: str) -> int:
    if MARK not in user:
        return 0
    tail = user.split(MARK, 1)[1]
    return sum(1 for ln in tail.splitlines() if LINE.match(ln.strip()))


hist: dict[int, int] = {}
n = 0
for line in open("train/data/sft-v2.jsonl", encoding="utf-8"):
    o = json.loads(line)
    user = [c["value"] for c in o["conversations"] if c["from"] == "human"][0]
    c = count_candidates(user)
    if c == 0:
        continue
    n += 1
    hist[c] = hist.get(c, 0) + 1

print(f"训练样本（能数出候选的 {n} 条）候选数分布：")
for c in sorted(hist):
    bar = "#" * min(60, round(hist[c] / n * 60))
    print(f"  {c:>2} 个候选: {hist[c]:>4} 条 ({hist[c]/n*100:4.1f}%) {bar}")
big = sum(v for k, v in hist.items() if k > 15)
print(f"\n> 15 个候选的样本：{big} 条（{big/n*100:.1f}%）—— 生产 pipeline 实测每次只发 5~13 条")
