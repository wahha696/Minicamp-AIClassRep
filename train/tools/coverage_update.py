# -*- coding: utf-8 -*-
r"""统计训练剧本对"更新/取消"类模式的覆盖度，与考卷（data/mock）对比。

背景：形态对齐模型残留失败集中在 reschedule（改到 A203 / version 应≥2）、cancel（茶话会应 cancelled）、
similar-exams（地点/时间被改过）。若训练数据里这类"事后更正"的消息很少，就说明下一个数据要补什么。

用法：python train\tools\coverage_update.py
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PATTERNS = {
    "改期/改地点": r"(改到|改成|换成|换到|调整到|调到|推迟|延后|提前|另行通知)",
    "取消": r"(取消|不办了|不开了|不用了|作废|暂停)",
    "补发/事后": r"(补充|更正|勘误|刚才说错|再提醒|另外提醒|顺便说)",
}


def scan(dirpath: str) -> dict:
    files = []
    if os.path.isdir(dirpath):
        files = [f for f in os.listdir(dirpath) if f.endswith(".json")]
    hits = {k: 0 for k in PATTERNS}
    total = 0
    msgs_total = 0
    for f in files:
        try:
            obj = json.load(open(os.path.join(dirpath, f), encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        total += 1
        texts = [(m.get("text") or "") for m in obj.get("messages", [])]
        msgs_total += len(texts)
        blob = "\n".join(texts)
        for name, pat in PATTERNS.items():
            if re.search(pat, blob):
                hits[name] += 1
    return {"files": total, "msgs": msgs_total, "hits": hits}


a = scan("train/data/scenarios-real")
b = scan("data/mock")
print(f"{'模式':<12} {'训练剧本(557)':>16} {'考卷剧本(6)':>14}")
for k in PATTERNS:
    pa = f"{a['hits'][k]} ({100*a['hits'][k]/max(1,a['files']):.0f}%)"
    pb = f"{b['hits'][k]} ({100*b['hits'][k]/max(1,b['files']):.0f}%)"
    print(f"{k:<12} {pa:>16} {pb:>14}")
print(f"\n训练剧本 {a['files']} 个 / {a['msgs']} 条消息；考卷 {b['files']} 个 / {b['msgs']} 条消息")
