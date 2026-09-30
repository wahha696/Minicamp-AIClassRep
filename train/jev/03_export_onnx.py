# -*- coding: utf-8 -*-
"""Jev 分类器导出 ONNX + INT8 动态量化（操作手册 §3 第 3 步，产物 ~40MB）。

  python train/jev/03_export_onnx.py --model train/models/jev-rbt3 --val train/data/jev-val.jsonl

产出 train/models/jev-classifier-onnx/：
  model.onnx             fp32（一致性校验基准）
  model_quantized.onnx   INT8 动态量化（交付物，onnxruntime-node 直接加载）
  tokenizer/             分词器（M2 集成时随 ONNX 一起分发）
  export-meta.json       文本形态、量化信息、阈值说明
"""
from __future__ import annotations

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # GBK console guard
import argparse
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def load_val(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t:
                rows.append(json.loads(t))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(HERE.parent / "models" / "jev-rbt3"))
    ap.add_argument("--val", default=str(HERE.parent / "data" / "jev-val.jsonl"))
    ap.add_argument("--out", default=str(HERE.parent / "models" / "jev-classifier-onnx"))
    ap.add_argument("--max-len", type=int, default=256)
    ap.add_argument("--check-n", type=int, default=256)
    args = ap.parse_args()

    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    src = Path(args.model)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    tok = AutoTokenizer.from_pretrained(str(src))
    model = AutoModelForSequenceClassification.from_pretrained(str(src))
    model.eval()

    # ---- 1) 导出 fp32 ONNX（动态 batch / seq）----
    onnx_path = out / "model.onnx"
    dummy = tok("冒烟输入：明天下午两点开会", return_tensors="pt")
    torch.onnx.export(
        model,
        (dummy["input_ids"], dummy["attention_mask"]),
        str(out / "model.onnx"),
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "logits": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    fp_mb = (out / "model.onnx").stat().st_size / 1e6
    print(f"fp32 ONNX：{fp_mb:.1f}MB")

    # ---- 2) INT8 动态量化 ----
    from onnxruntime.quantization import QuantType, quantize_dynamic

    q_path = out / "model_quantized.onnx"
    quantize_dynamic(str(out / "model.onnx"), str(q_path), weight_type=QuantType.QInt8)
    q_size = q_path.stat().st_size / 1e6
    print(f"INT8 量化后 {q_size:.1f}MB（交付物）")

    # ---- 3) 一致性校验：PyTorch vs ONNX ----
    import onnxruntime as ort

    sess = ort.InferenceSession(str(out / "model.onnx"), providers=["CPUExecutionProvider"])
    rows = []
    with open(Path(args.val), "r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t:
                rows.append(json.loads(t))
    texts = [r["text"] for r in rows[: args.check_n]]
    batch = tok(texts, truncation=True, max_length=args.max_len, padding=True, return_tensors="pt")
    with torch.no_grad():
        ref = torch.softmax(model(**batch).logits.float(), -1)[:, 1].numpy()
    onnx_out = sess.run(None, {
        "input_ids": batch["input_ids"].numpy(),
        "attention_mask": batch["attention_mask"].numpy(),
    })[0]
    onnx_prob = torch.softmax(torch.from_numpy(onnx_out).float(), -1)[:, 1].numpy()
    diff = float(np.max(np.abs(ref - onnx_prob)))
    print(f"PyTorch vs ONNX 最大概率差：{diff:.2e}（<0.02 视为通过）")
    if diff > 0.02:
        raise SystemExit("❌ ONNX 与 PyTorch 输出差异过大，检查导出配置")

    # ---- 4) 元信息 ----
    meta = {
        "source": str(src),
        "text_format": "群名 [SEP] 上一条消息(可空) [SEP] 本条消息",
        "max_len": args.max_len,
        "output": "二分类 softmax，取 index=1 的概率（= jev noul 分数语义）",
        "quantized_file": "model_quantized.onnx",
        "quantized_mb": round(q_size, 1),
        "fp32_mb": round(fp_mb, 1),
        "parity_max_diff": diff,
        "note": "阈值必须用 jev-calibrate 本地化后重扫（见 04_thresholds.py），本地分数分布 ≠ TypeSafe",
    }
    (out / "export-meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tok.save_pretrained(str(out / "tokenizer"))
    print(f"✅ 导出完成 → {out}（交付 model_quantized.onnx + tokenizer/ + export-meta.json）")


if __name__ == "__main__":
    main()
