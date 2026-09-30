# 本地快判标签空间 v1

对齐：`Minicamp-AIClassRep/docs/本地快判/基座与标签-v1.md`、`docs/scaffold-conventions-v1.md`。  
JSON Schema：`schemas/sample.schema.json`。

## 硬标签 `label`

| 值 | 名称 | 口径 |
|----|------|------|
| **1** | `schedule_signal` | 考试/作业/会议/活动/通知的时间地点要求，或其改期取消补充确认；**已说定时间/日期**的聚餐出游等；可与上下文拼成上述信息的短片段 |
| **0** | `noise_or_chatter` | 闲聊寒暄表情；**未说定时间**的随口提议/询问 |

与现网 Jev `noul` criteria（`apps/server/src/pipeline/jev.ts`）一致。粗类型（作业/考试/…）**不是** v1 训练标签，仅可出现在 `scenario`/`notes`。

## 软标签 `soft_label` ∈ [0,1]（可选）

教师模型（DeepSeek）同口径概率；用于校准/蒸馏。评测主看硬标签召回（误杀代价更高）。

## 样本字段

见 schema；`context` 最多 10 条（对齐 `CONTEXT=10`）。`source`：`synth|mock|human`。

## 路由映射（推理时）

`predict_proba[:,1]` → `score`，沿用 `JEV_DROP_BELOW=0.2`、`JEV_URGENT_AT=0.8`。
