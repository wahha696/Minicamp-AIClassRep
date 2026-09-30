# -*- coding: utf-8 -*-
r"""解析 eval.ts 输出，汇总每个剧本的失败项并按类型归因。

⚠️ PowerShell `*>` 重定向写出的是 UTF-16LE，必须先按编码探测再解析。

用法：
  python train\tools\parse_eval.py train\artifacts\eval-v1-final.log
"""
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def read_any(path: str) -> str:
    raw = open(path, "rb").read()
    for enc in ("utf-16", "utf-8", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return raw.decode("latin-1")


path = sys.argv[1] if len(sys.argv) > 1 else r"train\artifacts\eval-v1-final.log"
text = read_any(path)

scen = None
stats: dict[str, dict] = {}
for ln in text.splitlines():
    m = re.match(r"^([✅❌])\s+(\S+)\s*$", ln.strip())
    if m:
        mark, name = m.group(1), m.group(2)
        scen = name
        stats.setdefault(name, {"pass": mark == "✅", "fails": [], "events": 0})
        continue
    if scen and ln.startswith("     "):
        s = ln.strip()
        if s.startswith("·"):
            stats[scen]["events"] += 1
        elif s and not s.startswith("="):
            stats[scen]["fails"].append(s)

total = len(stats)
passed = sum(1 for v in stats.values() if v["pass"])
print(f"剧本通过 {passed}/{total}")
for name, v in stats.items():
    print(f"{'✅' if v['pass'] else '❌'} {name}: 提取事件 {v['events']}，失败项 {len(v['fails'])}")

KINDS = [
    ("时间/日期", r"start_at=|deadline_at=|应为 20\d\d"),
    ("缺失事件", r"^缺少"),
    ("多余事件", r"^多余事件"),
    ("类型错误", r"type="),
    ("地点错误", r"location="),
    ("更新未合并", r"version=|应合并"),
    ("字段缺失", r"action_required"),
    ("状态错误", r"status="),
]
agg = {k: 0 for k, _ in KINDS}
date_only = 0
for v in stats.values():
    for f in v["fails"]:
        for k, pat in KINDS:
            if re.search(pat, f):
                agg[k] += 1
                if k == "时间/日期":
                    date_only += 1
                break
print("\n失败类型分布：", {k: c for k, c in agg.items() if c})
tot_fails = sum(len(v["fails"]) for v in stats.values())
if tot_fails:
    print(f"合计失败项 {tot_fails}；其中时间/日期类 {date_only}（{date_only/tot_fails*100:.0f}%）"
          f" —— 这部分原则上可由代码侧日期归一化承担")

# 关键决策数字：把"时间/日期"类失败全部当作已解决后，有多少剧本会转绿？
DATE_PAT = re.compile(r"start_at=|deadline_at=|应为 20\d\d")
date_only_scen, mixed_scen, other_scen = [], [], []
for name, v in stats.items():
    if v["pass"]:
        continue
    d = sum(1 for f in v["fails"] if DATE_PAT.search(f))
    o = len(v["fails"]) - d
    if d and not o:
        date_only_scen.append(name)
    elif d and o:
        mixed_scen.append(f"{name}(日期 {d} / 其他 {o})")
    else:
        other_scen.append(name)
print(f"\n若日期问题由代码解决：纯日期阻塞的剧本 {len(date_only_scen)} 个 {date_only_scen} 可转绿；")
print(f"  日期+其它混合 {len(mixed_scen)} 个 {mixed_scen}（仍需改善其它能力）；")
print(f"  与日期无关 {len(other_scen)} 个 {other_scen}")
