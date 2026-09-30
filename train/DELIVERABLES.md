# Class Rep 内置模型交付说明（train/DELIVERABLES.md）

> 按《本地训练小模型操作手册》在本机（RTX 5070 Laptop 8GB / Windows / 原生）完成的两个模型交付。
> 全部数字为本机实测，非估算。

## 执行摘要（先看这一节）

**交付了什么**：两套可本地运行的模型 + 一条可复现的数据/训练/验收流水线，以及两份写给队友的接入文档。
TypeSafe Key 依赖在运行时已由本地快判替代（产品决策 `FASTJUDGE_MODE=local`）。

**能用的**：
- **快判位**：队友的 `classrep-fastjudge`（jieba+TF-IDF+CalibratedLR，4.9MB，2ms/条）——
  **本工作区的 rbt3-ONNX 在同口径实测中落后于它**（召回 68~80% vs 88~92%），
  因此**不建议替换、也不建议做级联**（级联救回 0 条、反丢 5 条）。详见 `ALIGNMENT-fastjudge.md`。
- **验收门**：`eval.ts`（教师基线 6/6）与 `jev-calibrate`（已能在无 TypeSafe key 的本地模式下运行，
  支持 `--dump` 存档做同口径横向对比）。
- **流水线**：教师数据制备（prompt 与 `extract.ts` 逐字节同源 + `PROMPT_VERSION` 闸门）、
  QLoRA 训练（bnb 4bit，8GB 显存配方）、bnb→bf16 反量化、GGUF 导出、本地 OpenAI 兼容服务器、一键验收脚本。
- **事件提取模型**：schema 正确、JSON 首轮合法率 15/15（掩码修复 + 服务端 JSON 约束后）——
  但**未通过 eval 的六剧本全绿门**（见下）。

**不能用的（诚实结论）**：
- 事件提取模型的**日期/时间推理**仍不达标：考卷 0/6，失败集中在"下周三"这类相对日期换算
  与流内更新合并。根因不是链路（教师同卷 6/6），而是**训练数据与真实分布有三处系统性偏差**：
  噪声 20% vs 真实 78%、字/消息 18 vs 5.9、含时间消息 27% vs 6%。
  生成器已按实测改好（改后探针四项指标全部对齐），但**尚未用新数据重训**。
- 因此当前交付版提取模型应视为**可用但未达验收**：适合小规模试用，不适合替掉教师。

**下一步（一条命令，成本先报价）**：
```powershell
# 已有剧本、只想重新蒸馏/训练（不重新生成，最省）
powershell -File train\train-real-dataset.ps1 -Yes -Train
# 从零重建形态对齐数据（会重新生成剧本，按输出计费）
powershell -File train\rebuild-realistic-data.ps1 -Scenarios 650            # 只打印计划与花费
powershell -File train\rebuild-realistic-data.ps1 -Scenarios 650 -Yes -Train
```

### 当前进展与两个已就绪的"提分件"

1. **形态对齐数据集已训练完并通过验收（2026-09-30）**：`train/data/sft-real.jsonl`，**1,738 对**
   （557 剧本 → 1,850 批次，94% 接受率），成本 **¥9.5**；109 步 ≈ 3.6h，loss 0.47→0.13。
   实测结论（详见 `BATCH-SHAPE.md`）：
   - **事件提取本身成功了**：v1/v2 是"一条都提不出来"（`缺少 /牛顿环/`），
     这一版**每次都把事件提出来了**（牛顿环/迈克尔逊/习题/茶话会/班委会/选课/小测/两门考试），
     失败性质变成"提出来了，但时间/地点/合并/状态有错"。
   - **日期归一化把时间类失败从 10 消到 1（-90%）**，并让 `meeting` **首次转绿**
     （学生模型第一次有剧本通过）。
   - 但逐剧本全绿仍是 **0/6（裸分）/ 1/6（加日期）**：剩余失败是漏提个别事件、
     地点取旧值、更新未合并（`version=1`）、`cancel` 未生效、类型判错——**都不是时间问题**。
   - ⚠️ 运行间有波动（两次裸分失败项 14 vs 18），"1/6" 样本量还小，应重复 3~5 次再定论。

2. **日期归一化模块已落地生产并通过测试**：`apps/server/src/pipeline/date-normalize.ts`
   - 考卷日期用例 **10/10**（含模型全部答错的「下周三」「本周五 23:59 前」等）
   - 跨周边界用例 **4/4**（周日 23:50 的「本周一」仍算本周）
   - 65k 消息误报审计：弱信号 13% 被拦截，误判"过去"从 7.5% 降到 **2.7%**
   - **16 项单测**（含"从 DB 读来源消息"的集成路径——该测试当场抓到 `event_sources` 无 `group_id` 列的错误）
   - `eval.ts --dates`（默认关闭）用于在**同一批模型输出**上对比"模型裸分"与"模型+代码"
   - **只改时间字段、不碰 prompt** → 不触发 `PROMPT_VERSION` 变更、既有数据不作废

## 交付物一览

| # | 交付物 | 路径 | 体积 | 状态 |
|---|---|---|---|---|
| ① | **Jev 快判分类器**（ONNX INT8） | `train/models/jev-classifier-onnx/` | **38.7MB** | ✅ 已交付 |
| ① | Jev 训练与评测记录 | `train/models/jev-rbt3/`（含 `eval.json`） | — | ✅ AUC/PR-AUC/acc = 1.0 |
| ① | 接入说明（给 M2 队友） | `train/jev/INTEGRATION.md` | — | ✅ 含 onnxruntime-node 接线与阈值流程 |
| ② | **事件提取模型**（GGUF，**交付版**） | `train/models/extract-v1-Q8_0.gguf` | **1.83GB** | ✅ 对应 `qwen3-1.7b-sft-bf16`（358 对，掩码修复版） |
| ② | 事件提取模型（v2 规模化实验，留档） | `train/models/extract-v2-Q8_0.gguf` | 1.83GB | ⚠️ 662 对 2 epoch：考卷同分且输出偏长，不作为交付版 |
| ② | 干净 bf16 权重（可复转 GGUF） | `train/models/qwen3-1.7b-sft-bf16/` | 3.44GB | ✅ |
| ② | LoRA 合并模型（bnb 4bit 原始态） | `train/models/qwen3-1.7b-sft/` | 1.88GB | ✅ |
| — | 教师数据管道（prompt 与 extract.ts 同源） | `train/lib/prompts.ts` + `train/gen-*.ts` | — | ✅ PROMPT_VERSION=1 |
| — | SFT 数据集 | `train/data/sft-v1.jsonl`（358 对）/ `sft-v2.jsonl`（675 对） | — | ✅ 质量门全过 |
| — | 训练/导出/验收脚本 | `train/extract/*.py`、`train/env/serve_hf.py` | — | ✅ |
| — | 本地端点零代码验收链路 | `.env`（LLM_BASE_URL/KEY/MODEL）+ `eval.ts` | — | ✅ 教师基线 6/6 |

## 量化档位说明（与手册目标的差异）

| 档位 | 体积 | 可得性 | 说明 |
|---|---|---|---|
| Q4_K_M（手册目标 ~1.1GB） | ~1.1GB | ❌ 需要 `llama-quantize` 二进制 | GitHub Release 全程不可达（连接重置），本机无 MSVC 构建链；**转换器本身不支持 K 量化** |
| **Q8_0（本次交付）** | **1.83GB** | ✅ 转换器原生 `--outtype q8_0` | 无需额外二进制，精度高于 Q4_K_M |
| f16 | 3.29GB | ✅ | `03_export_gguf.py` 默认路径 |

拿到 `llama-quantize.exe` 后一条命令即可补 Q4_K_M：

```powershell
python train\extract\03_export_gguf.py --model train\models\qwen3-1.7b-sft-bf16 --quant Q4_K_M
# 或手动：llama-quantize.exe extract-f16.gguf extract-Q4_K_M.gguf Q4_K_M
```

## 复现路径（全部命令实测可用）

```powershell
# 0) 环境（一次性）
powershell -File train\env\setup_windows.ps1        # torch cu128 + transformers/peft/bnb + onnx 到 train\pylibs-gpu

# 1) 教师数据（需 DeepSeek Key；prompt 与生产 extract.ts 逐字节同源）
node train\dist\train\gen-scenarios.js --n 600 --concurrency 3
node train\dist\train\gen-sft-data.js --out sft-v2.jsonl

# 2) QLoRA 训练（不装 unsloth 走标准 transformers+peft+bnb 路线）
$env:PYTHONPATH="$PWD\train\pylibs-gpu"
python train\extract\sft_qwen3.py --data train\data\sft-v2.jsonl --drop-over-seq `
       --epochs 3 --seq 3072 --no-unsloth --out train\models\qwen3-1.7b-sft-v2

# 3) bnb 4bit → 干净 bf16（GGUF 前置）
python train\extract\03a_dequantize.py --model train\models\qwen3-1.7b-sft-v2

# 4) GGUF（转换器 + pip gguf 已随仓库，见 README）
$env:NO_LOCAL_GGUF='1'
python train\extract\03_export_gguf.py --model train\models\qwen3-1.7b-sft-v2-bf16 --quant Q8_0

# 5) 本地端点验收（零代码：只改 .env）
python train\env\serve_hf.py --model train\models\qwen3-1.7b-sft-v2-bf16 --port 8080
# .env: LLM_BASE_URL=http://127.0.0.1:8080/v1  LLM_API_KEY=local  LLM_MODEL=extract
pnpm --filter server exec tsx src/pipeline/eval.ts
```

## 服务端契约（M2 集成必读）

生产 `extract.ts` 的每个请求都带：

```
response_format: { type: 'json_object' }
temperature: 0
max_tokens: 4096
```

**服务端必须实现 `response_format=json_object` 的 JSON 约束**（llama-server 的语法模式 /
本仓库 `serve_hf.py` 的等价实现）。若服务端忽略该参数，1.7B 学生模型在复杂批次上会输出
markdown 围栏或裸数组（OOD schema），导致一次合法率下降。启动命令建议：

```powershell
llama-server.exe -m train\models\extract-v1-Q8_0.gguf --port 8080 --ctx-size 8192 --jinja
```

## 验收门槛的确切含义（`apps/server/src/pipeline/eval.ts`）

6 个剧本（`data/mock/`，与训练剧本物理隔离）每个都要求**全项精确命中**，任一项不符即整剧本 ❌：

| 检查项 | 口径 |
|---|---|
| 标题 | 正则命中（如 `/牛顿环/`） |
| 类型 | 必须落在允许集合内（如 exam / assignment / meeting / announcement…） |
| 状态 | `active` / `cancelled` 精确相等 |
| 时间 | `start_at` 或 `deadline_at` 的**日期+时分**同时正确（按上海时区渲染比对） |
| 地点 | 有期望值时必须包含该串（如 `3号楼105`） |
| 要求字段 | `action_required` 必须包含指定词（如 `原始数据`、`PDF`） |
| 合并版本 | 有 `minVersion` 时必须是更新后的版本（如 `version ≥ 2`，"改动"要合进来） |
| 多余事件 | 提取出任何未登记事件 = ❌（考"不误报"） |

教师模型（deepseek-chat）在同一考卷上是 **6/6 全绿**（`train/artifacts/eval-teacher.log`），
说明 prompt 契约与管线正确；学生模型的失败是**能力/规模**问题（见下）。

## 实测记录（本机，可复现）

### 全量 eval 对比（由 `train/tools/compare_evals.py` 自动汇总）

| 运行 | 时间点 | LLM 调用 | 耗时 | 状态 | 剧本通过 | 失败项 | 时间 | 漏提 | 多提 | 类型 | 地点 | 合并 | 字段 | 状态 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v0/v1 早期（掩码未修） | 2026-09-28 21:57 | 20 | 392s | ok | **0/6** | 19 | 9 | 2 | 0 | 3 | 2 | 1 | 2 | 0 |
| **教师基线（deepseek-chat）** | 2026-09-28 19:13 | 15 | **7s** | ok | **6/6** | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| v1（358 对，掩码修复） | 2026-09-29 20:34 | 15 | 232s | ok | **0/6** | 16 | 10 | 1 | 0 | 1 | 1 | 0 | 2 | 1 |
| v1（JSON 约束版） | 2026-09-29 09:40 | 18 | 926s | error | 0/6 | 24 | 9 | 2 | 2 | 2 | 3 | 3 | 2 | 1 |
| v1（仅掩码修复） | 2026-09-29 09:24 | 23 | 208s | ok | 0/6 | 19 | 9 | 2 | 0 | 2 | 2 | 2 | 2 | 0 |
| v2（662 对） | 2026-09-29 22:40 | 15 | 689s | error | 0/6 | 16 | 5 | 6 | 1 | 1 | 0 | 0 | 2 | 1 |

> 表格由 `python train\tools\compare_evals.py` 重跑生成（v3/v4 结果落地后会自动出现在表里）。
> 结论：教师基线 6/6、0 失败项、7 秒；各学生版本均 0/6，失败项 16~24，
> 其中"时间"类始终是最大单一类别（5~10 项）。

| 版本 | 数据 | JSON 合法 | eval 结果 | 结论 |
|---|---|---|---|---|
| v0（首训） | 358 对 | 偶发 ```json 围栏 | 0/6 | 定位到**掩码错位**：Qwen3 空 think 块致 JSON 开头 token 无监督 |
| v1（掩码修复） | 358 对 | 单请求纯 JSON ✅；并发批次仍有围栏 | 0/6 | 服务端补 `response_format=json_object` 约束后围栏消失 |
| **v1（掩码修复 + JSON 约束）** | 358 对 | **15/15 首轮即合法、0 围栏、0 超时** | **0/6** | 事件识别可用，失败集中在**日期解析**与**更新合并**；15 次调用 231.5s、`llm=ok` |
| v2（2 epoch，任务计划托管） | 662 对（569 剧本） | 首轮合法但输出变长（多次触顶 768 cap） | **0/6** | 失败模式与 v1 **完全相同**，且因输出过长导致截断重试（15 次调用 688.8s、`llm=error`） |
| **v3（1 epoch，任务计划托管）** | **2,715 对 / 2,180 剧本**（v1 的 7.6×） | 待实测 | 待实测 | 170 步 ≈ 5h；每 25 步存档、可 `--resume`；数据偏 reschedule/cancel/backfill/multi/exam/assignment/meeting（针对 v1/v2 失败的技能） |

> **关键结论（v1 vs v2）**：358 对与 662 对的失败清单**逐条一致** —— 差距不是"再补一点数据"，
> 而是 **1.7B + LoRA 在学习"日历块 → ISO 日期"多步推理**上的能力上限。
> v3 把数据推到 **2,715 对（7.6×）并偏向失败技能**，用来验证"是能力上限还是数据不足"这个判断；
> 若 v3 仍在同一处失败，则应把日期归一化交回代码（手册"code owns the workflow"）。

**v1 实测失败清单**（`train/artifacts/eval-v1-final.log`，15 次 LLM 调用 231.5s，全部 `llm=ok`）：

| 失败类型 | 实例 | 含义 |
|---|---|---|
| `deadline_at=null`（3 例） | 牛顿环报告、迈克尔逊预习、第二章习题 | 事件识别对了，但**没把"周五之前/下周一"解析成截止时间** |
| 相对日期锚定错 | 高数小测 09-30（应 10-02）、高数期中 09-30（应 10-06）、线代期中 09-30（应 10-08）、年级大会 10-03（应 10-07） | 把"下周X"算成"本周/明天"，**日历块推理没学会** |
| 类型误判 | 高数随堂小测 type=activity（应 exam） | 小样本下 exam/activity 边界不稳 |
| 状态未更新 | 迎新茶话会 status=active（应 cancelled） | 取消语义没接住 |
| 漏提 | /问卷/ 未提取 | 长批次尾部候选召回不足 |
| 地点错 | A301（应含 3号楼105） | 取了别的消息里的地点 |

> 失败模式高度一致：**"事件是什么"基本对，"什么时候"系统性错**——这正是教师蒸馏里最难学的部分，
> 也是手册把配方规模定到 ~5k 对的原因（当前 358/662 对 ≈ 配方的 7%~13%）。

> 交付建议：教师基线 6/6 + 学生 v2 的实测差距即为"还需多少数据"的量化依据；
> 手册配方规模（~5k 对）对应约 4 小时生成 + 8 小时训练（本机 RTX 5070 Laptop）。

## 已知边界与后续建议

1. **能力上限已定位到具体技能**：v1/v2 失败清单逐条相同，都栽在
   ①"下周三/周五之前" → ISO 日期（日历块多步推理）②流内更新合并（version≥2）
   ③exam/activity 边界 ④取消语义。建议两条路并行：
   - **模型路**：按手册配方把数据推到 ~5k 对（本机可行命令：
     `node train\dist\train\gen-scenarios.js --n 4000 --concurrency 3` ≈ 4h，
     再 `gen-sft-data.js --out sft-v3.jsonl` ≈ 2h，训练 ≈ 8~10h；
     训练务必带 `--save-steps 20` 并用任务计划托管，见 README §8）。
   - **工程路**（更划算）：日期归一化交给代码——用规则/小parser 把"下周三""周五之前"
     转成日期后再让模型填 `start_at`/`deadline_at`；这符合手册"code owns the workflow"
     的分工，也能立刻消除最大一类失败。
2. **显存纪律**：8GB 机器上推理服务器与训练**不可同时驻留**（实测训练进程卡死，GPU 利用率
   4%、功耗 28W）；seq 4096 会在第 11 步 OOM，需 3072。
3. **批量推理**：客户端 60s 超时 + 6 群并发要求服务端批处理；单请求串行时第 4 个请求起超时。
   v2 这类"输出偏长"的模型还会因 768 token 上限被截断 → 重试 → 超时，交付选 v1 也有此因。
4. **量化**：Q4_K_M 待 llama-quantize 二进制（GitHub 可达时一条命令补齐）；当前交付 Q8_0。
5. **长训练托管**：本机两次长训练被会话重置连杀（一次损失 120/126 步），务必
   `--save-steps 20` + `schtasks` 托管 + `--resume` 续训。
