#!/usr/bin/env python3
"""Synthesize QQ-group fast-judge samples via DeepSeek (OpenAI-compatible).

Usage:
  eval "$(python3 /workspace/export_box_secrets.py)"
  python3 scripts/synthesize.py --target 400

Never prints API keys. Writes data/raw/synth.jsonl (append-safe with --append).
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
OUT = ROOT / "data" / "raw" / "synth.jsonl"
BASE = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

SYSTEM = """你是大学 QQ 群消息数据合成器，为「日程信号快判」造样本。
硬标签 label: 1=schedule_signal（影响学生日程/待办的具体信息），0=noise_or_chatter。
口径与 TypeSafe Jev 一致：
- 正例：考试/作业/会议/活动/通知的时间地点要求，或其改期取消补充确认；已说定具体时间或日期的聚餐吃饭出游打球；可与上下文拼成这些信息的短片段（如「取消了」「改线上」）。
- 反例：纯闲聊寒暄表情；没有说定时间的随口提议（如「晚上约饭吗」）。
soft_label: 0~1 的概率，与 label 一致方向（正例通常≥0.7，反例通常≤0.3，边界可 0.4~0.6）。
只输出 JSON，不要 markdown。"""

USER_TMPL = """请生成恰好 {n} 条中文 QQ 群样本。覆盖主题：{themes}。
正负比大约 1:{neg_ratio}（正:负，正例略少）。每条含不同 group_name（虚构班级群名）。
context 为该消息前 0~5 条相关聊天（可空数组），message 为待判定消息。

严格输出一个 JSON 对象：
{{"samples":[
  {{
    "group_name":"...",
    "context":[{{"sender_name":"...","text":"..."}}],
    "message":{{"sender_name":"...","text":"..."}},
    "label":0或1,
    "soft_label":0.0到1.0,
    "scenario":"homework|exam|meeting|activity|ddl|reschedule|cancel|noise|ask_hangout|short_change",
    "notes":"短说明"
  }}
]}}
不要输出其它字段或解释。"""

THEMES_ROTATION = [
    "作业DDL、学习通提交、逾期不收",
    "考试/小测时间地点与范围",
    "班会开会学代会",
    "已说定时间的聚餐出游打球集合",
    "改期改教室改线上、取消停课",
    "短变更保活词：取消了/不交了/改线上/推迟",
    "纯闲聊表情刷屏收到好的",
    "未说定时间的约饭开黑询问",
]


def chat(api_key: str, messages: list[dict], temperature: float = 0.9) -> str:
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


def normalize(sample: dict, idx: int, batch_id: int) -> dict | None:
    try:
        msg = sample["message"]
        text = str(msg["text"]).strip()
        if not text:
            return None
        label = int(sample["label"])
        if label not in (0, 1):
            return None
        soft = float(sample.get("soft_label", 0.9 if label == 1 else 0.1))
        soft = max(0.0, min(1.0, soft))
        ctx = sample.get("context") or []
        context = []
        for c in ctx[:10]:
            context.append(
                {
                    "sender_name": str(c.get("sender_name", "")),
                    "text": str(c.get("text", "")),
                }
            )
        return {
            "id": f"synth:b{batch_id}:{idx}",
            "group_name": str(sample.get("group_name") or f"合成群-{batch_id}"),
            "context": context,
            "message": {
                "sender_name": str(msg.get("sender_name", "同学")),
                "text": text,
            },
            "label": label,
            "soft_label": soft,
            "source": "synth",
            "scenario": str(sample.get("scenario") or "mixed"),
            "notes": str(sample.get("notes") or ""),
        }
    except (KeyError, TypeError, ValueError):
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=400, help="desired new samples")
    ap.add_argument("--batch-size", type=int, default=20)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--append", action="store_true")
    ap.add_argument("--neg-ratio", type=float, default=2.5)
    ap.add_argument("--start-batch", type=int, default=0, help="initial batch_id offset for unique ids when appending")
    args = ap.parse_args()

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        print("ERROR: DEEPSEEK_API_KEY not set. Run: eval \"$(python3 /workspace/export_box_secrets.py)\"", file=sys.stderr)
        sys.exit(2)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if not args.append and args.out.exists():
        args.out.unlink()

    written = 0
    batch_id = args.start_batch
    failures = 0
    while written < args.target:
        batch_id += 1
        n = min(args.batch_size, args.target - written)
        themes = THEMES_ROTATION[(batch_id - 1) % len(THEMES_ROTATION)]
        user = USER_TMPL.format(n=n, themes=themes, neg_ratio=args.neg_ratio)
        try:
            raw = chat(
                api_key,
                [
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": user},
                ],
            )
            payload = json.loads(raw)
            samples = payload.get("samples") or payload.get("data") or []
            if not isinstance(samples, list):
                raise ValueError("no samples list")
            rows = []
            for i, s in enumerate(samples):
                row = normalize(s, i, batch_id)
                if row:
                    rows.append(row)
            if not rows:
                raise ValueError("empty after normalize")
            with args.out.open("a", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            written += len(rows)
            pos = sum(1 for r in rows if r["label"] == 1)
            print(f"batch {batch_id}: +{len(rows)} (pos={pos}) total={written}/{args.target} theme={themes[:20]}")
            failures = 0
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, ValueError, KeyError) as e:
            failures += 1
            print(f"batch {batch_id} failed ({type(e).__name__}): retry {failures}", file=sys.stderr)
            if failures >= 8:
                print("too many failures, stopping", file=sys.stderr)
                break
            time.sleep(min(2 ** failures, 30))
            continue
        time.sleep(0.4)

    # stats
    if args.out.exists():
        lines = args.out.read_text(encoding="utf-8").strip().splitlines()
        pos = sum(1 for ln in lines if json.loads(ln)["label"] == 1)
        print(f"DONE file={args.out} n={len(lines)} pos={pos} neg={len(lines)-pos}")


if __name__ == "__main__":
    main()
