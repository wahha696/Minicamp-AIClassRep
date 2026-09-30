#!/usr/bin/env python3
"""Convert Minicamp-AIClassRep/data/mock/*.json → data/raw/mock.jsonl (schema v1).

Labels: heuristic aligned with jev criteria + filter KEEP_WORD (notes=heuristic_v1).
Rule-layer pure noise (isNoise-like) → label 0; schedule keywords / keep words → 1;
ambiguous short chatter without time → 0. Soft_label mirrors hard label (0.1 / 0.9).
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MOCK = Path("/workspace/Minicamp-AIClassRep/data/mock")
OUT = ROOT / "data" / "raw" / "mock.jsonl"

PLACEHOLDER = re.compile(r"\[(?:图片|表情|at|卡片|转发|文件|语音|视频|消息)\]")
EMOJI_PUNCT = re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\u200D\uFE0F\W]", re.UNICODE)
DIGIT = re.compile(r"[0-9０-９]")
TIME_WORD = re.compile(
    r"[今明后昨][天晚早]|[周星期礼拜][一二三四五六日天末]|星期|本周|下周|这周|"
    r"早上|上午|中午|下午|傍晚|晚上|凌晨|截止|ddl|点|号|月|日",
    re.I,
)
ACK = re.compile(
    r"^(?:(?:收到|好的|好滴|ok|嗯+|哈+|6+|\+1|谢谢|知道了|1+|啊+|草|？+|\?+)[!！。~～,，、.]*)+$",
    re.I,
)
KEEP_WORD = re.compile(
    r"取消|改期|改到|改在|改为|改成|改回|改线上|改线下|改网课|改时间|改地点|"
    r"换(?:了|成|到|教室|课|地点|时间|老师)|挪到|推迟|延期|延后|提前|暂停|停课|"
    r"补课|调课|复课|恢复|不上|不考|不交|不收|不用交|不用上|不开|不办|照常|作废|"
    r"撤回|补交|补考|缓考|重修|记得|别忘",
    re.I,
)
SCHEDULE = re.compile(
    r"考试|小测|期中|期末|作业|实验报告|预习|交到|提交|截止|ddl|班会|开会|"
    r"学代会|集合|教室|报告厅|学习通|问卷|通知|补交|缓考|重修|计分|随堂|"
    r"周[一二三四五六日天].*(?:节|点)|明天|后天|下周|本周|周日|周五|周一|"
    r"\d{1,2}\s*[:：点]\s*\d{0,2}|23:59|逾期",
    re.I,
)


def is_noise_like(text: str) -> bool:
    t = PLACEHOLDER.sub("", text)
    t = re.sub(r"\s+", "", t)
    core = EMOJI_PUNCT.sub("", t)
    if not core:
        return True
    if KEEP_WORD.search(t):
        return False
    if ACK.match(t):
        return True
    return len(core) < 4 and not DIGIT.search(core) and not TIME_WORD.search(core)


def heuristic_label(text: str) -> int:
    if is_noise_like(text):
        return 0
    if KEEP_WORD.search(text) or SCHEDULE.search(text):
        return 1
    # 未说定时间的闲聊/提议
    return 0


def convert_file(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    stem = path.stem
    group_name = data["group"]["name"]
    msgs = data["messages"]
    rows: list[dict] = []
    for i, m in enumerate(msgs):
        # context: previous non-noise-like up to 10
        ctx: list[dict] = []
        for prev in msgs[:i]:
            if is_noise_like(prev["text"]):
                continue
            ctx.append({"sender_name": prev["sender"], "text": prev["text"]})
        ctx = ctx[-10:]
        label = heuristic_label(m["text"])
        soft = 0.9 if label == 1 else 0.1
        rows.append(
            {
                "id": f"mock:{stem}:{i}",
                "group_name": group_name,
                "context": ctx,
                "message": {"sender_name": m["sender"], "text": m["text"]},
                "label": label,
                "soft_label": soft,
                "source": "mock",
                "scenario": stem,
                "notes": "heuristic_v1",
            }
        )
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock-dir", type=Path, default=DEFAULT_MOCK)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    all_rows: list[dict] = []
    for p in sorted(args.mock_dir.glob("*.json")):
        rows = convert_file(p)
        all_rows.extend(rows)
        print(f"{p.name}: {len(rows)} samples")
    with args.out.open("w", encoding="utf-8") as f:
        for r in all_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    pos = sum(1 for r in all_rows if r["label"] == 1)
    print(f"wrote {len(all_rows)} → {args.out} (pos={pos}, neg={len(all_rows)-pos})")


if __name__ == "__main__":
    main()
