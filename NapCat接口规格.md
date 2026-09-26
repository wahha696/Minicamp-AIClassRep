# NapCat 接口规格（源码确认）

> 来源：随包 `tools/napcat/NapCat.Shell/napcat.mjs`（v4.18.28 Shell 版）**静态阅读**，行号对应该文件；
> 标 ✅ 的项另有 `tools/` 在本机的运行记录佐证。
> 本文只列 `架构.md` 选定的**唯一路径**用到的 NapCat 行为。产品取舍以 `架构.md` 为准。
> ClassRep **不使用 NapCat WebUI**（`架构.md` §9-D16），WebUI 接口一律不在本文范围。

---

## 1. 启动（spawn）

```ts
spawn(join(napcatDir, "NapCatWinBootMain.exe"),
      [qqPath, join(napcatDir, "NapCatWinBootHook.dll"), ...(uin ? ["-q", uin] : [])],
      { cwd: napcatDir, windowsHide: true,
        env: { ...process.env,
               NAPCAT_PATCH_PACKAGE: join(napcatDir, "qqnt.json"),
               NAPCAT_LOAD_PATH:     join(napcatDir, "loadNapCat.js"),
               NAPCAT_INJECT_PATH:   join(napcatDir, "NapCatWinBootHook.dll"),
               NAPCAT_LAUNCHER_PATH: join(napcatDir, "NapCatWinBootMain.exe"),
               NAPCAT_MAIN_PATH:     join(napcatDir, "napcat.mjs").replaceAll("\\", "/") } });
```

- 参数与环境变量照抄 `tools/napcat/NapCat.Shell/napcat-launcher.bat`。✅ 该脚本**不提权**，在本机注入成功并收发消息；NapCat 运行时写出的 `config/*`、`cache/qrcode.png`、`guild1.db` 属主均为普通用户。
- **不调用任何 `launcher*.bat`**：官方 `launcher.bat` 会自提权、依赖 `wt.exe`；`launcher-user.bat` 等结尾有 `pause`。
- `loadNapCat.js` 由后端每次启动写入：`(async () => {await import("<pathToFileURL(napcat.mjs).href>")})()`（bat 版用字符串拼 `file:///`，含中文/空格路径时不可靠）。
- QQ.exe 定位：`reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v UninstallString` → 取其所在目录 + `QQ.exe`；取不到用 `C:\Program Files\Tencent\QQNT\QQ.exe`。本机：`D:\Uninstall.exe` → `D:\QQ.exe` ✅。
- 工作目录：不设 `NAPCAT_WORKDIR`，`config/`、`cache/`、`logs/` 都在 `napcat.mjs` 所在目录（L40589）。
- 进程模型：主进程拉起 Worker 子进程（`NAPCAT_WORKER_PROCESS=1`，L82709）；Worker 在 60s 内异常退出达上限次数则主进程退出（L82736）。后端只盯 `NapCatWinBootMain.exe` 的 pid，结束时 `taskkill /T /F /PID`。

## 2. 关闭 WebUI

`config/webui.json` 设 `"disableWebUI": true` → WebUI 初始化直接 return（L70112-70114）。副作用（都是想要的）：

- 不监听 6099，也不存在端口漂移；
- 不走"默认 token 自动改写 + 登录后给本人发 QQ 私信告知新密码"的逻辑（L70118-70120 设置、L80807-80818 发送），用户不会收到奇怪消息；
- `autoLoginAccount` / `NAPCAT_QUICK_ACCOUNT` 快速登录依赖 WebUI 注册的回调（L70128-70130），**随之失效** → 快速登录只用 `-q`（§4）。

写法：读出已有 `webui.json`（没有则 `{}`），只改 `disableWebUI` 后写回。字段类型写错会导致整份配置读取失败退回默认值（L41749），所以只动这一个布尔字段。

## 3. OneBot 配置：预写模板，免知道 QQ 号

`ConfigLoader.read()`（L38590-38592）：

```ts
const perUin = `onebot11_${uin}.json`, tpl = `onebot11.json`;
exists(perUin) ? load(perUin) : (exists(tpl) && load(tpl), save() /* 写成 perUin */);
```

- 账号首次登录时 `onebot11_<uin>.json` 不存在 → 以 `onebot11.json` 为模板加载，并存成 `onebot11_<uin>.json`。所以**启动前只写 `onebot11.json` 就够**，不需要知道 QQ 号。
- 已登录过的账号读 `onebot11_<uin>.json` → 后端启动时把目录下已有的 `onebot11_*.json` 一并覆盖为同一份内容。
- 文件用 `JSON.parse`，必须是合法 JSON（不能有注释）；缺省字段按 schema 补默认值。
- ✅ `tools` 正是靠预置 `onebot11.json`（websocketServers 3001）免进 WebUI，`onebot11_<两个 uin>.json` 都由它生成，内容与模板一致。
- 内容见 `架构.md` §4.1。`reportSelfMessage: true` 时自己发的消息以 `post_type = "message_sent"` 推送（需求文档 §8 实测）。

## 4. 登录

启动时的分支（L82307-82337）：

| 启动参数 | NapCat 行为 |
|---|---|
| 无 `-q` | 直接生成二维码（首次使用） |
| `-q <uin>`，且 uin 在本机 QQ 的登录记录里 | 快速登录；失败 → 无密码环境变量 → 生成二维码 |
| `-q <uin>`，不在登录记录里 | 无密码环境变量 → 生成二维码 |

`-q` / `--qq` 的解析见 L82438（Worker）与 L82700（主进程转发给 Worker）。

**二维码**（L82121-82131）：每次生成都把 PNG 写到 `<cache>/qrcode.png`（本包即 `napcat/cache/qrcode.png`），同时在控制台打印。过期时 NapCat 自动重新获取并覆盖同一文件（L82141，`ErrType 1 / ErrCode 3`）。
→ 后端 spawn 前删除该文件；文件出现 = `waiting_qr`；前端定时重取即可看到新码。✅ `tools` 运行后该文件存在。

## 5. 登录成功的信号：WS 3001 + lifecycle

- OneBot 网络适配器在**登录成功之后**才打开（L80869 `openAllAdapters()` 在登录成功路径里）→ 3001 可连 ⇔ 已登录。
- WS Server 在客户端连上时立即发 lifecycle `connect`（L64484），事件带 `self_id = selfInfo.uin`（L63819）。
- ✅ `tools/logs/bot-2026-09-26.log`：`已连接 NapCat` 后同一秒收到 lifecycle，`self_id=<机器人QQ号>`。

## 6. Action 走同一条 WS

请求 `{"action": "...", "params": {...}, "echo": "<唯一串>"}`，回包带同一 `echo`，`status ∈ {"ok","async"}` 为成功。✅ `tools/bot.py` `_call_action` 以此调用 `send_group_msg` / `send_private_msg`。
ClassRep 用到：`get_group_list`、`get_group_msg_history`（需求文档 §8 已实测可用）。

## 7. 被挤下线

- 内核回调 `onKickedOffLine` → OneBot 推送 notice `{"post_type":"notice","notice_type":"bot_offline","tag":<标题>,"message":<描述>}`（L80988-80991，事件类 L80726-80734）。
- 同时 core 事件 `KickedOffLine`（L82498-82507）会在 **3.5s 后重启 Worker 并重新登录** —— 会和另一台电脑互踢。
→ 后端收到 `bot_offline` 立即 `taskkill /T /F`，进入 `kicked`，等用户点「重新连接」。

## 8. 仍未验证（必须运行时确认）

1. node 直接 spawn `NapCatWinBootMain.exe`（不经 bat）注入成功；`taskkill /T /F /PID` 能清掉 NapCat + QQ 全部进程；
2. `disableWebUI: true` + 无 `-q`：二维码正常生成（该分支先看快速登录列表，L82332-82337；列表只在分支之后才被填充，L82339-82341，所以启动时为空，应走生成二维码）；
3. `-q <uin>` 免扫码成功；
4. `bot_offline` 在 WS 断开前送达；
5. 中文/空格路径下注入正常；
6. 子进程 stdout 可经管道读取（只影响排错日志）。
