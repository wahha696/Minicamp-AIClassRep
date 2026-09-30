#!/usr/bin/env python3
"""Merge raw JSONL → all.jsonl; split by group_name (seed=20260928).

Mock groups: prefer val+test (≥50% of mock samples to test), small train anchor.
Synth groups: hash bucket → ~70/15/15 by group count.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED = 20260928


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for ln in path.read_text(encoding="utf-8").splitlines():
        ln = ln.strip()
        if ln:
            rows.append(json.loads(ln))
    return rows


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def group_hash(name: str) -> float:
    h = hashlib.sha256(f"{SEED}:{name}".encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF


def split_label_for_synth_group(name: str) -> str:
    x = group_hash(name)
    if x < 0.70:
        return "train"
    if x < 0.85:
        return "val"
    return "test"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", type=Path, default=ROOT / "data" / "raw")
    ap.add_argument("--splits-dir", type=Path, default=ROOT / "data" / "splits")
    ap.add_argument("--reports-dir", type=Path, default=ROOT / "reports")
    args = ap.parse_args()

    synth = load_jsonl(args.raw_dir / "synth.jsonl")
    mock = load_jsonl(args.raw_dir / "mock.jsonl")
    human = load_jsonl(args.raw_dir / "human.jsonl")
    all_rows = synth + mock + human
    write_jsonl(args.raw_dir / "all.jsonl", all_rows)

    buckets: dict[str, list[dict]] = {"train": [], "val": [], "test": []}

    # --- mock: by scenario/group, put majority to test/val ---
    mock_by_group: dict[str, list[dict]] = defaultdict(list)
    for r in mock:
        mock_by_group[r["group_name"]].append(r)

    mock_groups = sorted(mock_by_group.keys())
    rng = random.Random(SEED)
    rng.shuffle(mock_groups)
    # Assign whole groups: ~1/6 train anchor, ~1/3 val, rest test (≥ half samples → test ideally)
    n = len(mock_groups)
    n_train = max(1, n // 6) if n else 0
    n_val = max(1, n // 3) if n else 0
    for i, g in enumerate(mock_groups):
        if i < n_train:
            split = "train"
        elif i < n_train + n_val:
            split = "val"
        else:
            split = "test"
        buckets[split].extend(mock_by_group[g])

    # Ensure ≥50% mock samples in test: if not, move largest val groups to test
    mock_ids = {r["id"] for r in mock}
    def mock_count(split: str) -> int:
        return sum(1 for r in buckets[split] if r["id"] in mock_ids)

    total_mock = len(mock)
    if total_mock and mock_count("test") < total_mock * 0.5:
        # move groups from val then train
        for src in ("val", "train"):
            by_g = defaultdict(list)
            for r in list(buckets[src]):
                if r["id"] in mock_ids:
                    by_g[r["group_name"]].append(r)
            for g, rows in sorted(by_g.items(), key=lambda x: -len(x[1])):
                if mock_count("test") >= total_mock * 0.5:
                    break
                # relocate
                keep = [r for r in buckets[src] if r["group_name"] != g]
                move = [r for r in buckets[src] if r["group_name"] == g]
                buckets[src] = keep
                buckets["test"].extend(move)

    # --- synth + human: group hash ---
    for r in synth + human:
        split = split_label_for_synth_group(r["group_name"])
        buckets[split].append(r)

    for split, rows in buckets.items():
        write_jsonl(args.splits_dir / f"{split}.jsonl", rows)

    stats = {}
    for split, rows in buckets.items():
        pos = sum(1 for r in rows if r["label"] == 1)
        groups = sorted({r["group_name"] for r in rows})
        stats[split] = {
            "n": len(rows),
            "pos": pos,
            "neg": len(rows) - pos,
            "pos_ratio": round(pos / max(1, len(rows)), 4),
            "n_groups": len(groups),
            "mock_n": sum(1 for r in rows if r.get("source") == "mock"),
            "synth_n": sum(1 for r in rows if r.get("source") == "synth"),
        }
    stats["seed"] = SEED
    stats["total"] = len(all_rows)
    args.reports_dir.mkdir(parents=True, exist_ok=True)
    (args.reports_dir / "split-stats.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
