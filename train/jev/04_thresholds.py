# -*- coding: utf-8 -*-
"""Jev 本地模型阈值扫描（操作手册 §3 第 4 步）：本地分数分布 ≠ TypeSafe，两个阈值必须重扫。

  python train/jev/04_thresholds.py --onnx-dir train/models/jev-classifier-onnx --val train/data/jev-val.jsonl

口径对齐 pipeline/jev-calibrate.ts：真通知召回 100% + 单批 p90 < 100ms。
输出：分数两端样本、各阈值召回/丢弃率、JEV_DROP_BELOW / JEV_URGENT_AT 建议。
"""
from __future__ import annotations

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # GBK console guard
import argparse
import json
import os
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--onnx-dir", default=str(HERE.parent / "models" / "jev-classifier-onnx"))
    ap.add_argument("--val", default=str(HERE.parent / "data" / "jev-val.jsonl"))
    ap.add_argument("--max-len", type=int, default=256)
    ap.add_argument("--batch", type=int, default=30, help="生产口径 BATCH=30")
    args = ap.parse_args()

    import onnxruntime as ort
    from transformers import AutoTokenizer

    d = Path(args.onnx_dir)
    sess = ort.InferenceSession(str(d / "model_quantized.onnx"), providers=["CPUExecutionProvider"])
    # 注：实测本机 ORT 默认线程配置最快（p50 ~90ms）；手动设多线程在 P/E 核混合 CPU 上反而争核。
    tok = AutoTokenizer.from_pretrained(str(d / "tokenizer"))  # 03 导出把分词器放在 tokenizer/ 子目录

    rows: list[dict] = []
    with open(Path(args.val), "r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t:
                rows.append(json.loads(t))
    texts = [r["text"] for r in rows]
    labels = [int(r["label"]) for r in rows]
    print(f"val={len(rows)}（正 {sum(labels)}）")

    def score(batch_texts: list[str]) -> list[float]:
        out: list[float] = []
        for i in range(0, len(batch_texts), args.batch):
            enc = tok(batch_texts[i : i + args.batch], truncation=True, max_length=args.max_len, padding=True, return_tensors="np")
            logits = sess.run(None, {
                "input_ids": enc["input_ids"].astype(np.int64),
                "attention_mask": enc["attention_mask"].astype(np.int64),
            })[0]
            ex = np.exp(logits - logits.max(axis=1, keepdims=True))
            out.extend((ex[:, 1] / ex.sum(axis=1)).tolist())
        return out

    probs = score(texts)
    pos = sorted(p for p, y in zip(probs, labels) if y == 1)
    neg = sorted(p for p, y in zip(probs, labels) if y == 0)
    npos = sum(labels)

    print("\n======== 真通知里分数最低的 5 条（丢弃阈值必须低于这些）")
    for p in pos[:5]:
        print(f"  {p:.3f}  {rows[probs.index(p)]['msg'][:42]}")
    print("======== 非通知里分数最高的 5 条（只会早调 LLM，不影响正确性）")
    for p in sorted(neg, reverse=True)[:5]:
        i = probs.index(p)
        print(f"  {p:.3f}  {rows[i]['msg'][:42]}")

    print("\n======== 阈值扫描（口径同 jev-calibrate）")
    print("  丢弃阈值  真通知召回  候选丢弃率")
    max_safe = 0.0
    for th in (0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5):
        recall = sum(1 for p, y in zip(probs, labels) if y == 1 and p >= th) / max(1, npos)
        drop = sum(1 for p in probs if p < th) / len(probs)
        print(f"  {th:5.2f}   {recall * 100:6.1f}%  {drop * 100:6.1f}%")
        if recall >= 1.0:
            max_safe = max(max_safe, th)
    if max_safe > 0:
        suggest = round(max(0.05, max_safe - 0.05), 2)
        print(f"\n  召回 100% 的最大丢弃线 = {max_safe:.2f} → 建议 JEV_DROP_BELOW = {suggest:.2f}（留安全余量）")

    # 立即处理阈值：默认 0.8 下误报多少（只影响花费不影响正确性）
    urgent_pos = sum(1 for p, y in zip(probs, labels) if y == 1 and p >= 0.8)
    urgent_neg = sum(1 for p, y in zip(probs, labels) if y == 0 and p >= 0.8)
    print(f"  JEV_URGENT_AT=0.8：命中真通知 {urgent_pos}/{npos}，误报 {urgent_neg} 条（只是早调一次 LLM）")

    # 延迟（交付判据：单批 p90 < 100ms，30 条/批）
    lat: list[float] = []
    for i in range(0, min(300, len(texts)), args.batch):
        enc = tok(texts[i : i + args.batch], truncation=True, max_length=args.max_len, padding=True, return_tensors="np")
        t0 = time.perf_counter()
        sess.run(None, {
            "input_ids": enc["input_ids"].astype(np.int64),
            "attention_mask": enc["attention_mask"].astype(np.int64),
        })
        lat.append((time.perf_counter() - t0) * 1000)
    if lat:
        lat.sort()
        print(f"\n单批（{args.batch} 条）CPU 推理：p50 {lat[len(lat) // 2]:.1f}ms / p90 {lat[min(len(lat) - 1, int(len(lat) * 0.9))]:.1f}ms")


if __name__ == "__main__":
    main()
