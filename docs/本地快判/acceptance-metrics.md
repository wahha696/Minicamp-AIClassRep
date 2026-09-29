# 本地快判验收指标草案 v1

对齐 `jev-calibrate.ts` 与基座文档：误丢通知 ≫ 多调 LLM。

| 指标 | 定义 | v1 目标（草案） |
|------|------|----------------|
| 准确率 Accuracy | `(TP+TN)/N` @ 阈值 0.5 或 argmax | 报告即可 |
| 正例召回 @0.2 | `P(score≥0.2 \| label=1)` | **争取 ≥99%**，不低于 mock 剧本抽检 |
| 误杀率 | `P(score<0.2 \| label=1)` = 1 − 召回@0.2 | **尽量 → 0** |
| 负例丢弃率 | `P(score<0.2 \| label=0)` | 越高越好（省 LLM） |
| 误报率 @0.2 | `P(score≥0.2 \| label=0)` | 报告；可高于误杀 |
| 紧急精确率 @0.8 | `P(label=1 \| score≥0.8)` | 报告 |
| 延迟 | 单条 / 批 30 条 CPU p50/p90 | **毫秒～百毫秒**；远低于现网 3s 超时 |
| 包体 | `local-jev-v1.joblib` 体积 | 目标 **&lt; 50MB**（TF-IDF+LR 通常更小） |

输出：`reports/metrics-v1.json`、`reports/split-stats.json`。
