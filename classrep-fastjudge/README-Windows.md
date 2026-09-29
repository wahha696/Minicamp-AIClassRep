# Windows 安装（ClassRep 项目根旁）

把整个 `classrep-fastjudge` 目录放到 ClassRep 仓库根下，例如：

```
E:\AIClassRep\classrep-fastjudge\
  src\infer.py
  models\local-jev-v1.joblib
  requirements.txt
```

合入后的 ClassRep 会自动探测该约定路径，一般**不用**填 `FASTJUDGE_ROOT` / `LOCAL_JEV_MODEL_PATH` / `FASTJUDGE_PYTHON`。

## 建 Windows 虚拟环境（必须本机做一次）

在 PowerShell：

```powershell
cd E:\AIClassRep\classrep-fastjudge
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 自检

```powershell
.\.venv\Scripts\python.exe src\infer.py --model models\local-jev-v1.joblib
```

stdin 贴一行 JSON（UTF-8），例如：

```json
{"group_name":"t","context":[],"candidates":[{"sender_name":"a","text":"明天下午三点开会"},{"sender_name":"b","text":"哈哈"}]}
```

应看到高分 / 低分。然后重启 ClassRep 后端，状态灯应变绿。

## 注意

- 不要用 Linux 云电脑拷来的 `.venv`
- `models/local-jev-v1.joblib` 为晋升版（与 `models/best/` 同步）
- `.env` 推荐 `FASTJUDGE_MODE=local`
