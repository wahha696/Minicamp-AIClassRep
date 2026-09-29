# ClassRep 本地快判 · 脚手架约定 v1

决策方：产品经理  
日期：2026-09-28  
对齐：`docs/本地快判/基座与标签-v1.md`

## 工作根目录

`/workspace/classrep-fastjudge/`（训练产物与合成数据在此；仓库 clone 在 `/workspace/Minicamp-AIClassRep/`）

契约文档可复制或软链到仓库：`Minicamp-AIClassRep/docs/本地快判/`。

## 样本 JSONL 路径

| 用途 | 路径 |
|------|------|
| 合成原始 | `data/raw/synth.jsonl` |
| mock 转换 | `data/raw/mock.jsonl` |
| 人工/抽检 | `data/raw/human.jsonl`（可空） |
| 合并池 | `data/raw/all.jsonl` |
| 训练 | `data/splits/train.jsonl` |
| 验证 | `data/splits/val.jsonl` |
| 测试 | `data/splits/test.jsonl` |
| 模型 | `models/local-jev-v1.joblib` |
| 指标 | `reports/metrics-v1.json` |

单行一条 JSON，schema 以基座文档为准。

## 拆分方式

1. **主分割轴：`group_name`**（同一群不跨 train/val/test，防泄漏）
2. 目标比例约 **train 70% / val 15% / test 15%**（按群计数，允许因群大小略偏）
3. **`data/mock` 剧本**：必须复用；`scenario` 填原剧本文件 stem（如 `assignment`、`reschedule`）；mock 样本优先进入 **val+test**（至少一半进 test），少量可进 train 作锚点
4. 合成样本按 `group_name` 哈希分桶；固定 `seed=20260928`
5. 正负比：合成目标约 1:2～1:3（正:负）；拆分后各 split 正例占比记录进 `reports/split-stats.json`

## 是否挂 data/mock

**挂。** 用脚本把 `Minicamp-AIClassRep/data/mock/*.json` 转成上述 schema 写入 `data/raw/mock.jsonl`，保留原剧本 id 于 `scenario` 与 `id` 前缀 `mock:<stem>:<idx>`。

## 合成规模（给训练侧）

- 合成目标 **5000** 条（可先 500 通路，再扩到 5k）
- 评测集合计 **400** 条左右（含 mock 转换 + 合成 holdout）
- `soft_label`：合成阶段尽量由 DeepSeek 同口径给出

## 推理签名目标

对齐现网：`scoreWithJev(candidates, context, groupName) -> number[]`；本地实现可先 Python CLI，Node 侧后续接子进程。
