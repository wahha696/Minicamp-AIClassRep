# -*- coding: utf-8 -*-
r"""检查 reschedule 类训练剧本里"更正"是否真的跨批次——决定"再多生成同类数据"是否有用。

考卷 reschedule 的难点：原事件在第 1 批创建，"改到 A203/周五两点"在第 2 批（带 active_events），
必须把两条合并成一条（version≥2、地点取新值）。若训练剧本的更正总与原事件同批，
模型就没机会学"跨批合并"，那么再怎么加同类数据都没用。

用法：python train\tools\update_flow.py [n]
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
N = int(sys.argv[1]) if len(sys.argv) > 1 else 3
UPDATE = re.compile(r"(改到|改成|换成|换到|推迟|延后|提前|取消|不办了)")
DIR = "train/data/scenarios-real"
SFT = "train/data/sft-real.jsonl"

files = sorted(f for f in os.listdir(DIR) if f.startswith("reschedule"))[:N]
for f in files:
    obj = json.load(open(os.path.join(DIR, f), encoding="utf-8"))
    msgs = obj.get("messages", [])
    name = f[:-5]
    print(f"\n=== {name}（{len(msgs)} 条消息）===")
    idxs = [i for i, m in enumerate(msgs) if UPDATE.search(m.get("text") or "")]
    print(f"  更正类消息位置: {idxs[:6]}{' …' if len(idxs) > 6 else ''}（共 {len(idxs)} 条）")
    for i in idxs[:3]:
        print(f"    #{i}: {(msgs[i].get('text') or '')[:56]}")

# 在蒸馏产物里找该剧本的批次，看更正落在第几批、以及目标事件是否只有一条
print(f"\n=== 蒸馏产物（{SFT}）里该剧本的批次 ===")
rows = []
for line in open(SFT, encoding="utf-8"):
    o = json.loads(line)
    if str(o["meta"].get("scenario", "")).startswith("reschedule"):
        rows.append(o)
for o in rows[:N]:
    meta = o["meta"]
    target = json.loads([c["value"] for c in o["conversations"] if c["from"] == "gpt"][0])
    evs = target.get("events", [])
    print(
        f"  {meta.get('scenario')}#{meta.get('batch')}: 目标事件 {len(evs)} 条"
        f" | 候选 {meta.get('candidates', '?')} 条"
        f" | activeEvents={meta.get('active_events', meta.get('activeEvents', '?'))}"
    )
    for e in evs[:2]:
        # update 类事件按协议只带变化字段（type/title 为 null 是正常的），所以看 action/update_of
        print(
            f"      action={e.get('action')} update_of={e.get('update_of')}"
            f" type={e.get('type')} title={e.get('title')}"
            f" | start={e.get('start_at')} loc={e.get('location')}"
        )
