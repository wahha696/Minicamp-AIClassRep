#!/usr/bin/env python3
"""Local scoreWithJev-compatible CLI.

Input JSON stdin or --file:
  {"group_name":"...", "context":[{"sender_name","text"}], "candidates":[{"sender_name","text"}]}
Output: {"scores":[...]} or {"scores":null,"error":"..."}

--serve：常驻 worker 模式（R1）。模型只加载一次，随后按行读取 stdin 的 JSON
（可带 "seq" 透传字段供调用方对账），每行请求回一行 {"seq":N,"scores":[...]}。
进程退出即stdin关闭；单次异常只影响当行，不杀死 worker。
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


def _score_payload(pipe, payload: dict) -> list[float]:
    return score_with_local(
        pipe,
        payload.get("candidates") or [],
        payload.get("context") or [],
        payload.get("group_name") or "",
    )


def serve(pipe) -> None:
    """按行读 JSON 请求，按行写结果；seq 原样透传。单行出错不退出。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        seq = None
        try:
            payload = json.loads(line)
            seq = payload.get("seq")
            scores = _score_payload(pipe, payload)
            print(json.dumps({"seq": seq, "scores": scores}, ensure_ascii=False), flush=True)
        except Exception as e:  # noqa: BLE001 — 单行失败回错误，worker 继续服务
            print(json.dumps({"seq": seq, "scores": None, "error": type(e).__name__}, ensure_ascii=False), flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", type=Path, default=ROOT / "models" / "local-jev-v1.joblib")
    ap.add_argument("--file", type=Path, default=None)
    ap.add_argument("--serve", action="store_true", help="常驻：按行读 stdin JSON，按行写 scores（模型只加载一次）")
    args = ap.parse_args()

    import joblib

    try:
        bundle = joblib.load(args.model)
        pipe = bundle["pipeline"]
        if args.serve:
            serve(pipe)
            return
        raw = args.file.read_text(encoding="utf-8") if args.file else sys.stdin.read()
        payload = json.loads(raw)
        scores = _score_payload(pipe, payload)
        print(json.dumps({"scores": scores}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001 — CLI fallback mirrors jev null
        print(json.dumps({"scores": None, "error": type(e).__name__}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
