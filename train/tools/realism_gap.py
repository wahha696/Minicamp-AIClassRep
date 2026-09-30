# -*- coding: utf-8 -*-
r"""真实剧本（data/mock）vs 生成剧本（train/data/scenarios）的分布对比。

信噪比已在 BATCH-SHAPE.md 量过（78% vs 20%）；这里看其它维度：
每剧本消息数、消息长度、期望事件密度、含时间/日期表达的消息占比。
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TIME_PAT = re.compile(r"(\d{1,2}[：:]\d{2}|周[一二三四五六日末]|星期[一二三四五六日]|下周|本周|明天|后天|今晚|明晚|\d{1,2}\s*月\s*\d{1,2}|\d{1,2}\s*号)")


def scan(path: str, label: str) -> dict:
    files = [f for f in os.listdir(path) if f.endswith(".json")]
    msgs_total = chars_total = ev_total = time_msgs = 0
    per_scen_msgs = []
    for f in files:
        try:
            o = json.load(open(os.path.join(path, f), encoding="utf-8"))
        except Exception:
            continue
        msgs = o.get("messages", [])
        per_scen_msgs.append(len(msgs))
        msgs_total += len(msgs)
        ev_total += len(o.get("expected") or [])
        for m in msgs:
            t = m.get("text", "") or ""
            chars_total += len(t)
            if TIME_PAT.search(t):
                time_msgs += 1
    n = max(1, len(files))
    per_scen_msgs.sort()
    return {
        "label": label,
        "scenarios": len(files),
        "msgs_scen_median": per_scen_msgs[len(per_scen_msgs) // 2] if per_scen_msgs else 0,
        "chars_msg": chars_total / max(1, msgs_total),
        "events_scen": ev_total / n,
        "time_msg_pct": 100 * time_msgs / max(1, msgs_total),
    }


rows = [scan("data/mock", "真实剧本 data/mock"), scan("train/data/scenarios", "生成剧本 scenarios")]
hdr = f"{'数据':<22}{'剧本':>6}{'消息/剧本(中位)':>16}{'字/消息':>10}{'期望事件/剧本':>14}{'含时间消息%':>13}"
print(hdr)
print("-" * len(hdr))
for r in rows:
    print(f"{r['label']:<22}{r['scenarios']:>6}{r['msgs_scen_median']:>16}{r['chars_msg']:>10.1f}{r['events_scen']:>14.1f}{r['time_msg_pct']:>13.1f}")
