# -*- coding: utf-8 -*-
"""Jev 快判基线：TF-IDF(char 1~3gram) + LogisticRegression（操作手册 §3 第 1 步，30 分钟锚点）。

用法（在 train 的 venv 里，或任何装了 scikit-learn 的 Python）：
  python train/jev/01_baseline.py --train train/data/jev-train.jsonl --val train/data/jev-val.jsonl

产出：train/artifacts/jev-baseline-metrics.json + 控制台报告（AUC / PR-AUC / 召回门槛建议）。
门槛语义对齐 jev.ts：drop_below = 能丢掉的分数线（要求真通知召回 100%）。
"""
from __future__ import annotations

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # GBK console guard
import argparse
import json
import time
from pathlib import Path

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score

HERE = Path(__file__).resolve().parent
ARTIFACTS = HERE.parent / "artifacts"


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t:
                rows.append(json.loads(t))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default=str(HERE.parent / "data" / "jev-train.jsonl"))
    ap.add_argument("--val", default=str(HERE.parent / "data" / "jev-val.jsonl"))
    ap.add_argument("--out", default=str(ARTIFACTS / "jev-baseline-metrics.json"))
    args = ap.parse_args()

    train = load_jsonl(Path(args.train))
    val = load_jsonl(Path(args.val))
    print(f"train={len(train)} val={len(val)}")

    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(1, 3), min_df=2, max_features=200_000)
    xtr = vec.fit_transform([r["text"] for r in train])
    xva = vec.transform([r["text"] for r in val])
    ytr = [r["label"] for r in train]
    yva = [r["label"] for r in val]

    t0 = time.time()
    clf = LogisticRegression(max_iter=2000, class_weight="balanced", C=4.0)
    clf.fit(xtr, ytr)
    fit_s = time.time() - t0

    prob = clf.predict_proba(xva)[:, 1]
    auc = roc_auc_score(yva, prob)
    ap = average_precision_score(yva, prob)

    pos = sorted(p for p, y in zip(prob, yva) if y == 1)
    neg = sorted(p for p, y in zip(prob, yva) if y == 0)
    # 真通知召回 100% 的最高丢弃阈值 = 最低正样本分
    recall_floor = pos[0] if pos else 0.0
    # 丢弃阈值扫描：丢弃多少候选（≈省多少 LLM 调用）
    scan = []
    for th in (0.05, 0.1, 0.2, 0.3, 0.4, 0.5):
        dropped = sum(1 for p in prob if p < th)
        kept_pos = sum(1 for p, y in zip(prob, yva) if y == 1 and p >= th)
        recall = kept_pos / max(1, sum(yva))
        scan.append({"threshold": th, "recall": round(recall, 4), "drop_rate": round(dropped / len(prob), 4)})

    metrics = {
        "model": "tfidf-char12-3+logreg",
        "val_auc": round(float(auc), 4),
        "val_pr_auc": round(float(ap), 4),
        "recall100_max_drop_threshold": round(recall_floor, 4),
        "n_pos": int(sum(yva)),
        "n_val": len(val),
        "fit_seconds": round(fit_s, 1),
        "threshold_scan": scan,
        "note": "recall100_max_drop_threshold = 真通知最低分；超过它就会丢真通知（参考 jev-calibrate 口径）",
    }
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(metrics, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=1))
    print(f"\n→ {args.out}")


if __name__ == "__main__":
    main()
