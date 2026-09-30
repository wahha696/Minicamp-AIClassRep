#!/usr/bin/env python3
"""Compare remote Jev vs local fastjudge on a JSONL holdout.

Outputs reports/compare-jev-local.json with:
  recall@0.2, miss_kill (误杀), neg_drop, precision_urgent@0.8, latency, disagreement samples.

If TYPESAFE_API_KEY is missing, Jev side is marked NOT_RUN; local side still runs.

Usage:
  eval "$(python3 /workspace/export_box_secrets.py)"   # optional; do not print keys
  python3 scripts/compare_jev_local.py \\
    --holdout data/holdout/v2.jsonl \\
    --model models/local-jev-v1.joblib \\
    --out reports/compare-jev-local.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from features import format_example  # noqa: E402
from rules import fuse_score  # noqa: E402

DROP = 0.2
URGENT = 0.8
JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def metrics_from_scores(labels: list[int], scores: list[float]) -> dict:
    n = len(labels)
    pos_idx = [i for i, y in enumerate(labels) if y == 1]
    neg_idx = [i for i, y in enumerate(labels) if y == 0]
    # recall@0.2: positives kept (score >= DROP)
    recall = (
        sum(1 for i in pos_idx if scores[i] >= DROP) / len(pos_idx) if pos_idx else None
    )
    # 误杀 = miss kill = positives dropped (score < DROP)
    miss_kill = (
        sum(1 for i in pos_idx if scores[i] < DROP) / len(pos_idx) if pos_idx else None
    )
    neg_drop = (
        sum(1 for i in neg_idx if scores[i] < DROP) / len(neg_idx) if neg_idx else None
    )
    urgent_pred = [i for i, s in enumerate(scores) if s >= URGENT]
    prec_urgent = (
        sum(1 for i in urgent_pred if labels[i] == 1) / len(urgent_pred)
        if urgent_pred
        else None
    )
    return {
        "n": n,
        "pos": len(pos_idx),
        "neg": len(neg_idx),
        "recall_pos@0.2": recall,
        "miss_kill_rate@0.2": miss_kill,
        "neg_drop_rate@0.2": neg_drop,
        "precision_urgent@0.8": prec_urgent,
    }


def score_local(rows: list[dict], model_path: Path) -> tuple[list[float], float]:
    import joblib

    pipe = joblib.load(model_path)["pipeline"]
    t0 = time.perf_counter()
    scores: list[float] = []
    for r in rows:
        X = [format_example(r)]
        raw = float(pipe.predict_proba(X)[:, 1][0])
        scores.append(fuse_score(raw, r))
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return scores, elapsed_ms


def score_jev_one(row: dict, api_key: str, model: str, timeout_s: float) -> float:
    body = {
        "model": model,
        "state": {
            "group_name": row.get("group_name") or "",
            "previous_messages": [
                {"sender_name": c.get("sender_name", ""), "text": c.get("text", "")}
                for c in (row.get("context") or [])
            ],
            "messages": [
                {
                    "sender_name": (row.get("message") or {}).get("sender_name", ""),
                    "text": (row.get("message") or {}).get("text", ""),
                }
            ],
        },
        "questions": {
            "message_0": {
                "type": "noul",
                "instructions": (
                    "结合群聊上下文，`messages[0]` 是否提供可能影响学生日程或待办的具体信息？"
                    "只判断这条消息，其他消息仅作上下文。"
                ),
                "criteria": {
                    "true": (
                        "考试、作业、会议、活动、通知的时间、地点、要求，或其改期、取消、补充、确认；"
                        "已说定具体时间或日期的聚餐、吃饭、出游、打球等约定也算；"
                        "零碎但可与上下文拼成这些信息的片段也算。"
                    ),
                    "false": (
                        "纯闲聊、寒暄、表情、无关讨论，或没有说定时间的随口提议、询问，例如“晚上约饭吗”。"
                    ),
                },
            }
        },
    }
    req = urllib.request.Request(
        JEV_ENDPOINT,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return float(payload["answers"]["message_0"]["noul"])


def score_jev(
    rows: list[dict], api_key: str, model: str, timeout_s: float, limit: int | None
) -> tuple[list[float] | None, float, str | None]:
    target = rows if limit is None else rows[:limit]
    scores: list[float] = []
    t0 = time.perf_counter()
    try:
        for r in target:
            scores.append(score_jev_one(r, api_key, model, timeout_s))
    except Exception as e:  # noqa: BLE001
        return None, (time.perf_counter() - t0) * 1000.0, type(e).__name__
    # If limited, pad with None markers by only returning for subset — caller handles
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return scores, elapsed_ms, None


def disagreements(
    rows: list[dict],
    labels: list[int],
    local_scores: list[float],
    remote_scores: list[float] | None,
    top_k: int = 20,
) -> list[dict]:
    if remote_scores is None:
        return []
    diffs = []
    for i, (ls, rs) in enumerate(zip(local_scores, remote_scores)):
        d = abs(ls - rs)
        route_diff = (ls < DROP) != (rs < DROP) or (ls >= URGENT) != (rs >= URGENT)
        if d >= 0.25 or route_diff:
            msg = rows[i].get("message") or {}
            diffs.append(
                {
                    "id": rows[i].get("id"),
                    "label": labels[i],
                    "local": ls,
                    "jev": rs,
                    "abs_diff": d,
                    "route_diff": route_diff,
                    "text": (msg.get("text") or "")[:120],
                }
            )
    diffs.sort(key=lambda x: (-int(x["route_diff"]), -x["abs_diff"]))
    return diffs[:top_k]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--holdout", type=Path, default=ROOT / "data" / "holdout" / "v2.jsonl")
    ap.add_argument("--model", type=Path, default=ROOT / "models" / "local-jev-v1.joblib")
    ap.add_argument("--out", type=Path, default=ROOT / "reports" / "compare-jev-local.json")
    ap.add_argument("--jev-model", default=os.environ.get("JEV_MODEL", "jev-latest"))
    ap.add_argument("--jev-timeout", type=float, default=3.0)
    ap.add_argument(
        "--jev-limit",
        type=int,
        default=None,
        help="Cap remote Jev calls (cost). Default: all rows when key present.",
    )
    args = ap.parse_args()

    rows = load_jsonl(args.holdout)
    if not rows:
        raise SystemExit(f"empty holdout: {args.holdout}")

    labels = [int(r.get("label", 0)) for r in rows]
    local_scores, local_ms = score_local(rows, args.model)
    local_metrics = metrics_from_scores(labels, local_scores)
    local_metrics["latency_ms_total"] = local_ms
    local_metrics["latency_ms_per_sample"] = local_ms / max(1, len(rows))

    api_key = (os.environ.get("TYPESAFE_API_KEY") or "").strip()
    jev_block: dict
    remote_scores: list[float] | None = None

    if not api_key:
        jev_block = {
            "status": "NOT_RUN",
            "reason": "TYPESAFE_API_KEY missing",
            "hint": 'eval "$(python3 /workspace/export_box_secrets.py)" then re-run if card has the key',
        }
    else:
        limit = args.jev_limit
        subset = rows if limit is None else rows[:limit]
        remote_scores, jev_ms, err = score_jev(
            subset, api_key, args.jev_model, args.jev_timeout, None
        )
        if remote_scores is None:
            jev_block = {
                "status": "NOT_RUN",
                "reason": f"jev_error:{err}",
                "latency_ms_total": jev_ms,
            }
        else:
            # Align metrics to scored subset
            sub_labels = labels[: len(remote_scores)]
            m = metrics_from_scores(sub_labels, remote_scores)
            m["latency_ms_total"] = jev_ms
            m["latency_ms_per_sample"] = jev_ms / max(1, len(remote_scores))
            m["scored_n"] = len(remote_scores)
            jev_block = {"status": "ok", "metrics": m}

    # Pad remote to full length only when fully scored
    remote_full = remote_scores if remote_scores and len(remote_scores) == len(rows) else None
    disag = disagreements(rows, labels, local_scores, remote_full)

    report = {
        "holdout": str(args.holdout),
        "model": str(args.model),
        "thresholds": {"drop_below": DROP, "urgent_at": URGENT},
        "local": {"status": "ok", "metrics": local_metrics},
        "jev": jev_block,
        "disagreement_samples": disag,
        "notes": [
            "Local uses jieba+TFIDF+CalibratedLR with rules fusion (infer.score_with_local).",
            "Jev uses TypeSafe systemone noul questions one message per request.",
            "Miss-kill = positives scored < 0.2 (dropped from LLM).",
        ],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    print(f"local recall@0.2={local_metrics['recall_pos@0.2']} miss_kill={local_metrics['miss_kill_rate@0.2']} "
          f"neg_drop={local_metrics['neg_drop_rate@0.2']} urgent_p={local_metrics['precision_urgent@0.8']}")
    print(f"jev status={jev_block.get('status')}")


if __name__ == "__main__":
    main()
