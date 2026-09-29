#!/usr/bin/env python3
"""CPU train: jieba + TfidfVectorizer + CalibratedClassifierCV(LogisticRegression) → joblib.

No torch / sentence-transformers. One full fit (= '1 epoch' for linear models).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from features import format_example, tokenize  # noqa: E402


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    for ln in path.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if ln:
            rows.append(json.loads(ln))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=Path, default=ROOT / "data" / "splits" / "train.jsonl")
    ap.add_argument("--val", type=Path, default=ROOT / "data" / "splits" / "val.jsonl")
    ap.add_argument("--out", type=Path, default=ROOT / "models" / "local-jev-v1.joblib")
    ap.add_argument("--C", type=float, default=1.0)
    ap.add_argument("--max-features", type=int, default=80000)
    ap.add_argument("--calibration", choices=["sigmoid", "isotonic"], default="sigmoid")
    args = ap.parse_args()

    import joblib
    import numpy as np
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline

    train = load_jsonl(args.train)
    if not train:
        print(f"ERROR: empty train set {args.train}", file=sys.stderr)
        sys.exit(1)

    X = [format_example(r) for r in train]
    y = np.array([int(r["label"]) for r in train], dtype=int)
    print(f"train n={len(train)} pos={int(y.sum())} neg={int((1-y).sum())}")

    base = LogisticRegression(
        C=args.C,
        max_iter=500,
        solver="liblinear",
        class_weight="balanced",
        random_state=20260928,
    )
    # cv=3 for calibration; small data may use 2
    cv = 3 if len(train) >= 60 else 2
    clf = CalibratedClassifierCV(base, method=args.calibration, cv=cv)

    pipe = Pipeline(
        [
            (
                "tfidf",
                TfidfVectorizer(
                    tokenizer=tokenize,
                    preprocessor=None,
                    token_pattern=None,
                    lowercase=False,
                    max_features=args.max_features,
                    min_df=1,
                    sublinear_tf=True,
                ),
            ),
            ("clf", clf),
        ]
    )

    t0 = time.time()
    pipe.fit(X, y)
    fit_s = time.time() - t0
    print(f"fit done in {fit_s:.2f}s (sklearn full fit = 1 epoch equivalent)")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "pipeline": pipe,
            "meta": {
                "version": "local-jev-v1",
                "base": "jieba+tfidf+CalibratedLogReg",
                "calibration": args.calibration,
                "train_n": len(train),
                "fit_seconds": fit_s,
                "seed": 20260928,
            },
        },
        args.out,
    )
    size_mb = args.out.stat().st_size / (1024 * 1024)
    print(f"saved {args.out} ({size_mb:.2f} MB)")

    if args.val.exists():
        val = load_jsonl(args.val)
        if val:
            from sklearn.metrics import accuracy_score, f1_score, roc_auc_score

            Xv = [format_example(r) for r in val]
            yv = np.array([int(r["label"]) for r in val], dtype=int)
            proba = pipe.predict_proba(Xv)[:, 1]
            pred = (proba >= 0.5).astype(int)
            metrics = {
                "val_n": len(val),
                "accuracy@0.5": float(accuracy_score(yv, pred)),
                "f1@0.5": float(f1_score(yv, pred, zero_division=0)),
                "recall_pos@0.2": float(((proba >= 0.2) & (yv == 1)).sum() / max(1, (yv == 1).sum())),
                "drop_neg@0.2": float(((proba < 0.2) & (yv == 0)).sum() / max(1, (yv == 0).sum())),
            }
            try:
                metrics["roc_auc"] = float(roc_auc_score(yv, proba))
            except ValueError:
                metrics["roc_auc"] = None
            print("val:", json.dumps(metrics, ensure_ascii=False))


if __name__ == "__main__":
    main()
