#!/usr/bin/env python3
"""Evaluate joblib model → reports/metrics-v1.json."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from features import format_example  # noqa: E402
from rules import fuse_scores  # noqa: E402


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=Path, default=ROOT / "models" / "local-jev-v1.joblib")
    ap.add_argument("--test", type=Path, default=ROOT / "data" / "splits" / "test.jsonl")
    ap.add_argument("--out", type=Path, default=ROOT / "reports" / "metrics-v1.json")
    args = ap.parse_args()

    import joblib
    import numpy as np

    bundle = joblib.load(args.model)
    pipe = bundle["pipeline"]
    rows = load_jsonl(args.test)
    X = [format_example(r) for r in rows]
    y = np.array([int(r["label"]) for r in rows], dtype=int)

    t0 = time.perf_counter()
    proba = pipe.predict_proba(X)[:, 1]
    proba = np.asarray(fuse_scores([float(x) for x in proba], rows), dtype=float)
    elapsed = time.perf_counter() - t0
    n = len(rows)
    per = (elapsed / max(1, n)) * 1000

    # batch-30 latency estimate
    t1 = time.perf_counter()
    _ = pipe.predict_proba(X[: min(30, n)])
    batch30_ms = (time.perf_counter() - t1) * 1000

    pos = y == 1
    neg = y == 0
    recall_02 = float(((proba >= 0.2) & pos).sum() / max(1, pos.sum()))
    miss_02 = 1.0 - recall_02
    drop_neg = float(((proba < 0.2) & neg).sum() / max(1, neg.sum()))
    fpr_02 = float(((proba >= 0.2) & neg).sum() / max(1, neg.sum()))
    urgent = proba >= 0.8
    prec_08 = float((pos & urgent).sum() / max(1, urgent.sum())) if urgent.any() else None
    pred05 = (proba >= 0.5).astype(int)
    acc = float((pred05 == y).mean())

    size_mb = args.model.stat().st_size / (1024 * 1024)
    metrics = {
        "model": str(args.model),
        "test_n": n,
        "pos": int(pos.sum()),
        "neg": int(neg.sum()),
        "accuracy@0.5": acc,
        "recall_pos@0.2": recall_02,
        "miss_kill_rate@0.2": miss_02,
        "neg_drop_rate@0.2": drop_neg,
        "false_positive_rate@0.2": fpr_02,
        "precision_urgent@0.8": prec_08,
        "latency_ms_per_sample": round(per, 3),
        "latency_ms_batch30": round(batch30_ms, 3),
        "model_size_mb": round(size_mb, 3),
        "meta": {**(bundle.get("meta", {})), "rules_fusion": True},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
