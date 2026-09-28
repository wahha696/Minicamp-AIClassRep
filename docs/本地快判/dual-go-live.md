# dual-run 启用（2026-09-29）

产品决策：`FASTJUDGE_MODE=dual`，`FASTJUDGE_ROUTE=local`（holdout 上 local 全面不弱于远端 Jev；该决策仍成立）。

## 配置

复制仓库根 `.env.example` → `.env`。项目以 **Windows（QQ NT）** 为主；本地路径**无 Linux 假默认**，须显式填写。

至少保证：

```bash
ENABLE_JEV=true
FASTJUDGE_MODE=dual
FASTJUDGE_ROUTE=local
TYPESAFE_API_KEY=   # dual 旁路打 Jev 需要；无 key 时远端分数为空，路由仍走 local
```

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

模型文件与 `classrep-fastjudge/models/best/local-jev-v1.joblib` 同步为晋升版。

## 回退

- 路由改回远端：`FASTJUDGE_ROUTE=jev`
- 完全关本地：`FASTJUDGE_MODE=jev`

## 观测

- `DEMO_MODE=true` 且账号就绪时，`GET /health` 附带 `dual_score_log`（最近若干批双边分数摘要，无群聊原文）
- 本地 infer 失败后约 30s 内跳过本地 spawn（与远端 `JEV_BACKOFF_MS` 同风格）；dual 下仍可路由到远端

## 状态

- 服务端 dual 代码已合入本分支；Windows CI 依赖 main 上的 vitest 超时放宽
