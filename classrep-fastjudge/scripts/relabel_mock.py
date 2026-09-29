#!/usr/bin/env python3
"""Relabel mock.jsonl with DeepSeek teacher (same criteria as synthesize)."""
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
DEFAULT_IN = ROOT / "data" / "raw" / "mock.jsonl"
BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

SYSTEM = """你是大学 QQ 群「日程信号快判」标注器，与 TypeSafe Jev 口径一致。
硬标签 label: 1=schedule_signal，0=noise_or_chatter。
- 正例：考试/作业/会议/活动/通知的时间地点要求，或其改期取消补充确认；已说定具体时间或日期的聚餐吃饭出游打球；可与上下文拼成这些信息的短片段（如「取消了」「改线上」）。
- 反例：纯闲聊寒暄表情；没有说定时间的随口提议（如「晚上约饭吗」）。
soft_label: 0~1，与 label 同向（正例通常≥0.7，反例通常≤0.3，边界 0.4~0.6）。
只输出 JSON，不要 markdown。"""

USER_TMPL = """请为下列 {n} 条样本打 label 与 soft_label。每条已有 id。
严格输出：{{"labels":[{{"id":"...","label":0或1,"soft_label":0.0到1.0,"notes":"短说明"}}]}}

样本：
{payload}
"""


def chat(api_key: str, messages: list[dict], temperature: float = 0.2) -> str:
    url = f"{BASE}/v1/chat/completions"
    body = json.dumps(
        {
            "model": MODEL,
            "messages": messages,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def compact(row: dict) -> dict:
    ctx = row.get("context") or []
    ctx = ctx[-5:]
    return {
        "id": row["id"],
        "group_name": row.get("group_name", ""),
        "context": [{"sender_name": c.get("sender_name", ""), "text": c.get("text", "")} for c in ctx],
        "message": row.get("message") or {},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", type=Path, default=DEFAULT_IN)
    ap.add_argument("--out", type=Path, default=None, help="default: overwrite --in")
    ap.add_argument("--batch-size", type=int, default=15)
    ap.add_argument("--backup", action="store_true", default=True)
    args = ap.parse_args()
    out = args.out or args.inp

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        print("ERROR: DEEPSEEK_API_KEY not set", file=sys.stderr)
        sys.exit(2)

    rows = [json.loads(ln) for ln in args.inp.read_text(encoding="utf-8").splitlines() if ln.strip()]
    if args.backup:
        bak = args.inp.with_suffix(".jsonl.bak-heuristic")
        if not bak.exists():
            bak.write_text(args.inp.read_text(encoding="utf-8"), encoding="utf-8")
            print(f"backup → {bak}")

    by_id = {r["id"]: r for r in rows}
    ids = [r["id"] for r in rows]
    labeled = 0
    failures = 0
    i = 0
    while i < len(ids):
        batch_ids = ids[i : i + args.batch_size]
        payload = json.dumps([compact(by_id[x]) for x in batch_ids], ensure_ascii=False)
        user = USER_TMPL.format(n=len(batch_ids), payload=payload)
        try:
            raw = chat(
                api_key,
                [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
            )
            data = json.loads(raw)
            items = data.get("labels") or data.get("samples") or []
            got = 0
            for item in items:
                rid = item.get("id")
                if rid not in by_id:
                    continue
                lab = int(item["label"])
                if lab not in (0, 1):
                    continue
                soft = float(item.get("soft_label", 0.9 if lab == 1 else 0.1))
                soft = max(0.0, min(1.0, soft))
                by_id[rid]["label"] = lab
                by_id[rid]["soft_label"] = soft
                note = str(item.get("notes") or "")
                old = by_id[rid].get("notes") or ""
                by_id[rid]["notes"] = f"deepseek_relabel; {note}".strip("; ")
                if old and "heuristic" in old:
                    by_id[rid]["notes"] += f" | was:{old}"
                got += 1
            if got == 0:
                raise ValueError("no labels applied")
            labeled += got
            print(f"batch @{i}: +{got} total_relabeled≈{labeled}/{len(ids)}")
            failures = 0
            i += len(batch_ids)
            time.sleep(0.35)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, ValueError, KeyError) as e:
            failures += 1
            print(f"batch @{i} failed ({type(e).__name__}): retry {failures}", file=sys.stderr)
            if failures >= 8:
                print("too many failures, writing partial", file=sys.stderr)
                break
            time.sleep(min(2 ** failures, 30))

    # preserve original order
    out_rows = [by_id[x] for x in ids]
    out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in out_rows) + "\n", encoding="utf-8")
    pos = sum(1 for r in out_rows if r["label"] == 1)
    ds = sum(1 for r in out_rows if "deepseek_relabel" in str(r.get("notes", "")))
    print(f"DONE out={out} n={len(out_rows)} pos={pos} neg={len(out_rows)-pos} deepseek_notes={ds}")


if __name__ == "__main__":
    main()
