# 本地快判启用（更新 2026-09-29）

产品决策：**默认只用本地** `FASTJUDGE_MODE=local`（holdout 上已不弱于远端 Jev）。`dual` 仅作调试对照，不默认开。

## 推荐配置

复制仓库根 `.env.example` → `.env`。项目以 **Windows（QQ NT）** 为主；路径须显式填写。

```bash
ENABLE_JEV=true
FASTJUDGE_MODE=local
# TYPESAFE_API_KEY 在 local 模式下可不填（不走远端 Jev）
```

### 零配置约定

把 `classrep-fastjudge` 目录（含 `src/infer.py`、`.venv`、`models/`）放到**项目根目录**即可：无需改 `.env`，启动自动启用，日志会打印 `本地快判：就绪（…）`。

工作区放在别处时才需要显式配置：

### Windows 路径示例

```bash
FASTJUDGE_ROOT=D:\dev\classrep-fastjudge
LOCAL_JEV_MODEL_PATH=D:\dev\classrep-fastjudge\models\local-jev-v1.joblib
FASTJUDGE_PYTHON=D:\dev\classrep-fastjudge\.venv\Scripts\python.exe
```

若只设 `FASTJUDGE_ROOT`，模型默认取 `ROOT\models\local-jev-v1.joblib`；`FASTJUDGE_PYTHON` 空时会优先探测 `ROOT\.venv\Scripts\python.exe`。

### Linux / macOS 开发机示例

```bash
FASTJUDGE_ROOT=/path/to/classrep-fastjudge
LOCAL_JEV_MODEL_PATH=/path/to/classrep-fastjudge/models/local-jev-v1.joblib
FASTJUDGE_PYTHON=/path/to/classrep-fastjudge/.venv/bin/python
```

## 可选：dual 对照

需要和远端 Jev 并排打分时：

```bash
FASTJUDGE_MODE=dual
FASTJUDGE_ROUTE=local
TYPESAFE_API_KEY=...
```

`DEMO_MODE=true` 且账号就绪时，`GET /health` 可附带 `dual_score_log`。

## 回退

- 改回远端 Jev：`FASTJUDGE_MODE=jev`（并配置 `TYPESAFE_API_KEY`）
- 本地失败会安全回退（分数 `null` → 候选交 LLM）；失败后约 30s 退避跳过 spawn
