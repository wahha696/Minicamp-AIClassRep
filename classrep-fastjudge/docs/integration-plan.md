# 本地快判接入计划（Minicamp-AIClassRep ↔ classrep-fastjudge）

> 本地改 clone：`/workspace/Minicamp-AIClassRep`（**不要** push，除非用户明确要求）。  
> 推理实现：`classrep-fastjudge`（jieba + TFIDF + CalibratedLR，可选规则并联）。

## 1. 目标

在规则过滤之后、LLM 抽取之前，用可切换后端替代/对照远端 Jev：

| 模式 `FASTJUDGE_MODE` | 行为 |
|----------------------|------|
| `jev`（默认） | 只调远端 TypeSafe Jev；与现网一致 |
| `local` | 只调本机 `infer.py`；缺模型 → 返回 `null` → 候选全交 LLM |
| `dual` | **两边都打分**；调度路由用 `FASTJUDGE_ROUTE`（`jev`\|`local`）；现网决策路由=`local`；双边分数写入内存环 `dualScoreLog` |

阈值不变：`JEV_DROP_BELOW=0.2` / `JEV_URGENT_AT=0.8`。

## 2. 代码改动（server）

| 文件 | 作用 |
|------|------|
| `apps/server/src/pipeline/jev.ts` | 模式分发；导出 `scoreWithRemoteJev`、`dualScoreLog` |
| `apps/server/src/pipeline/jev-local.ts` | 子进程调用 `FASTJUDGE_ROOT/src/infer.py` |
| `apps/server/src/env.ts` | `FASTJUDGE_*` / `LOCAL_JEV_MODEL_PATH` |
| `apps/server/src/pipeline/index.ts` | `/health` 态对 local/dual 感知「是否配置」 |
| `.env.example` | 文档化新变量 |

调度 `scheduler.ts` **无需改**：仍调用 `scoreWithJev` / `jevAvailable`。

## 3. 环境变量

```bash
ENABLE_JEV=true                 # 总开关；false 时任何模式都返回 null
FASTJUDGE_MODE=jev|local|dual   # 现网决策：dual
FASTJUDGE_ROUTE=jev|local       # 仅 dual；现网决策：local
LOCAL_JEV_MODEL_PATH=           # 空 → $FASTJUDGE_ROOT/models/local-jev-v1.joblib
FASTJUDGE_ROOT=/workspace/classrep-fastjudge
FASTJUDGE_PYTHON=               # 空 → 优先 $FASTJUDGE_ROOT/.venv/bin/python
TYPESAFE_API_KEY=               # jev/dual 远端需要
JEV_TIMEOUT_MS=3000
```

### 启用示例

```bash
# 仅本地
export FASTJUDGE_MODE=local
export LOCAL_JEV_MODEL_PATH=/workspace/classrep-fastjudge/models/local-jev-v1.joblib

# 双边对照（2026-09-29 决策：路由走 local；Jev 旁路记分歧）
export FASTJUDGE_MODE=dual
export FASTJUDGE_ROUTE=local
export LOCAL_JEV_MODEL_PATH=/workspace/classrep-fastjudge/models/local-jev-v1.joblib
# 切回远端路由：FASTJUDGE_ROUTE=jev；紧急回退：FASTJUDGE_MODE=jev
```

缺模型或 infer 失败：**安全回退**（`null`），与远端失败一致，不丢可用性。

## 4. 输入/输出对齐

与 `docs/jev-contract.md` 一致：

```ts
scoreWithJev(candidates, context, groupName) → number[] | null
```

本地 CLI（`src/infer.py`）stdin：

```json
{"group_name":"...","context":[{"sender_name","text"}],"candidates":[{"sender_name","text"}]}
```

stdout：`{"scores":[...]}` 或 `{"scores":null,"error":"..."}`。

## 5. 对比脚本

```bash
cd /workspace/classrep-fastjudge
# 可选加载密钥（勿打印）
eval "$(python3 /workspace/export_box_secrets.py)"

python3 scripts/compare_jev_local.py \
  --holdout data/holdout/v2.jsonl \
  --model models/local-jev-v1.joblib \
  --out reports/compare-jev-local.json
```

报告字段：`recall_pos@0.2`、`miss_kill_rate@0.2`（误杀）、`neg_drop_rate@0.2`、`precision_urgent@0.8`、延迟、`disagreement_samples`。  
无 `TYPESAFE_API_KEY` 时：`jev.status = "NOT_RUN"`，local 侧仍写出完整指标。

## 6. Holdout 约定

- 路径：`data/holdout/v2.jsonl`
- Schema：`schemas/holdout-v2.schema.json`（与训练样本同核：id / group_name / context / message / label / source）
- 训练员填真实 holdout；仓库内可先放 synth 通路样本

## 7. 验收清单

- [ ] `FASTJUDGE_MODE=local` 时烟测打分成功
- [ ] 缺模型时返回 null、流水线不崩
- [ ] `dual` 写入 `dualScoreLog`，路由遵循 `FASTJUDGE_ROUTE`
- [ ] `pnpm --filter server typecheck` / 相关单测通过
- [ ] `compare_jev_local.py` 产出 `reports/compare-jev-local.json`


## 8. 现网 dual 决策（2026-09-29）

- holdout n=422：local 召回/neg_drop/urgent/延迟均不弱于远端 Jev（urgent 两边均为 1.0）。
- **启用**：`FASTJUDGE_MODE=dual` + `FASTJUDGE_ROUTE=local`，模型用晋升版 `models/local-jev-v1.joblib`（与 `models/best/` 同步）。
- **回退**：`FASTJUDGE_ROUTE=jev` 或 `FASTJUDGE_MODE=jev`。
- clone 已改、**未 push**；本机/部署把上述变量写入 `.env`（可参考仓库根 `.env.example`）。
- 训练员继续只晋升更好的 joblib；换模型后重启 server 或按现有热加载约定。
