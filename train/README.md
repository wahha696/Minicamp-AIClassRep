# 训练工作区 runbook（本地训练小模型 · RTX 5070 Laptop 8GB 实机版）

> 上游文档：[《本地训练小模型操作手册》](../docs/本地训练小模型操作手册.md)（路线与坑清单）、[《本地模型蒸馏方案》](../docs/本地模型蒸馏方案.md)（架构评审稿）。
> 本目录是手册在**这台 RTX 5070 Laptop 8GB + Windows 原生（不用 WSL）**机器上的落地执行件。
> 最终交付物只有两个文件：`models/jev-classifier.onnx`（INT8，~40MB）与 `models/extract-Q4_K_M.gguf`（~1.1GB）。

---

## 0. 总路线（对应手册 §0）

```
第 1 周   Jev：合成数据（已完成脚本）→ TF-IDF 基线（已跑通 AUC≈1.0）→ rbt3 微调 → ONNX INT8 → 阈值重扫
第 2 周   教师数据（DeepSeek API，需要 .env 填 LLM_API_KEY）→ Qwen3-1.7B QLoRA v1
第 3 周   eval 迭代 → 盲测 → 定稿 GGUF → 交 M2 集成
```

目录约定（全部 gitignore，不进仓库）：

| 目录 | 内容 |
|---|---|
| `train/data/` | jev-*.jsonl、sft-v1.jsonl、scenarios/（合成剧本） |
| `train/models/` | rbt3、ONNX、合并后的 SFT 模型、GGUF |
| `train/artifacts/` | 基线指标、样例 prompt、训练运行日志 |
| `train/pylibs/`、`train/pylibs-gpu/` | Python 依赖（--target 安装，免 venv 引导问题） |
| `train/llama.cpp/` | GGUF 转换与 llama-server（clone） |

## 1. 关键铁律（操作手册 §2.2，脚本已内置强制）

1. **prompt 逐字节同源**：训练样本的 system/user prompt 由 `train/lib/prompts.ts` 现场 import 生产
   `extract.ts` 的 `buildSystemPrompt()` / `buildUserPrompt()` 生成——不存在第二份 prompt 文案。
   `extract.ts` 里有 `PROMPT_VERSION = 1` 常量，数据行 meta 带版本号，训练脚本发现不一致直接退出。
2. **`data/mock/*.json` 6 剧本永不进训练集**（是 eval.ts 的考卷）。训练剧本只放 `train/data/scenarios/`。

## 2. 快速开始（今天就能做的部分）

```powershell
# ① Jev 合成数据（不花 API）：10000 条，正负 ≈ 1:3
node train\dist\train\gen-jev-data.js --n 10000 --seed 7

# ② TF-IDF 基线（已完成过一次：val AUC 1.0 / 召回100% 可丢 56% 候选）
$env:PYTHONPATH="$PWD\train\pylibs"; python train\jev\01_baseline.py

# ③ GPU 环境（torch cu128 + unsloth + onnxruntime，见 train\env\setup_windows.ps1）
powershell -ExecutionPolicy Bypass -File train\env\setup_windows.ps1

# ④ rbt3 训练（5070 上十几分钟一个 epoch）
$env:PYTHONPATH="$PWD\train\pylibs-gpu"; python train\jev\02_train_rbt3.py

# ⑤ ONNX INT8 导出（~40MB 交付物）+ 阈值扫描
python train\jev\03_export_onnx.py
python train\jev\04_thresholds.py
```

Node 侧脚本改完 TS 后要重新编译：`node node_modules\typescript\bin\tsc -p train\tsconfig.json`。

## 3. 教师蒸馏（DeepSeek API，不占显存）

```bash
# 1) 仓库根 .env 填 DeepSeek Key（LLM_API_KEY=sk-...，见 .env.example）
# 2) 生成合成剧本（教师写剧本 + 期望事件）
node train/dist/train/gen-scenarios.js --n 300 --seed 1 --concurrency 3
# 3) 剧本回放 → 生产 prompt → 教师提取 → 质量门 → sharegpt JSONL
node train/dist/train/gen-sft-data.js --concurrency 3
#    断点续跑：直接重跑同一命令（已写样本自动跳过）
# 4) 质检抽读
node train/dist/train/gen-sft-data.js --dryrun      # 样例 prompt 人工检查
```

数据配方对齐手册 §2.1：负样本（纯闲聊剧本 + 正剧本空批）占比必须 ~30%，
改期/取消/多事件/历史补齐/近似事件模板齐全，只收 zod 通过 + confidence ≥ 0.8 的教师输出。

## 4. Qwen3-1.7B QLoRA 训练 + GGUF

```powershell
$env:PYTHONPATH="$PWD\train\pylibs-gpu"
# 冒烟（30 条 1 epoch，先冒烟再全量，手册 §1.3）
python train\extract\sft_qwen3.py --limit 30 --epochs 1 --out train\models\smoke
# 正式（v1 = 358 对 ≈ 2 小时）
python train\extract\sft_qwen3.py --epochs 3 --no-unsloth
# 转 GGUF（f16 → 量化）
python train\extract\03_export_gguf.py
```

> **Windows/墙内工具链实录**（2026-09 实测）：
> - unsloth 能加载但 Triton kernel 编译失败（mingw gcc 对 `\\?\` 路径处理有坑）→ 用 `--no-unsloth`
>   走标准 transformers+peft+bitsandbytes 路线（bnb 4bit 在 sm_120 上正常，脚本自动回退 bf16）。
> - GGUF 转换器：GitHub 被墙时用 jsdelivr 抓单文件（`@b5200` tag 的 `convert_hf_to_gguf.py`，
>   已含 Qwen3 支持）+ `pip install gguf==0.19.0`；本目录已带补丁版（VisionModel 的 CLIP_VISION
>   引用降级为 MMPROJ fallback，文本模型不走该路径）。
> - Q4_K_M 量化需要 llama-quantize 二进制（GitHub release 被墙）；转换器可直接出 `--outtype q8_0`
>   （1.7B ≈ 1.9GB，比 Q4_K_M 大但精度更好）。拿到 llama.cpp 后再补 Q4_K_M（~1.1GB）。

OOM 阶梯（手册 §4.3）：`--seq 2048` → `--rank 16` → `--grad-accum 32` → 换 0.6B/1.4B 基座验证管线。

## 5. 零代码验收（不改一行服务器代码）

`ai-settings.ts` 在网页未配 key 时回落读 `.env`。训练期在仓库根 `.env` 写：

```
LLM_BASE_URL=http://127.0.0.1:8080/v1
LLM_API_KEY=local
LLM_MODEL=extract
```

```bash
# 起 llama-server（冒烟 + eval 都走它）
train\llama.cpp\build\bin\llama-server.exe -m train\models\extract-Q4_K_M.gguf --port 8080 --ctx-size 8192 --jinja
# 冒烟（门：JSON ≥99%、think 前缀 0）
$env:PYTHONPATH="$PWD\train\pylibs-gpu"; python train\extract\04_smoke_gguf.py --n 20
# 精度验收（eval 考卷：6 剧本 × 7 天，期望全绿）
pnpm --filter server exec tsx src/pipeline/eval.ts --week
# Jev 阈值重校准（rbt3 本地推理接入后）
pnpm --filter server exec tsx src/pipeline/jev-calibrate.ts
```

**llama-server 被墙时的替代**（`train/env/serve_hf.py`，transformers 版 OpenAI 兼容服务器，
动态批处理 ≤6 请求/批，6 路并发全落在 60s 客户端超时内；**并实现 `response_format=json_object`
的服务端 JSON 约束**——等价 llama.cpp 的语法模式，这是生产 `extract.ts` 依赖的能力）：

```powershell
$env:PYTHONPATH="$PWD\train\pylibs-gpu"
python train\env\serve_hf.py --model train\models\qwen3-1.7b-sft-bf16 --port 8080
# .env: LLM_BASE_URL=http://127.0.0.1:8080/v1  LLM_API_KEY=local  LLM_MODEL=extract
pnpm --filter server exec tsx src/pipeline/eval.ts
```

> ⚠️ **验收跑完记得切回教师端点再跑数据脚本**：`.env` 指向本地端点时，`gen-sft-data.js` /
> `gen-scenarios.js` 会直接连接失败（也是防误花钱的天然闸门）。要调教师就显式覆盖环境变量：
> `$env:LLM_BASE_URL='https://api.deepseek.com/v1'`（真实环境变量优先于 `.env`）。
> 成本自查与省钱杠杆见 `train/COST.md`。

> **QLoRA 导出实录（bnb 4bit 双坑）**：
> 1. `merge_and_unload()` 后模型仍是 bnb 4bit 格式（safetensors 含 U8 packed + absmax，
>    转换器无法映射 `absmax` 张量）→ `train/extract/03a_dequantize.py` 把 196 层
>    Linear4bit 反量化成干净 bf16（`--model <dir>` → 输出 `<dir>-bf16`，3.44GB），再转 GGUF。
> 2. transformers 5.x `save_pretrained` 对 bnb 模型走"反操作"路径会炸（reverse_op
>    NotImplementedError）→ 03a 直接用 `safetensors.torch.save_file` 手写 state_dict +
>    修正 config（quantization_config=None, dtype=bfloat16）。

## 6. 评测门（手册 §6，全过才算可发布）

| # | 检查 | 工具 | 通过线 |
|---|---|---|---|
| 1 | JSON 一次合法率 | `04_smoke_gguf.py` | ≥99% |
| 2 | 6 剧本 × 7 天 | `eval.ts --week` | 全绿（多余事件=0） |
| 3 | 真实盲测集 | 30~50 批人工标注 | ≥ 教师 90% |
| 4 | 无 think 前缀 | `04_smoke_gguf.py` | 100% |
| 5 | CPU 时延 | llama-server 实测单批 | 记录基线（预期 40~90s/批 @1.7B） |
| 6 | Jev 阈值 | `04_thresholds.py` + jev-calibrate | 真通知召回 100%、p90<100ms |

## 7. 当前状态与分工

| 项 | 状态 |
|---|---|
| prompt 同源桥 + PROMPT_VERSION | ✅ `train/lib/prompts.ts`（冒烟通过，确定性断言过） |
| 合成剧本生成器 | ✅ **863 剧本**（11 类覆盖；两轮共质量门拦 57 条：JSON 格式、expected 数量越界、消息数异常） |
| SFT 数据 v1（教师蒸馏） | ✅ **358 对**（87 负例 24%，全部 JSON 合法、est tokens p50 2389 / max 3168，教师成本 ~97 万 tok，PROMPT_VERSION=1） |
| SFT 数据 v2（教师蒸馏） | ✅ **675 对 / 518 剧本**（431 有事件 64% + 244 负例 36%，0 非法 JSON、0 围栏，pv=1；成本 171 万 tok 输入 + 16 万输出；13 条 >seq3072 用 `--drop-over-seq` 过滤） |
| Jev 合成数据 | ✅ 10k 条（1:3 配比）；TF-IDF 基线 AUC 1.0（锚点） |
| Jev rbt3 微调 | ✅ **eval AUC=1.0 / PR-AUC=1.0 / acc@0.5=1.0**（44s@5070，见 `models/jev-rbt3/eval.json`） |
| Jev ONNX INT8 | ✅ **38.7MB** 交付物 + PyTorch↔ONNX 概率差 1.4e-09（`models/jev-classifier-onnx/`） |
| Jev 阈值（合成数据口径） | 建议 `JEV_DROP_BELOW=0.45`（可丢 74% 候选，召回 100%）；`JEV_URGENT_AT=0.8` 命中 518/518、误报 0；单批 30 条 CPU p50≈90-150ms（功耗状态敏感，接 Node 侧后用 jev-calibrate 复扫） |
| Qwen3 QLoRA 训练 | ✅ 358 对 × 3 epoch 完成（r32/α64，bnb 4bit @5070；掩码修复后重训，loss 0.57→0.12，~110s/步）；v2（662 对 × 2 epoch）计划任务托管运行中 |
| 首轮 eval 暴露掩码 bug → 修复重训 | ✅ 根因：Qwen3 空 think 块致 JSON 开头 token 无监督（输出带 ```json 围栏）→ `encode_pair` 改 token 级前缀拼接 |
| 学生模型 v1 实测（掩码修复+JSON 约束） | ⚠️ **JSON 15/15 首轮合法、0 围栏、0 超时**；考卷 **0/6**——失败集中在"什么时候"（deadline 空、下周X 算成明天）与更新合并，详见 `DELIVERABLES.md` 失败清单 |
| 学生模型 v2 实测（662 对 × 2 epoch） | ⚠️ 考卷 **0/6**，失败清单与 v1 **逐条相同**且输出更长（触发截断重试）→ **交付选 v1**；结论：差距是能力上限，不是"再补一点数据" |
| 规模化建议 | 模型路：数据推到 ~5k 对（生成 ~4h + 蒸馏 ~2h + 训练 ~8-10h）；工程路：把"下周三/周五之前"的日期归一化交回代码（更划算，符合手册分工） |
| 教师基准（eval.ts 考卷） | ✅ **6/6 剧本全绿**（15 次 LLM 调用 7s，DeepSeek 端点；学生模型对比基准线） |
| GGUF 转换链 | ✅ 转换器打通（b5200+补丁版 + gguf 0.19.0）；**已产出 `extract-v1-Q8_0.gguf` 1.83GB**；Q4_K_M 待 llama-quantize 二进制 |
| 本地推理服务器 | ✅ `train/env/serve_hf.py`（OpenAI 兼容 shim，动态批处理，**实现 `response_format=json_object` 服务端 JSON 约束**，实测 15 次调用 0 失败） |
| 一键验收脚本 | ✅ `train/run_acceptance.ps1`（反量化 → GGUF → 起服 → eval，参数化模型名） |
| 运行时集成（M2：fetch-model + LocalModelManager + ai-settings 回落） | 队友并行做，互不依赖（ONNX 接入说明见 `train/jev/INTEGRATION.md`） |

## 8. 已知坑（本机实测）

- **PowerShell 执行策略**挡 `pnpm.ps1`：用 `pnpm.cmd`。
- **沙箱/管道限制**：tsx/esbuild 的子进程 spawn 会 EPERM——训练脚本一律先
  `node node_modules\typescript\bin\tsc -p train\tsconfig.json` 编译，再 `node train\dist\...` 直接跑。
- **pip**：把 TMP/TEMP 指到 `train\.cache\temp`，用 `--target train\pylibs*` 安装。
- 训练期显存纪律（手册 §1.2）：关浏览器视频/游戏；插电 + 性能模式；`models/` 预留 ≥60GB。
- **Qwen3 全量训练 OOM 实录**：seq 4096 在第 11/69 步 CUDA OOM（151k 词表 logits 峰值 ~2.5GB +
  Windows 无 expandable_segments 抗碎片）→ `--seq 3072`（p99=3060 几乎无截断）后全程稳定。
- **Qwen3 空 think 块掩码坑**（首轮 eval 暴露）：训练 `encode_pair` 若 full 用 3 消息模板而
  prompt 用 `add_generation_prompt=True, enable_thinking=False`，两条路径在 assistant 处
  分叉（后者多出空 `∥think\n\n∥`），掩码会盖掉 JSON 开头几个 token → 模型没学过输出开头，
  推理时随机带 ` ```json ` 围栏。修复：`encode_pair` 改 token 级拼接（prompt_ids 严格前缀 +
  assistant_ids + `<|im_end|>`），且推理 prompt 保持同构（enable_thinking=False）。
- 训练数据 100% 纯 JSON 无围栏（`train/.cache/check_fence.py` 验证），围栏全部来自掩码错位。
- **`response_format=json_object` 必须由服务端实现**（第二轮实测）：`extract.ts` 每个请求都带
  `response_format: {type:'json_object'}`，真实 llama-server 会据此施加 JSON 语法约束；替身
  服务器若忽略它，1.7B 模型在复杂批次上会偶发输出 ` ```json ` 围栏 + 裸数组（OOD schema，
  prompt 里本无此格式）。`serve_hf.py` 现按 `{"events": [`（提取类）/ `{`（其他）锁首 token。
- 客户端 60s 超时 + 6 群并发 = 服务器必须批处理：单请求串行时第 4 个请求起就会超时
  （实测 ConnectionResetError）；**推理服务器与训练不可同时驻留 8GB 显存**（实测训练卡死：
  GPU 利用率掉到 4%，功耗 28W，进度停在同一步）。
- **长链路用任务计划串起来（本机实测可用）**：跑多轮"训练 → 验收 → 下一轮训练"时，
  每段都写成 `.cmd`（末尾 `echo EXITCODE=%ERRORLEVEL%` 落进自己的日志），
  下一段用 `findstr /C:"EXITCODE" <上一段日志>` 轮询等待，再用
  `schtasks /create /tn <名> /tr "cmd.exe /c <wrapper.cmd>" /sc once /st 23:59 /f` + `/run` 启动。
  这样会话重置、终端关闭都不会中断；本次 v3→验收→v4→验收 四个阶段就是这么串的。
  注意：**日志跨轮次会累积**，等待条件必须只看当轮标记（同一文件多轮跑时先删旧日志）。
- **笔电休眠会静默吞掉训练进度**（实测两次）：`powercfg /change standby-timeout-ac 0` 只管
  空闲超时，**合盖动作**会覆盖它 → 必须另设 `powercfg /setacvalueindex SCHEME_CURRENT
  SUB_BUTTONS LIDACTION 0` + `/setactive`。休眠期间进度条只在恢复后跳一大步（表现为
  "1 步耗时 3000s"），不是 GPU 故障。
- **系统内存也要串行**：本机 32GB，训练常驻后仅剩 ~6GB 可用；此时并发跑 GGUF 转换（需
  ~6GB 读入 3.4GB 权重）会以 `0xC0000005` 访问违例崩溃。重活一律排队做。
- **长训练必须"托管 + 存档"**：本机实测两次长训练被会话/作业注册表重置连带杀掉（一次跑到
  120/126 步、一次在加载阶段），`save_steps=500` 意味着**全部白跑**。正确姿势：
  `--save-steps 20`（每 20 步落 checkpoint）+ 用任务计划程序托管（脱离会话进程树）：
  ```powershell
  schtasks /create /tn "ClassRepTrainV2" /tr "cmd.exe /c `"<wrapper.cmd>`"" /sc once /st 23:59 /f
  schtasks /run /tn "ClassRepTrainV2"
  ```
  中断后用 `--resume` 从最近 checkpoint 接着跑（脚本已支持 `Trainer.train(resume_from_checkpoint=True)`）。
- Qwen3 think 泄漏：训练数据纯 JSON + 模板 enable_thinking=False + llama-server `--jinja`；
  服务端 `extract.ts` 的 JSON.parse 前剥 `<think>…</think>` 兜底是 M2 的一行改动，不在训练侧。
