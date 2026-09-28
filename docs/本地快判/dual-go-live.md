# dual-run 启用（2026-09-29）

产品决策：`FASTJUDGE_MODE=dual`，`FASTJUDGE_ROUTE=local`。

## 配置

复制仓库根 `.env.example` → `.env`，至少保证：

```bash
ENABLE_JEV=true
FASTJUDGE_MODE=dual
FASTJUDGE_ROUTE=local
LOCAL_JEV_MODEL_PATH=/workspace/classrep-fastjudge/models/local-jev-v1.joblib
FASTJUDGE_ROOT=/workspace/classrep-fastjudge
TYPESAFE_API_KEY=   # dual 旁路打 Jev 需要；无 key 时远端分数为空，路由仍走 local
```

模型文件与 `classrep-fastjudge/models/best/local-jev-v1.joblib` 同步为晋升版。

## 回退

- 路由改回远端：`FASTJUDGE_ROUTE=jev`
- 完全关本地：`FASTJUDGE_MODE=jev`

## 状态

- 服务端 dual 代码已在本机 clone（未 push）
- 烟测：`infer.py` 对晋升 joblib 可打分
