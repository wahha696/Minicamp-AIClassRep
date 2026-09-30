# -*- coding: utf-8 -*-
r"""对新数据集跑与 v1/v2 同标准的质量门（JSON 合法性/围栏/prompt_version/token 分布）。"""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
FENCE = chr(96) * 3

path = sys.argv[1] if len(sys.argv) > 1 else "train/data/sft-real.jsonl"
pvs, scen = set(), set()
bad = fence = neg = n = 0
toks = []
for line in open(path, encoding="utf-8"):
    o = json.loads(line)
    m = o["meta"]
    n += 1
    pvs.add(m.get("prompt_version"))
    scen.add(m.get("scenario"))
    a = [c["value"] for c in o["conversations"] if c["from"] == "gpt"][0]
    if a.strip().startswith(FENCE):
        fence += 1
    try:
        if not json.loads(a).get("events"):
            neg += 1
    except Exception:
        bad += 1
    toks.append(m.get("est_tokens", 0))

toks.sort()
print(f"{path}: {n} 对 / {len(scen)} 剧本")
print(f"prompt_versions={pvs} | 非法 JSON={bad} | 围栏={fence} | 负例={neg} ({100*neg/max(1,n):.0f}%)")
print(
    f"tokens p50={toks[n//2]} p90={toks[int(n*0.9)]} p99={toks[int(n*0.99)]} max={toks[-1]}"
    f" | >3072 的 {sum(1 for t in toks if t > 3072)} 条"
)
