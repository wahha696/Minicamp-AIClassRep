# -*- coding: utf-8 -*-
r"""从训练日志的进度行算稳健 ETA（近期实测速度，而非全程平均）。"""
import datetime
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

path = sys.argv[1] if len(sys.argv) > 1 else "train/artifacts/real-distill-train.log"
total = int(sys.argv[2]) if len(sys.argv) > 2 else 109

raw = open(path, "rb").read()
text = ""
for enc in ("utf-8", "utf-16", "gbk", "latin-1"):
    try:
        text = raw.decode(enc)
        break
    except (UnicodeDecodeError, UnicodeError):
        continue

pat = re.compile(r"\|\s*(\d+)/" + str(total) + r" \[([\d:]+)<([\d:]+),\s*([\d.]+)s/it\]")
rows = [(int(m.group(1)), m.group(2), m.group(3), float(m.group(4)))
        for m in (pat.search(l) for l in text.splitlines()) if m]
if not rows:
    print("没有进度行")
    sys.exit(0)


def secs(s: str) -> int:
    # tqdm 的耗时字段会从 MM:SS 变成 H:MM:SS，必须按段数判断，
    # 否则把 "55:10" 当成 55 小时，跨格式相减会得到负速度（实测 -7921s/步）。
    p = [int(x) for x in s.split(":")]
    if len(p) == 2:
        return p[0] * 60 + p[1]
    return p[0] * 3600 + p[1] * 60 + p[2]


# PowerShell 会把同一进度行重复写进日志（\r 刷新的副作用），必须按 step 去重，
# 否则"近期 15 步"会混进更早的时间戳，算出负速度（实测 -7921s/步）。
by_step: dict[int, tuple[int, str, str, float]] = {}
for r in rows:
    prev = by_step.get(r[0])
    if prev is None or secs(r[1]) >= secs(prev[1]):
        by_step[r[0]] = r
rows = [by_step[k] for k in sorted(by_step)]


last = rows[-1]
print(f"当前 step {last[0]}/{total} | 已用 {last[1]} | 剩余(库估算) {last[2]} | 全程均速 {last[3]}s/步")
recent = [r for r in rows if r[0] >= last[0] - 15]
if len(recent) >= 3 and recent[-1][0] > recent[0][0]:
    speed = (secs(recent[-1][1]) - secs(recent[0][1])) / (recent[-1][0] - recent[0][0])
    eta = (total - last[0]) * speed
    done = datetime.datetime.now() + datetime.timedelta(seconds=eta)
    print(f"近 {recent[-1][0] - recent[0][0]} 步实测 {speed:.1f}s/步 -> 还需 {eta/3600:.2f}h，约 {done.strftime('%H:%M')} 完成")
