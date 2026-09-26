# 分工 A：采集端（NapCat）+ 历史补齐 + 打包

> **给 AI 的开场白（复制粘贴）**：
> 你在开发 ClassRep 项目。请先完整阅读 `架构.md`、`NapCat接口规格.md`、`需求文档.md`、`docs/分工/00-总约定.md`，然后阅读本文件。我负责「分工 A」。**只修改本文件「我的文件」列出的路径**；共享类型、表结构、函数签名、API 格式以 `00-总约定.md` 为准，不得擅自修改。每次只做我指定的一个任务，做完告诉我怎么验证。

## 我的前提条件

- 一台 **Windows 10/11** 电脑，已安装 **QQ 电脑版 NT（≥ 9.9.33）**。
- 仓库根目录下有 `napcat/`：把组长电脑上 `tools/napcat/NapCat.Shell/` 的内容复制过来，**删掉** `config/`、`cache/`、`logs/`、`guild1.db`、`loadNapCat.js`、所有 `*.bat`（那是组长的账号数据）。`napcat/` 已在 `.gitignore`，不提交。
- 建议用**备用 QQ 号**开发测试（有被风控的可能）。测试群里要有人能发消息。

## 我的文件

```
启动.bat
scripts/pack.mjs
apps/server/src/napcat/paths.ts     napcat 目录、QQ.exe 定位
apps/server/src/napcat/config.ts    写 onebot11*.json / webui.json / loadNapCat.js
apps/server/src/napcat/manager.ts   冲突检测 / spawn / 监控 / 自动重启 / kill 进程树
apps/server/src/napcat/state.ts     架构.md §4 状态机 → getConnectStatus()
apps/server/src/napcat/onebot.ts    WS 客户端、callAction、事件 → Message → ingestMessages
apps/server/src/napcat/index.ts     startNapcat / stopNapcat
apps/server/src/ingest/history.ts   syncHistory()
apps/server/src/routes/connect.ts   /api/connect/*、/api/sync
```

## 我依赖别人的（M0 骨架里已有空实现，直接调用）

- B：`ingestMessages(msgs, source)`、`upsertGroup(id, name, adapter)`、`db`、`NAPCAT_DIR`、`DATA_DIR`、`ROOT`
- `settings.json`（`data/settings.json`，内容 `{ "uin": "12345" }`）**由我读写**，别人不碰。

## 别人依赖我的

- B 的 `index.ts` 调 `startNapcat()` / `stopNapcat()`；`/health` 调 `getConnectStatus().state`。
- D 的前端轮询 `GET /api/connect/status`，显示 `/api/connect/qrcode`。
- `ConnectStatusDTO.first_run` = 无 `settings.uin` **且** `messages`、`events` 表都为空。

## 任务清单（按顺序，一次给 AI 一条）

**A1. 手工验证（先不写代码，1 小时）**
按 `架构.md` §10 的 6 项待实测，写一个一次性脚本 `scripts/probe-napcat.mjs`（不进产品）：写配置 → spawn → 打印二维码路径 → 连 3001 打印 lifecycle → 调 `get_group_list` 打印 → 回车后 `taskkill /T /F`。把 6 项结论写进 `需求文档.md` §8 表格。**如果某项不成立，停下来告诉全组，先改 `架构.md`。**

**A2. `paths.ts` + `config.ts`**
- `findQQExe(): string | null`：`reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ" /v UninstallString` → 去掉引号 → 取目录 + `QQ.exe` → 存在则返回；否则试 `C:\Program Files\Tencent\QQNT\QQ.exe`；都没有返回 null。
- `writeNapcatConfig()`：严格按 `架构.md` §3 第 2 步与 §4.1 写三类文件（`onebot11.json` + 所有已存在的 `onebot11_*.json`；`webui.json` 只改 `disableWebUI`；`loadNapCat.js` 用 `pathToFileURL`）。
- 验收：vitest 用临时目录测 `writeNapcatConfig`，检查三类文件内容；含中文+空格的路径也测。

**A3. `manager.ts`**
- `isQQRunning()`：`tasklist /FI "IMAGENAME eq QQ.exe" /NH` 输出里含 `QQ.exe`。
- `spawnNapcat(uin?: string)`：删 `cache/qrcode.png` → 按 `NapCat接口规格.md` §1 的代码 spawn → stdout/stderr 追加写 `data/logs/napcat.log`。
- 监控退出：非主动 kill 的退出 → 1s 后自动重新 spawn（带 `-q`）；60s 内退出 ≥ 3 次 → `error`，不再自动重启。
- `killTree()`：`taskkill /T /F /PID <pid>`。
- `clearUin()` + `logoutNapcat()`：退出登录用，删掉 settings.json 后走 `restart()`，因为没有 uin，spawn 不带 `-q`，会出新二维码。onebot 在 online 后调 `get_login_info` 记下昵称（`getSelfNickname()`），state 在 online 时带上 `nickname`。
- `restart()`：`killTree()` → `taskkill /F /IM QQ.exe`（忽略失败）→ 清零崩溃计数 → spawn。
- 进程退出清理：B 的 `index.ts` 在 `SIGINT`/`SIGHUP`/`exit` 调 `stopNapcat()`，我保证 `stopNapcat` 是**同步**的（用 `execFileSync` 调 taskkill），关窗口时也能执行。

**A4. `onebot.ts`**
- 1s 一次尝试 `new WebSocket('ws://127.0.0.1:3001')`；首次 online 后断开则指数退避 2s→4s→…→30s 无限重连。
- 收到 `meta_event` 且 `meta_event_type==='lifecycle'` → `self_id` 写 `settings.uin` → 通知 state 进 `online` → 异步调 `refreshGroups()` 和 `syncHistory()`。
- `post_type` 为 `message` 或 `message_sent`，且 `message_type==='group'` → 转 `Message` → `ingestMessages([m], 'onebot')`。
- **@ 规则（FR-1.6）**：`mentionOf(segments, selfId)` 返回 `none/all/me/other`；**只 @了别人（`other`）的消息直接丢弃不入库**，`history.ts` 用 `isMentionOther` 同样过滤。selfId 未知时按 @我 处理。
- 消息段转文本 `segmentsToText(segments)`：`text`→原文；`at`→`[at]`（`qq==='all'` 也是 `[at]`）；`image`→`[图片]`；`face`/`mface`→`[表情]`；`reply`→空；`json`→`[卡片]`；`forward`→`[转发]`；`file`→`[文件]`；`record`→`[语音]`；`video`→`[视频]`；其他→`[消息]`。**任何异常都 catch，不能让连接断掉。**
- `group_name`：优先用内存里 `get_group_list` 的缓存；没有就用 `String(group_id)`。
- `sender_name`：`sender.card || sender.nickname || '未知'`。
- `notice_type==='bot_offline'` → 立即 `killTree()` → 状态 `kicked`，**不自动重启**。
- `callAction`：`echo = crypto.randomUUID()`，Map 存 resolve，默认 15s 超时；回包 `status` 是 `ok` 或 `async` 算成功，返回 `data`。
- `refreshGroups()`：`get_group_list` → 对每个群 `upsertGroup(String(group_id), group_name, 'onebot')`。
- 验收：vitest 测 `segmentsToText` 和事件 → `Message` 的转换（用假 JSON）；真机上群里发文字/图片/@全体，库里都有记录。

**A5. `state.ts`**
严格按 `架构.md` §4 的表**从上到下**判定，返回 `ConnectStatusDTO`。`error` 的 `message` 用 `架构.md` §7 原文案。非 Windows 按 `00-总约定.md` §6 返回。

**A6. `history.ts` + `routes/connect.ts`**
- `syncHistory()`：对 `groups` 表里 `enabled=1` 且 `adapter='onebot'` 的群，逐个 `get_group_msg_history({ group_id: Number(id), count: 200 })`，只保留 7 天内的，转 `Message` 后 `ingestMessages(msgs, 'history')`。一个群失败不影响其他群。同一时刻只允许一个 sync 在跑（第二次调用直接返回正在跑的那个 Promise）。
- 路由按 `00-总约定.md` §7 实现 4 个接口。`/api/connect/qrcode` 返回文件时加 `Cache-Control: no-store`。

**A7. 真机联调（M2）**
按 `架构.md` §0 的验收标准走一遍：首次扫码 / 第二次免扫码 / QQ 开着时出现冲突按钮 / 另一台电脑登录后变 `kicked` / 关黑窗口后任务管理器里没有残留 QQ.exe。每一条都截图发群里。

**A8. 打包 `scripts/pack.mjs`**（`pnpm pack:win` 调用）
生成 `release/ClassRep/`，再压成 `release/ClassRep.zip`：
```
ClassRep/启动.bat
ClassRep/runtime/node.exe      ← 从 nodejs.org 下载 win-x64 版 node.exe（v24 LTS），缓存到 release/cache/
ClassRep/napcat/               ← 复制仓库根 napcat/，排除 config/ cache/ logs/ guild1.db loadNapCat.js *.bat
ClassRep/app/server/dist/index.js  ← B 的 esbuild 产物
ClassRep/app/web/dist/         ← D 的 vite build 产物
ClassRep/app/.env              ← 复制仓库根 .env.release（组长私下给，不进 git）
ClassRep/data/mock/            ← 仿真剧本
```
验收：在**一台从没装过 Node 的 Windows 电脑**、解压到**含中文和空格的路径**，双击启动能走完 `架构.md` §0。

## 我不做

前端页面、LLM、事件合并、数据库建表、业务 API。遇到需要别人配合的地方，在群里说，不要改别人的文件。
