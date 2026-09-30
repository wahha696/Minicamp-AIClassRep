# -*- coding: utf-8 -*-
r"""把 SFT 数据集的正负例比例调回生产水平（默认负例 40%），用于对照实验。

背景：形态对齐后的 `sft-real.jsonl` 负例占 52%，而生产实测约 40%（eval 日志里 15 批有 6 批无事件）。
负例偏多会让模型偏保守（漏提），这是本轮模型若表现不佳时的首要嫌疑；本脚本产出对照集，
保持全部正例、按确定性哈希抽样负例。

用法：
  python train\tools\rebalance_negatives.py --src train\data\sft-real.jsonl ^
      --out train\data\sft-real-bal.jsonl --neg-ratio 0.4
"""
import argparse
import hashlib
import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ap = argparse.ArgumentParser()
ap.add_argument("--src", default="train/data/sft-real.jsonl")
ap.add_argument("--out", default="train/data/sft-real-bal.jsonl")
ap.add_argument("--neg-ratio", type=float, default=0.4, help="目标负例占比（0~1）")
args = ap.parse_args()

pos, neg = [], []
for line in open(args.src, encoding="utf-8"):
    o = json.loads(line)
    gpt = [c["value"] for c in o["conversations"] if c["from"] == "gpt"][0]
    key = f"{o['meta'].get('scenario')}#{o['meta'].get('batch')}"
    digest = int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:12], 16)
    (pos if json.loads(gpt).get("events") else neg).append((digest, o))

# 目标：neg / (pos + neg) = ratio  →  neg = pos * ratio / (1 - ratio)
want_neg = int(len(pos) * args.neg_ratio / (1 - args.neg_ratio))
neg.sort(key=lambda t: t[0])  # 确定性抽样
neg = neg[:want_neg]
rows = [o for _, o in pos] + [o for _, o in neg]

with open(args.out, "w", encoding="utf-8") as fh:
    for o in rows:
        fh.write(json.dumps(o, ensure_ascii=False) + "\n")

tot = len(rows)
print(
    f"{args.src} → {args.out}: 正例 {len(pos)} + 负例 {len(neg)} = {tot} 条"
    f"（负例 {100*len(neg)/tot:.0f}%，目标 {args.neg_ratio*100:.0f}%）"
)
