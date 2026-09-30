# -*- coding: utf-8 -*-
"""GGUF 冒烟（操作手册 §6 验收门 1/4/5）：直接打 llama-server 的 OpenAI 兼容端点。

  1) 先起服务：llama-server -m train/models/extract-Q4_K_M.gguf --port 8080 --ctx-size 8192 --jinja
  2) python train/extract/04_smoke_gguf.py --n 20

检查：/health 就绪、输出纯 JSON、无 think 前缀、时延。退出码非 0 = 有样本带 think 前缀或非法 JSON。
（事件字段级精度验收走 eval.ts，见 train/README）
"""
from __future__ import annotations

import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # GBK console guard
import argparse
import json
import re
import statistics
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPEN_TAG = "<" + "think" + ">"
THINK_RE = re.compile(r"^\s*" + re.escape(OPEN_TAG), re.IGNORECASE)


def chat(base: str, model: str, system: str, user: str, timeout: int = 900) -> tuple[str, float]:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "max_tokens": 2048,
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer local"},
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as res:
        obj = json.loads(res.read().decode("utf-8"))
    ms = (time.perf_counter() - t0) * 1000
    content = (obj.get("choices") or [{}])[0].get("message", {}).get("content", "")
    return content, ms


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default="extract")
    ap.add_argument("--data", default=str(HERE.parent / "data" / "sft-v1.jsonl"))
    ap.add_argument("--n", type=int, default=10, help="抽样条数")
    args = ap.parse_args()

    root = args.base.split("/v1")[0]
    with urllib.request.urlopen(root + "/health", timeout=5) as res:
        health = res.read().decode("utf-8")
    print(f"/health → {health.strip()[:80]}")

    rows: list[dict] = []
    with open(Path(args.data), "r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t:
                rows.append(json.loads(t))
    if not rows:
        raise SystemExit(f"没有数据 {args.data}（先跑教师蒸馏 gen-sft-data.js）")
    rows = rows[: args.n]
    print(f"抽样 {len(rows)} 条")

    n = len(rows)
    ok_json = 0
    think_hits = 0
    lat: list[float] = []
    for i, r in enumerate(rows):
        conv = {c["from"]: c["value"] for c in r["conversations"]}
        content, ms = chat(args.base, args.model, conv["system"], conv["human"])
        lat.append(ms)
        has_think = bool(THINK_RE.match(content))
        try:
            json.loads(content)
            legal = True
        except json.JSONDecodeError as e:
            legal = False
            print(f"  ✗ #{i} 非法 JSON（{e}）：{content[:60]!r}")
        if legal:
            ok_json += 1
        if has_think:
            think_hits += 1
            print(f"  ✗ #{i} 带 think 前缀：{content[:60]!r}")
        mark = "✓" if legal and not has_think else "✗"
        print(f"  {mark} #{i} {ms / 1000:.1f}s  {content[:50]!r}")

    print("\n======== 冒烟结果")
    print(f"样本 {len(rows)} | JSON 合法 {ok_json}（{ok_json / max(1, n) * 100:.0f}%，门 ≥99%）| think 前缀 {think_hits}（门 0）")
    if lat:
        print(f"时延：p50 {statistics.median(lat) / 1000:.1f}s / mean {statistics.mean(lat) / 1000:.1f}s / max {max(lat) / 1000:.1f}s")
    passed = think_hits == 0 and ok_json == n
    print(("✅ 冒烟通过" if passed else "❌ 冒烟不通过") + "；精度验收跑 eval.ts（见 train/README）")
    raise SystemExit(0 if passed else 1)


if __name__ == "__main__":
    main()
