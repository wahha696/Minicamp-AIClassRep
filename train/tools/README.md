# train/tools —— 数据与验收的量化工具

> 这些脚本把"训练数据到底像不像真实分布""验收门到底卡在哪"变成可复现的数字。
> 本目录里的每条结论都对应 `train/BATCH-SHAPE.md` / `train/COST.md` /
> `train/jev/INTEGRATION.md` 里的实测记录。
>
> 运行前提：`$env:PYTHONPATH="$PWD\train\pylibs-gpu"`（需要 numpy / onnxruntime /
> transformers / scikit-learn）；其余只读本地文件，不调 API、不花钱。

| 脚本 | 量什么 | 怎么用 | 结论示例 |
|---|---|---|---|
| `batch_shape.py` | 一份 SFT jsonl 里**每条 prompt 的候选消息数**分布 | `python train\tools\batch_shape.py` | 旧数据 73% 样本候选数 >15（生产只发 5~13）→ 定位训练/服务分布错配 |
| `realism_gap.py` | 剧本目录的**噪声比例 / 字/消息 / 含时间消息占比 / 消息数** | `python train\tools\realism_gap.py` | 生成剧本噪声 20% vs 真实 78%、字/消息 18 vs 5.9 |
| `candidate_pool.py` | **同口径**（都按 BATCH=30 攒批 + isNoise 过滤）的候选行字长与时间密度 | `python train\tools\candidate_pool.py` | 真实候选 11 字/25.6% 含时间；新生成器 9 字/19.5% ✓；旧数据 17 字/31.6% |
| `head_to_head.py` | 两种快判实现在**同一批候选、同一份标签**上的阈值曲线 | 先 `jev-calibrate --dump <abs path>`，再 `python train\tools\head_to_head.py` | rbt3-ONNX 召回 68~80% vs fastjudge 88~92% → 不替换、不级联 |

## 口径三条铁律（踩过的坑）

1. **两边必须同样过滤后再比**：拿"已按线上 isNoise 过滤的训练候选"去比"未过滤的真实消息"，
   会得出夸张的差距（我们自己一度得到"含时间 6% vs 28%"，同口径重测是 25.6% vs 28%）。
2. **看候选，不只看全部消息**：噪声比例对了不等于候选对了——噪声注入能把候选数压到 6，
   但存活候选仍可能是长句通知体。
3. **合成集上的指标不算验收**：Jev 的 rbt3-ONNX 在自造合成集 AUC 1.0，
   在真实分布上全面落后于 4.9MB 的 TF-IDF 模型（见 `ALIGNMENT-fastjudge.md`）。

## 还没搬进来的（在 train/.cache，属临时脚本）

`cost_report.py`（从跑批日志汇总 token 与费用）、`probe_metrics.py`（探针剧本指标）、
`cascade_check.py`（级联可行性）。需要时按同样方式运行即可；若要长期复用再搬进本目录。
