# -*- coding: utf-8 -*-
"""Jev 快判正式模型：hfl/rbt3（3 层 RoBERTa，38M）全参微调（操作手册 §3 第 2 步）。

  python train/jev/02_train_rbt3.py                # 默认超参（lr 2e-5 / 3 epoch / batch 32 / max_len 256）
  python train/jev/02_train_rbt3.py --epochs 4     # 覆盖任意超参

- 8GB 显存占用 ~3GB，5070 上十几分钟一个 epoch；
- 数据行格式（gen-jev-data.js 产出）：{"text": "群名 [SEP] 上一条 [SEP] 本条", "label": 0|1}
- 保存：train/models/jev-rbt3/（HF 格式，含 tokenizer，供 03_export_onnx.py 导出）。
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


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t:
                rows.append(json.loads(t))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="hfl/rbt3")
    ap.add_argument("--train", default=str(HERE.parent / "data" / "jev-train.jsonl"))
    ap.add_argument("--val", default=str(HERE.parent / "data" / "jev-val.jsonl"))
    ap.add_argument("--out", default=str(HERE.parent / "models" / "jev-rbt3"))
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--max-len", type=int, default=256)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--hf-mirror", action="store_true", help="HF_ENDPOINT=https://hf-mirror.com")
    args = ap.parse_args()

    if args.hf_mirror:
        import os

        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    import torch
    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
        Trainer,
        TrainingArguments,
    )

    if not torch.cuda.is_available():
        raise SystemExit("没有检测到 CUDA：rbt3 训练请用 GPU（5070 上十几分钟一个 epoch）。CPU 仅调试用。")
    print(f"CUDA：{torch.cuda.get_device_name(0)}，capability={torch.cuda.get_device_capability()}")

    train_rows = load_jsonl(Path(args.train))
    val_rows = load_jsonl(Path(args.val))
    print(f"train={len(train_rows)} val={len(val_rows)}")

    tok = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForSequenceClassification.from_pretrained(args.base, num_labels=2)

    # 原生 torch Dataset（绕开 datasets 5.x 的指纹哈希 bug；预分词后 padding 由 collator 完成）
    class _Rows(torch.utils.data.Dataset):
        def __init__(self, rows: list[dict]):
            self.enc = tok([r["text"] for r in rows], truncation=True, max_length=args.max_len)
            self.labels = [int(r["label"]) for r in rows]

        def __len__(self) -> int:
            return len(self.labels)

        def __getitem__(self, i: int) -> dict:
            return {
                "input_ids": self.enc["input_ids"][i],
                "attention_mask": self.enc["attention_mask"][i],
                "labels": self.labels[i],
            }

    ds_train = _Rows(train_rows)
    ds_val = _Rows(val_rows)

    def metrics(eval_pred) -> dict:
        import numpy as np
        from sklearn.metrics import average_precision_score, roc_auc_score

        logits, labels = eval_pred
        # 二分类单 logit（BCEWithLogits）或双 logit 都兼容
        if logits.shape[-1] == 1:
            prob = 1.0 / (1.0 + np.exp(-logits[:, 0]))
        else:
            ex = np.exp(logits - logits.max(axis=1, keepdims=True))
            prob = ex[:, 1] / ex.sum(axis=1)
        y = labels.astype(int)
        out = {
            "pr_auc": float(average_precision_score(y, prob)),
            "acc@0.5": float(((prob >= 0.5) == (y == 1)).mean()),
        }
        try:
            out["auc"] = float(roc_auc_score(y, prob))
        except ValueError:
            out["auc"] = 0.0
        return out

    targs = TrainingArguments(
        output_dir=str(HERE.parent / "artifacts" / "jev-rbt3-runs"),
        per_device_train_batch_size=args.batch,
        per_device_eval_batch_size=args.batch * 2,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        weight_decay=0.01,
        warmup_steps=45,  # ≈6% of 750 steps（8000 样本 × 3 epoch / bs32；v5 移除了 warmup_ratio）
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=50,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="pr_auc",
        greater_is_better=True,
        save_total_limit=1,
        report_to=[],
        seed=args.seed,
        dataloader_num_workers=0,  # Windows spawn 不支持嵌套类；数据已预分词，主进程加载无瓶颈
    )

    from transformers import DataCollatorWithPadding

    trainer = Trainer(
        model=model,
        args=targs,
        train_dataset=ds_train,
        eval_dataset=ds_val,
        data_collator=DataCollatorWithPadding(tok),
        compute_metrics=metrics,
    )
    trainer.train()

    out = Path(args.out)
    model.save_pretrained(str(out))
    tok.save_pretrained(str(out))
    final = trainer.evaluate()
    print(json.dumps(final, ensure_ascii=False, indent=1))
    (out / "eval.json").write_text(json.dumps(final, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\n✅ 模型已存 {out}")


if __name__ == "__main__":
    main()
