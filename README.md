# AI 课代表（ClassRep）

> **把 QQ 群里的作业、考试、开会、活动和 DDL，自动整理成「今天要干什么」。**
>
> MiniCamp 黑客松参赛项目 · 程序、数据库、凭证全部在你自己的电脑上 · 只有群消息文本会发给你自己配置的 AI 服务（DeepSeek / Jev）用于提取日程

大学生的通知几乎都发在 QQ 群里，却淹没在每天几百条「收到」「哈哈哈」里；更要命的是通知经常**改时间、改地点、取消**，看漏一条就白跑一趟。

AI 课代表在本机接管电脑版 QQ，实时读取你开启监听的群，用 AI 把消息变成结构化的日程：**改期会更新原来那条，不会多出一条；取消会标记取消；每条日程都能追溯到原始群消息。**

---

## ✨ 功能一览

| 页面 | 能做什么 |
|---|---|
| **今日** | 顶部一句话摘要；今天的事件按时间 / 紧急程度排序；右侧待办框（群待办 + 手动待办，超过 8 条自动折叠）；「接下来 3 天」预览 |
| **本周** | 周历视图，两种形态可切换，同一节次的事件折叠成一张卡；课表叠加显示 |
| **事件详情** | 时间、地点、要求、危机等级；「查看来源」高亮 AI 判定所依据的原始群消息；改期前后对比 |
| **群管理** | 每个群单独开关监听，正在监听的群排在前面 |
| **设置** | 课表导入（Excel / 网页 / **中南教务系统一键导入**）、长期记忆偏好、回收站（误取消、改期前的旧安排一键恢复）、数据清理 |
| **导出日历** | 一键导出 `.ics`，导入手机日历 |
| **桌宠** | 页面上的小助手，可以对话问日程，只在页面空白处活动 |

其他亮点：

- 🧠 **双层 AI 流水线**：规则过滤 → Jev 快判（毫秒级判断「值不值得处理」）→ LLM 提取事件 → 事件状态机合并（新建 / 改期 / 取消）
- � **拿不准不乱改**：置信度不够的取消/改期不会直接覆盖原安排，先挂起为「待确认」，群里原话留作证据；取消/改期前的旧版本进回收站可一键恢复
- �🚦 **危机等级 1~4**：24 小时内要交的、考试、计分作业自动往前排
- 🔒 **隐私**：采集端、数据库、网页、API Key 都在本机（Windows 下 Key 用 DPAPI 加密存盘）；AI 提取只把群消息文本发给你自己填 Key 的服务商。已处理原始消息 7 天后自动清理（未处理的最多保留 45 天兜底）；已并入事件的来源消息在事件详情里留快照，随事件删除
- 📱 同一 WiFi 下手机访问 `http://<电脑IP>:8000` 也能看（只读）

---

## 🚀 快速开始（用户）

两种安装方式，选一种：

### 方式一：免安装包（推荐普通用户）

1. 从 [Releases](https://github.com/wahha696/Minicamp-AIClassRep/releases) 下载 `ClassRep.zip`，解压到任意目录（路径可以有中文和空格）
2. 双击 `启动.bat`
3. 浏览器自动打开**向导页**：填 DeepSeek API Key（必填）；快判走内置本地模型，无需配置
4. 用手机 QQ 扫页面上的二维码登录，新发现的群默认不监听，到「群管理」里挑要看的群打开

免安装包已内置 Node 运行时与 NapCat 采集端，解压即用不用下载。有新版本时后端会自动下载并校验 SHA-256，下次双击 `启动.bat` 时自动应用，数据不受影响。

### 方式二：克隆仓库（会用 git/命令行的同学）

```bash
git clone https://github.com/wahha696/Minicamp-AIClassRep.git
cd ClassRep
```

Windows 双击 `启动.bat` 即可：它会自动准备便携版 Node（没有就下载完整运行包到 `runtime\`）→ corepack 装 pnpm（corepack 不可用时自动下载 pnpm）→ `pnpm install` 装依赖 → 增量构建前端 → 启动并打开浏览器。NapCat 采集端已随仓库附带。命令行等价物：`pnpm start`（= `node scripts/bootstrap.mjs`，幂等，重复跑就是重启）。之后和方式一一样走向导页 → 扫码。

**日常使用**：双击 `启动.bat`，自动快速登录，不用再扫码。
**退出**：关掉 `启动.bat` 的黑窗口。
**换号**：连接页「退出登录」→ 扫另一个号 → 只看到新号的数据；换回旧号，旧数据原样回来。**每个 QQ 号一个独立数据库**（`data/accounts/<QQ号>/`），换号登录互不可见；升级前旧数据会自动迁移，账号数据也可以在连接页「本机账号数据」里删除。

> 需要 **Windows 10 1803+**，电脑已安装 **QQ 电脑版（QQ NT ≥ 9.9.33）**。运行期间电脑版 QQ 由 ClassRep 占用，聊天请用手机 QQ。
> 如果启动时电脑版 QQ 正开着，页面上会提示「关闭电脑版 QQ 并继续」，点一下即可。
> 不需要装 Node、pnpm、Git、数据库，不弹 UAC。API Key 在网页向导里填，不碰 `.env`。

### Linux / NAS：Docker Compose（采集端跑在别的机器）

Windows 之外可以用 Docker 跑后端，QQ/NapCat 放在单独容器或另一台 Windows 电脑上：

```bash
cd deploy
docker compose up -d --build   # 打开 http://localhost:8000 ；NapCat WebUI 在 :6099 扫码
```

通过 `ONEBOT_WS_URL` 环境变量把后端指向外部 NapCat 的 OneBot WebSocket（默认 `ws://napcat:3001`），详见 `deploy/`。

---

## 🧰 故障排查

| 现象 | 处理 |
|---|---|
| 双击 `启动.bat` 闪退 / 黑窗口报「Node 下载失败」 | 看窗口里的提示：`setx NODE_MIRROR "https://npmmirror.com/mirrors/node"` 后重试，或手动下载 node.exe 放到 `runtime
ode.exe` |
| 连接页提示「采集端组件缺失」 | 点页面上的「一键下载 NapCat 组件」（自动下载官方 Release 并校验 SHA-256）；或手动把 NapCat.Shell 解压进 `napcat/` |
| 提示「需要先安装 QQ 电脑版」 | 安装 QQ NT ≥ 9.9.33；免安装包不内置 QQ，也不会帮你装 |
| 登录后一直「连接中断，重连中」 | 查 `data/logs/napcat.log`；QQ 版本过旧会被 NapCat 拒绝，更新 QQ |
| 端口被占用 | 自动从 8000 顺延到 8010；全被占会报错，关掉占端口的程序 |
| 升级后提示「检测到旧版本数据」 | 旧单库被迁到 `data/accounts/legacy/`，改名为对应 QQ 号文件夹即可找回 |
| AI 不整理日程 | 向导页 / 连接页「AI 接入」卡填 DeepSeek Key（只存本机 `data/llm.json`，Windows 下用 DPAPI 加密），或 `.env` 里配 `LLM_API_KEY` |
| 网页打不开 | 看 `data/logs/server.log` 与 `background.log`；`http://localhost:8000/health` 看健康状态 |

日志都在 `data/logs/`（`server.log`、`background.log`、`napcat.log`、`fetch-napcat-progress.json`）。健康检查：`http://localhost:8000/health`。

---

## 🛠 本地开发

**环境**：Windows 10/11 · Node.js ≥ 22.13（自带 `node:sqlite`）· pnpm（没有也行，`pnpm start` 会用 corepack 自动装）· QQ NT

```bash
pnpm install
cp .env.example .env        # 填上 LLM_API_KEY / TYPESAFE_API_KEY（.env 不要提交！）
# 缺 NapCat 运行包时：node scripts/fetch-napcat.mjs 自动下载（版本钉在 napcat.version.json）

pnpm start                  # 克隆即用链路：装依赖 → 补 NapCat → 增量构建前端 → 启动并打开浏览器（幂等）
pnpm dev:start              # 开发启动：先 git pull 更新 main → 结束旧后端 → 增量构建 → 启动
pnpm shortcut               # 生成桌面快捷方式（后台模式，网页全关后自动退出）
```

常用命令：

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 前后端热更新开发（前端 Vite，后端 tsx watch） |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test` | 全仓测试（Vitest） |
| `pnpm build` | 构建前后端 |
| `pnpm pack:win` | 打 Windows 发布包 → `release/ClassRep.zip` |
| `node scripts/bootstrap.mjs` | 五步自检启动（= 双击 启动.bat；`--background` 后台模式） |
| `node scripts/dev.mjs` | 开发链路启动（含 git 拉最新 main；桌面快捷方式走这个） |

`.env` 主要配置（见 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容协议的大模型（默认 DeepSeek） |
| `ENABLE_JEV` / `TYPESAFE_API_KEY` / `JEV_MODEL` | Jev 快判层；请求失败会自动回退到 LLM |
| `DEMO_MODE` | `true` 时允许演示控制台重置数据 |
| `RAW_MSG_TTL_DAYS` | 原始消息保留天数，默认 7 |
| `ONEBOT_WS_URL` | OneBot WebSocket 地址；Docker/远程 NapCat 部署时设置（默认 `ws://127.0.0.1:3001`） |
| `NAPCAT_MIRROR` / `NODE_MIRROR` | 组件下载镜像（GitHub / nodejs.org 被墙时） |

---

## 🏗 架构

```
用户电脑（全部本机，普通用户权限）
┌────────────────────────────────────────────────────────────────────┐
│ 启动.bat（自适应：免安装包直跑 / 克隆版自检安装）                       │
│   ├─ HTTP :8000（被占用自动顺延）  网页 + /api                        │
│   ├─ NapCatManager   写配置 / 冲突检测 / 拉起 / 监控 / 重启            │
│   ├─ OneBotClient    WS → ws://127.0.0.1:3001（Docker 可指远程）      │
│   ├─ pipeline        规则过滤 → Jev 快判 → LLM 提取 → Reconcile       │
│   └─ SQLite          按账号分库 data/accounts/<QQ号>/classrep.db      │
└────────────────────────────────────────────────────────────────────┘
```

**技术栈**：TypeScript · Hono（后端）· React + Vite + Tailwind（前端）· node:sqlite · Zod · OpenAI SDK · NapCat（OneBot 11）· Vitest

```
apps/
  server/    后端：采集、AI 流水线、业务 API、课表/教务导入
  web/       前端：今日 / 本周 / 群管理 / 设置 / 连接 / 演示控制台
shared/      前后端共享类型
scripts/     启动链路（bootstrap/dev + lib/*）、打包、自更新、NapCat 下载
deploy/      Docker Compose 部署模板（Linux/NAS，外接 NapCat）
docs/        分工文档与拓展计划
.github/     CI（typecheck + test + build + 全新克隆冒烟）与 Release 流水线
```

详细设计见 [`架构.md`](./架构.md)（最高准则：能实现的前提下，用户操作最少）、需求见 [`需求文档.md`](./需求文档.md)、NapCat 接口证据见 [`NapCat接口规格.md`](./NapCat接口规格.md)。


---

## 👥 团队分工

| 角色 | 负责 |
|---|---|
| A | 采集端（NapCat 托管）与 Windows 打包 |
| B | 后端骨架与业务 API |
| C | AI 流水线（过滤 / Jev / LLM 提取 / 事件合并） |
| D | 前端 |

技术选型与接口约定见 [`docs/分工/00-总约定.md`](./docs/分工/00-总约定.md)。

---

## ⚠️ 说明

- 只支持 **QQ 电脑版** 场景；本项目为单用户本机 Demo，无注册登录、无云端后端。
- 请勿提交 `.env`、`data/` 下的任何数据或 API Key。
- NapCat 为第三方开源项目，本仓库不包含其运行包及任何账号数据；组件下载走官方 GitHub Release（版本与 SHA-256 钉在 `napcat.version.json`）。
- 自更新只覆盖程序文件（`app/`、`runtime/`、`napcat/`、`启动.bat`），`data/`（账号数据库、API Key、配置）永不覆盖。
- 更新切换前会在 `data/update/` 保存恢复记录、程序备份和独立恢复入口。切换失败会恢复旧版；进程中断后，下次启动先恢复再运行。若恢复失败，保留备份并停止启动，请关闭其他 ClassRep 进程后重试，不要删除 `data/update/`。
- 更新恢复修复随新安装包提供；旧安装包的首次升级仍由旧更新器执行。验证更新故障和 Windows 启动恢复可运行 `node --test scripts/update.test.mjs`。

### 历史补拉能做到什么程度（如实说明）

「补回 1 / 7 / 30 天」拿的是 **QQ 服务器漫游 + 本机消息库**，不是无限的：

- QQ 几天没开再打开项目：漫游保留期内的消息能正常补回（普通 QQ 号约 7 天，会员/SVIP 更长，实测 13 天），不需要先在手机上打开 QQ。
- 超过漫游保留期的历史：服务器已删除，**任何方式都拉不回**。兜底办法是「在群里发一条合并转发的聊天记录」，系统会自动把转发里的每条消息展开入库——手机上留多久就能补多久。
- 群精华消息不受漫游窗口限制，每次同步会顺带拉一遍。
- 单个群补没补全、补到了哪天，会在同步结果里如实报告（`GET /api/sync/status`），没补全的群前端会提示，可再点一次补拉重试。
