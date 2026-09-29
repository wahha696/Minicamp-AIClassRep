#!/usr/bin/env python3
"""Local scoreWithJev-compatible CLI.

Input JSON stdin or --file:
  {"group_name":"...", "context":[{"sender_name","text"}], "candidates":[{"sender_name","text"}]}
Output: {"scores":[...]} or {"scores":null,"error":"..."}
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from features import format_example  # noqa: E402
from rules import fuse_score  # noqa: E402


def score_with_local(pipe, candidates: list[dict], context: list[dict], group_name: str) -> list[float]:
    rows = [
        {
            "group_name": group_name,
            "context": context or [],
            "message": c,
        }
        for c in candidates
    ]
    X = [format_example(r) for r in rows]
    raw = [float(x) for x in pipe.predict_proba(X)[:, 1]]
    return [fuse_score(s, r) for s, r in zip(raw, rows)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=Path, default=ROOT / "models" / "local-jev-v1.joblib")
    ap.add_argument("--file", type=Path, default=None)
    args = ap.parse_args()

    import joblib

    try:
        bundle = joblib.load(args.model)
        pipe = bundle["pipeline"]
        raw = args.file.read_text(encoding="utf-8") if args.file else sys.stdin.read()
        payload = json.loads(raw)
        scores = score_with_local(
            pipe,
            payload.get("candidates") or [],
            payload.get("context") or [],
            payload.get("group_name") or "",
        )
        print(json.dumps({"scores": scores}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001 — CLI fallback mirrors jev null
        print(json.dumps({"scores": None, "error": type(e).__name__}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
