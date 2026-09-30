# 交接文档（HANDOFF）· Class Rep 内置模型训练

> 用途：在新会话窗口里**不看历史对话**也能接着干。写于 2026-09-30，项目按用户要求终止时。
> 所有数字均为**本机实测**。仓库：`wahha696/Minicamp-AIClassRep`（main 分支，与远端同步）。

## 0. 任务目标（来自最初的用户请求）

按 `docs/本地训练小模型操作手册.md`，在本机 RTX 5070 Laptop 8GB（原生 Windows，无 WSL）上训练两个内置模型：

| # | 目标 | 规格 |
|---|---|---|
| ① | Jev 快判分类器 | rbt3 → ONNX INT8 ~40MB，替换 TypeSafe Key 依赖 |
| ② | 事件提取模型 | Qwen3-1.7B QLoRA 蒸馏 → GGUF（手册期望 Q4_K_M ~1.1GB，**实际交付 Q8_0 1.83GB**） |

外加：教师数据管道（prompt 与 `extract.ts` 逐字节同源 + `PROMPT_VERSION`）、训练/导出脚本、
`eval.ts` 与 `jev-calibrate` 两个验收门、`.env` 本地端点零代码验收链路。

## 1. 一句话结论

- **① Jev**：ONNX 交付了，但**同口径实测输给队友的 TF-IDF 模型**（召回 68~80% vs 88~92%），
  已诚实撤回替换建议 → **不要上线，维持 `classrep-fastjudge`**。
- **② 提取模型**：v1/v2 是"事件一条都提不出来"（0/6）；**形态对齐 + 日期归一化后，事件能全部提出，
  失败项从 18 降到 9~12，并有 1~2 个剧本首次通过考卷**。仍未 6/6——剩下的是更新合并/地点/取消
  等**能力型**失败（1.7B 边界），不是链路问题。
- **最有价值的两个可复用产物**：`apps/server/src/pipeline/date-normalize.ts`（已验证，可直接用）
  与 `train/data/sft-real.jsonl`（形态对齐数据）。

## 2. 环境与凭据（新窗口必须知道）

| 项 | 值 |
|---|---|
| 工作目录 | `C:\Users\m1823\Desktop\Minicamp-AIClassRep` |
| Python | `D:\python\python.exe`；**无控制台版** `D:\python\pythonw.exe`（见 §6 坑 1） |
| 依赖 | `train\pylibs-gpu`（需 `$env:PYTHONPATH="$PWD\train\pylibs-gpu"`）；torch 2.11+cu128、transformers 5.17、peft、bnb 4bit 在 sm_120 可用 |
| DeepSeek | key `sk-554ab7d728b3461d9bcaee7bc4ac9b24`；`LLM_BASE_URL=https://api.deepseek.com/v1`，`LLM_MODEL=deepseek-chat`（教师契约：temperature 0、max_tokens 4096、`response_format=json_object`） |
| 本地端点 | `.env`：`LLM_BASE_URL=http://127.0.0.1:8080/v1`、`LLM_API_KEY=local`、`LLM_MODEL=extract` |
| 硬件 | 8GB 显存（**训练与推理服务器不能同时驻留**）、32GB 内存（训练时常驻后仅剩 ~6GB）、磁盘 ~106GB 空闲 |

## 3. 交付物现状（磁盘上有什么）

**模型 `train/models/`**
| 路径 | 说明 |
|---|---|
| `jev-classifier-onnx/` | ① Jev ONNX INT8（目录 184MB，含 tokenizer）— **不建议上线** |
| `jev-rbt3/` | Jev 训练原始产物 + `eval.json`（合成集 AUC 1.0，未迁移到真实分布） |
| `qwen3-1.7b-sft{,-bf16}` | v1：358 对，掩码修复版（GGUF 已交付） |
| `qwen3-1.7b-sft-v2{,-bf16}` | v2：662 对 2 epoch（GGUF 已交付） |
| `qwen3-1.7b-sft-real{,-bf16}` | **当前最好的学生模型**：1,738 对形态对齐数据，1 epoch / 109 步 |
| `qwen3-1.7b-sft-real-bal/` | 负例调平版（**训练被终止在 ~22/88 步，无 checkpoint**，需从头训） |
| `extract-v1-Q8_0.gguf` / `extract-v2-Q8_0.gguf` | 各 1,749MB，结构已校验（qwen3 / 310 张量 / Q8_0+F32） |
| `extract-Q8_0.gguf` | real 模型的 GGUF（命名未带版本，注意别与旧文件混淆） |

**数据 `train/data/`**
| 文件 | 行数 | 说明 |
|---|---|---|
| `sft-real.jsonl` | 1,738 | **形态对齐**（557 剧本 → 1,850 批次，94% 接受）；负例 52% |
| `sft-real-bal.jsonl` | 1,400 | 负例调平到 **40%**（对齐生产），候选中位 9 |
| `sft-v1.jsonl` / `sft-v2.jsonl` | 358 / 2,795 | 旧路线（形态错配） |
| `sft-v4-exp.jsonl` / `sft-v4.jsonl` | 1,735 / 2,707 | 噪声注入实验，**对应模型未训练** |
| `sft-parity.jsonl` | 576 | prompt 同源性验证用 |
| `jev-train/val.jsonl` | 8,000 / 2,000 | Jev 合成数据 |
| `scenarios-real/` 557 个、`scenarios/` 2,342 个 | | 生成剧本 |

**代码与文档**
- 生产：`apps/server/src/pipeline/date-normalize.ts`（+ 16 项单测）、`eval.ts`（新增 `--dates`、`-v`）、
  `jev-calibrate.ts`（改为本地可跑 + `--dump`）
- 训练：`train/extract/sft_qwen3.py`、`03a_dequantize.py`、`03_export_gguf.py`、
  `train/env/serve_hf.py`（OpenAI 兼容替身服务器）
- 脚本：`train/run_acceptance.ps1`（`-Model -SkipGguf -Dates -Week`）、
  `train/rebuild-realistic-data.ps1`（先报价，`-Yes` 才花钱）、
  `train/train-real-dataset.ps1`（**只蒸馏+训练，不重新生成**）
- 工具：`train/tools/` 15 个（`batch_shape` / `realism_gap` / `candidate_pool` / `head_to_head` /
  `parse_eval` / `compare_evals` / `verify_gguf` / `quality_gate` / `rebalance_negatives` /
  `loss_history` / `eta` / `coverage_update` / `update_flow` / `parse_eval` / `README`）
- 文档：`train/DELIVERABLES.md`（**执行摘要，先读这个**）、`BATCH-SHAPE.md`（形态量化与实测结果）、
  `COST.md`、`ALIGNMENT-fastjudge.md`、`jev/INTEGRATION.md`、
  `classrep-fastjudge/docs/HANDOFF-from-trainer.md`（给队友的回执）

## 4. 关键实测数字（写报告/接活直接用）

**考卷（`eval.ts`，教师 = deepseek-chat）**
| 模型 | 裸分 | 加 `--dates` | 失败项 | 其中时间类 |
|---|---|---|---|---|
| 教师 | **6/6** | — | 0 | 0（15 次调用 7s） |
| v1 / v2 / v3 | 0/6 | — | 16~24 | 5~10 |
| **形态对齐 real** | **0/6**（两轮一致） | **1/6、2/6** | 18 → **9~12** | 10 → **1** |

**形态对齐数据的形态**（vs 真实考卷）
| 指标 | sft-real | 旧 sft-v2 | 真实 |
|---|---|---|---|
| 批内候选数中位 | **8** | 23 | 6 |
| 落生产区间(≤13) | **100%** | 26% | 100% |
| 候选字/条 | **9** | 17 | 11 |
| 含时间表达 | 16.5% | 31.6% | 25.6% |
| 负例比例 | 52% | 24% | ~40% |

**日期归一化模块验证**：考卷日期用例 **10/10**、跨周边界 **4/4**、65k 消息误报审计
（弱信号 13% 被拦截、误判"过去" 7.5%→**2.7%**）、**16 项单测**。

**成本实测**：生成剧本 **¥0.016/次调用**（缓存命中 ~64%，**输出占 92%**）、
蒸馏 **¥0.0016/对**；1,738 对形态对齐数据总成本 **≈¥9.5**（旧路线 ¥26 换 2,707 对错配数据）。
付费总量约 **¥40**（含若干失败重试）。

## 5. 下一步（按性价比排序，命令可直接跑）

1. **判定"更新合并"归属**（免费，最能决定方向）：
   ```powershell
   $env:PYTHONPATH="$PWD\train\pylibs-gpu"
   python train\env\serve_hf.py --model train\models\qwen3-1.7b-sft-real-bf16 --port 8080
   pnpm --filter server exec tsx src/pipeline/try-extract.ts reschedule   # 看 action 是 update 还是 create
   pnpm --filter server exec tsx src/pipeline/try-extract.ts cancel
   ```
   输出 `update #<id> … A203` → 代码侧（查 `reconcile.ts`）；输出 `create … A301` → 模型侧（走第 2 条）。
2. **补"更新密集"数据重训**（约 ¥10 / 2h）：考卷 83% 场景含更正，训练数据只有 40%。
   提高 `reschedule`/`multi`/`cancel` 模板权重（现 ~10%/~10%/~7%），并要求"更正后同一事件只有一条、字段取最新"。
3. **负例调平对照**（零 API，约 1.5h）：`sft-real-bal.jsonl` 已备好，直接
   ```powershell
   python train\extract\sft_qwen3.py --data train\data\sft-real-bal.jsonl --epochs 1 --seq 3072 --no-unsloth --save-steps 25 --out train\models\qwen3-1.7b-sft-real-bal
   ```
   目标：看能否补上"漏提问卷/年级大会"。
4. **验收（双臂一次跑完）**：
   ```powershell
   powershell -File train\run_acceptance.ps1 -Model qwen3-1.7b-sft-real -SkipGguf -Dates
   ```
5. 可选：Q4_K_M 量化（需 `llama-quantize.exe`，此前 GitHub releases 反复拉不下来，故交付 Q8_0）。

## 6. 环境坑（血泪清单，新窗口务必先读）

1. **控制台关闭会杀死训练**：`forrtl: error (200): program aborting due to window-CLOSE`
   （任务计划以"登录时运行"启动的进程带控制台，控制台关闭即收到 `CTRL_CLOSE_EVENT`）。
   **规避：用 `pythonw.exe` 跑训练**，或用本会话后台作业（实测可稳定数小时）。
2. **任务计划在本机不可靠**：新建的 `schtasks` 任务多次在启动后数秒即死（同样症状）。
3. **PowerShell 5.1 读 UTF-8 无 BOM 的中文会误解析**：mojibake 字节可能被当成续行符，
   **吞掉下一行代码**（曾吞掉 `$usable` 赋值，导致报价里数字消失）。**脚本一律 ASCII-only**。
4. **`*>` 重定向写出 UTF-16**：所有解析日志的脚本必须先做编码探测（`utf-16`→`utf-8`→`gbk`→`latin-1`）。
5. **PowerShell 管道会吞掉 Trainer 的 loss 行**（进度条 `\r` + 双流合并）：
   loss 看 `train/artifacts/sft-runs-*/checkpoint-*/trainer_state.json`（工具：`loss_history.py`）。
6. **`Select-Object -First N` 会杀掉生产者**：我用它截服务器输出，直接把服务器弄死了，
   导致一次**假的 `llm=error` 0/6**（看起来像模型失败）。起服一律重定向到文件。
7. **8GB 显存**：训练与推理服务器**不可同时驻留**；训练时 GPU 应 100%/70~95W，若掉到 4%/28W 就是被抢了。
8. **系统内存**：32GB，训练常驻后仅剩 ~6GB；GGUF 转换等重活要串行。
9. **笔电休眠/合盖会静默吞掉进度**：`powercfg /change standby-timeout-ac 0` +
   `powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0` + `/setactive`。
10. **GitHub 间歇不可达**：推送要写重试循环（本次多次"第 N 次成功"）。
11. **会话作业注册表会被重置**：后台作业可能被静默杀死（本次多次发生），长任务要有 checkpoint + `--resume`。
12. **`--resume` 在没有 checkpoint 时会让 Trainer 抛错**（已在 `sft_qwen3.py` 修好：探测后再决定）。
13. **评测有运行间波动**：同一个模型两次裸分可能 14 vs 18 个失败项（本地服务器动态批处理/超时所致），
    结论要按波动幅度打折；`llm=error` 的那次**不能当模型成绩**。

## 7. 当前在飞状态（已按用户要求终止）

- 负例调平训练 `qwen3-1.7b-sft-real-bal`：终止于 **~22/88 步**，**没有 checkpoint**（第一个在 25 步），需从头训。
- 无运行中的训练/服务器进程；`python` 进程 0 个。残留 3 个 node 进程属工具链/会话自身，未动。
- 所有改动**已提交并推送**（`git status` 干净，与 `origin/main` 同步，最新 `08cc29f`）。
- 测试：`pnpm test` = **server 724 通过 / web 190 通过**（含我为日期模块新增的 16 项）；typecheck 通过。
