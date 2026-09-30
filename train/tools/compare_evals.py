# -*- coding: utf-8 -*-
r"""把所有 eval 跑批日志汇总成一张 markdown 对比表（教师基线 vs 各学生版本）。

日志由 PowerShell `*>` 写出，可能是 UTF-16LE；统一做编码探测。
用法：python train\tools\compare_evals.py [artifacts 目录]
"""
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ART = sys.argv[1] if len(sys.argv) > 1 else r"train\artifacts"

DATE_PAT = re.compile(r"start_at=|deadline_at=|应为 20\d\d")
CATS = [
    ("时间", DATE_PAT),
    ("漏提", re.compile(r"^缺少")),
    ("多提", re.compile(r"^多余事件")),
    ("类型", re.compile(r"type=")),
    ("地点", re.compile(r"location=")),
    ("合并", re.compile(r"version=|应合并")),
    ("字段", re.compile(r"action_required")),
    ("状态", re.compile(r"status=")),
]


def read_any(path: str) -> str:
    raw = open(path, "rb").read()
    for enc in ("utf-16", "utf-8", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return raw.decode("latin-1")


def analyze(path: str) -> dict | None:
    text = read_any(path)
    m = re.search(r"当前时间 ([^\n]+?)\s+LLM (\d+) 次 ([\d.]+)s\s+llm=(\w+)", text)
    if not m:
        return None
    scen = {}
    cur = None
    for ln in text.splitlines():
        sm = re.match(r"^([✅❌])\s+(\S+)\s*$", ln.strip())
        if sm:
            cur = sm.group(2)
            scen.setdefault(cur, {"pass": sm.group(1) == "✅", "fails": []})
            continue
        if cur and ln.startswith("     "):
            s = ln.strip()
            if s and not s.startswith("·") and not s.startswith("="):
                scen[cur]["fails"].append(s)
    cats = {name: 0 for name, _ in CATS}
    for v in scen.values():
        for f in v["fails"]:
            for name, pat in CATS:
                if pat.search(f):
                    cats[name] += 1
                    break
    return {
        "now": m.group(1).strip(),
        "calls": int(m.group(2)),
        "secs": float(m.group(3)),
        "llm": m.group(4),
        "passed": sum(1 for v in scen.values() if v["pass"]),
        "total": len(scen),
        "fails": sum(len(v["fails"]) for v in scen.values()),
        "cats": cats,
    }


def label(fn: str) -> str:
    base = os.path.basename(fn)
    if "teacher" in base:
        return "教师基线（deepseek-chat）"
    if "v1" in base:
        return "v1（358 对，掩码修复）" if "final" in base else f"v1（{base}）"
    if "v2" in base:
        return "v2（662 对）"
    if "v3" in base:
        return "v3（2715 对，形态错配）"
    if "v4" in base:
        return "v4（1735 对，形态对齐）"
    if "student" in base:
        return "v0/v1 早期（掩码未修）"
    return base


rows = []
for fn in sorted(os.listdir(ART)):
    if not (fn.startswith("eval-") and fn.endswith(".log")):
        continue
    r = analyze(os.path.join(ART, fn))
    if r:
        rows.append((label(fn), r))

if not rows:
    print("没有可解析的 eval 日志")
    sys.exit(0)

print("| 运行 | 时间点 | LLM 调用 | 耗时 | 状态 | 剧本通过 | 失败项 | " + " | ".join(n for n, _ in CATS) + " |")
print("|---|---|---|---|---|---|---|---|" + "---|" * len(CATS))
for name, r in rows:
    cats = " | ".join(str(r["cats"][n]) for n, _ in CATS)
    print(
        f"| {name} | {r['now']} | {r['calls']} | {r['secs']:.0f}s | {r['llm']} | "
        f"**{r['passed']}/{r['total']}** | {r['fails']} | {cats} |"
    )
