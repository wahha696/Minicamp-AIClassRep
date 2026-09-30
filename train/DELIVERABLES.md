# Class Rep 内置模型交付说明（train/DELIVERABLES.md）

> 按《本地训练小模型操作手册》在本机（RTX 5070 Laptop 8GB / Windows / 原生）完成的两个模型交付。
> 全部数字为本机实测，非估算。

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

| 版本 | 数据 | JSON 合法 | eval 结果 | 结论 |
|---|---|---|---|---|
| v0（首训） | 358 对 | 偶发 ```json 围栏 | 0/6 | 定位到**掩码错位**：Qwen3 空 think 块致 JSON 开头 token 无监督 |
| v1（掩码修复） | 358 对 | 单请求纯 JSON ✅；并发批次仍有围栏 | 0/6 | 服务端补 `response_format=json_object` 约束后围栏消失 |
| **v1（掩码修复 + JSON 约束）** | 358 对 | **15/15 首轮即合法、0 围栏、0 超时** | **0/6** | 事件识别可用，失败集中在**日期解析**与**更新合并**；15 次调用 231.5s、`llm=ok` |
| v2（2 epoch，任务计划托管） | 662 对（569 剧本） | 首轮合法但输出变长（多次触顶 768 cap） | **0/6** | 失败模式与 v1 **完全相同**，且因输出过长导致截断重试（15 次调用 688.8s、`llm=error`） |

> **关键结论**：v1（358 对）与 v2（662 对，+85% 数据）的失败清单**逐条一致** —— 说明当前差距
> 不是"再补一点数据"能解决的，而是 **1.7B + LoRA 在学习"日历块 → ISO 日期"多步推理**上的能力上限。
> 因此：**交付 v1 作为事件提取模型**（更快、无截断、同分），v2 作为规模化实验留档。

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
