# -*- coding: utf-8 -*-
r"""同口径对比：队友 fastjudge（TF-IDF）vs 本工作区 rbt3-ONNX，在同一批候选、同一份标签上。

标签来自 jev-calibrate 的 --dump 存档（LLM 的 event_sources 作为"参考真通知"）。
两边的输入文本都用生产格式：`群名 [SEP] 上一条消息 [SEP] 本条消息`（ONNX 侧无上一条时留空）。
"""
import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

DUMP = "train/artifacts/jev-calibrate-dump.json"
MODEL = r"train\models\jev-classifier-onnx\model_quantized.onnx"
TOKDIR = r"train\models\jev-classifier-onnx\tokenizer"

rows = json.load(open(DUMP, encoding="utf-8"))["candidates"]
tok = AutoTokenizer.from_pretrained(TOKDIR)
sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
in_names = [i.name for i in sess.get_inputs()]


def onnx_score(group: str, text: str) -> float:
    s = f"{group} [SEP]  [SEP] {text}"
    enc = tok(s, return_tensors="np", truncation=True, max_length=256)
    feed = {k: v.astype(np.int64) for k, v in enc.items() if k in in_names}
    out = sess.run(None, feed)[0]
    e = np.exp(out - out.max(axis=-1, keepdims=True))
    p = e / e.sum(axis=-1, keepdims=True)
    return float(p[0][1])


for r in rows:
    r["onnx"] = onnx_score(r["group_name"], r["text"])

pos = [r for r in rows if r["positive"]]
neg = [r for r in rows if not r["positive"]]
print(f"候选 {len(rows)} 条（参考真通知 {len(pos)}）\n")

print(f"{'阈值':>6} {'fastjudge 召回':>14} {'fastjudge 丢弃':>14} {'ONNX 召回':>11} {'ONNX 丢弃':>11}")
for th in (0.05, 0.1, 0.2, 0.3, 0.45, 0.5):
    fj_kept = sum(1 for r in pos if r["score"] >= th) / max(1, len(pos))
    fj_drop = sum(1 for r in rows if r["score"] < th) / len(rows)
    on_kept = sum(1 for r in pos if r["onnx"] >= th) / max(1, len(pos))
    on_drop = sum(1 for r in rows if r["onnx"] < th) / len(rows)
    print(f"{th:>6.2f} {fj_kept*100:>13.1f}% {fj_drop*100:>13.1f}% {on_kept*100:>10.1f}% {on_drop*100:>10.1f}%")

print("\n--- 双方都被漏掉的真通知（说明是标签口径问题，不是模型问题）---")
for r in sorted(pos, key=lambda x: min(x["score"], x["onnx"]))[:6]:
    print(f"  fj={r['score']:.3f} onnx={r['onnx']:.3f}  {r['text'][:44]}")
print("\n--- ONNX 能救回、fastjudge 漏掉的真通知（级联价值所在）---")
saved = [r for r in pos if r["score"] < 0.2 <= r["onnx"]]
for r in saved:
    print(f"  fj={r['score']:.3f} onnx={r['onnx']:.3f}  {r['text'][:44]}")
print(f"  共 {len(saved)} 条")
print("\n--- fastjudge 保留、ONNX 会丢的真通知（级联风险）---")
risk = [r for r in pos if r["onnx"] < 0.2 <= r["score"]]
for r in risk:
    print(f"  fj={r['score']:.3f} onnx={r['onnx']:.3f}  {r['text'][:44]}")
print(f"  共 {len(risk)} 条")

err = sum(1 for r in rows if (r["onnx"] >= 0.45) != r["positive"])
print(f"\nONNX@0.45 与标签不一致的候选：{err}/{len(rows)}（其中误报 {sum(1 for r in neg if r['onnx'] >= 0.45)}，漏报 {sum(1 for r in pos if r['onnx'] < 0.45)}）")
