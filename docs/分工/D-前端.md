# 分工 D：前端（Web 看板）

> **给 AI 的开场白（复制粘贴）**：
> 你在开发 ClassRep 项目。请先完整阅读 `架构.md`、`需求文档.md`、`docs/分工/00-总约定.md`，然后阅读本文件。我负责「分工 D」。**只修改 `apps/web/` 目录**；后端 API 的格式以 `00-总约定.md` §4、§7 为准，不得擅自修改后端。每次只做我指定的一个任务，做完告诉我怎么验证。

## 我的前提条件

任意电脑，Node ≥ 22.13 + pnpm。等 B 的骨架（M0）合进 main 后开工。**后端没做好之前，用 mock 数据开发（D0），不要等。**

## 我的文件

`apps/web/` 下全部。技术栈：Vite + React + TypeScript + react-router-dom + Tailwind。**不引入组件库、状态管理库、图表库**（保持小白可维护）；可以用 `lucide-react` 图标。

## 设计要求（全局）

- 中文界面，面向大学生，简洁、留白多。首页一眼看出「今天几件事、最急的是什么」。
- 类型配色固定（FR-7.3）：`exam` 红 `#ef4444`、`assignment` 橙 `#f97316`、`meeting` 蓝 `#3b82f6`、`activity` 绿 `#22c55e`、`announcement` 灰 `#6b7280`、`other` 灰 `#9ca3af`。类型中文：考试/作业/会议/活动/通知/其他。
- 时间一律按 Asia/Shanghai 显示（`Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...})`），格式如「今天 14:00」「明天 23:59 截止」「周五 14:00」。
- 手机宽度（375px）下所有页面可用（FR-7.6）。
- **页面上任何地方都不许出现 "NapCat" 这个词**（`架构.md` §0）。用「采集端」「QQ 连接」代替。
- 所有文案直接用 `架构.md` §7 的表格。

## 任务清单（按顺序，一次给 AI 一条）

**D0. API 层 + mock**
- `src/api/types.ts`：从 `00-总约定.md` §4 复制 DTO 类型（前端单独一份，逐字相同）。
- `src/api/client.ts`：每个接口一个函数（`getToday()`、`getEvents(from?,to?)`、`getEvent(id)`、`patchEvent(id,status)`、`getGroups()`、`patchGroup(id,enabled)`、`deleteGroupData(id)`、`getScenarios()`、`replay(name)`、`resetDemo()`、`importText(groupName,text)`、`getConnectStatus()`、`restartConnect()`、`syncNow()`、`getHealth()`）。出错时抛出 `Error(响应里的 error 字段)`。
- `src/api/mock.ts`：`VITE_MOCK=1` 时 client 返回写死的假数据（包含一个有 2 条来源、1 条改期历史的事件）。`pnpm --filter web dev:mock` 启动 mock 模式。
- 通用 hook `usePolling(fn, intervalMs)`。

**D1. 布局 + 路由 + 状态灯**
- 路由：`/` 今日、`/week` 本周、`/groups` 群管理、`/connect` 连接、`/demo` 演示控制台。
- 顶部栏：Logo「AI课代表」、导航、右侧 4 个状态灯（QQ / 数据库 / AI / 快判），每 5s 读 `/health`；`jev='disabled'` 灰色显示「预留」，其余绿/红，悬停显示中文说明。手机上导航收成底部 Tab。
- 右上角头像（全局，`components/Avatar.tsx`）：圆形，显示登录者 QQ 头像（`https://q1.qlogo.cn/g?b=qq&nk=<uin>&s=100`，uin 来自 `/api/connect/status`）；右下角小圆点绿色 = 已连接；没有 uin 或图片加载失败显示灰色人像；点击去 `/connect`。
- 连接黄条（全局）：每 2s 读 `/api/connect/status`：`reconnecting` → "连接中断，重连中"；`kicked` → "你的 QQ 在另一台电脑登录了，采集已暂停" + 「重新连接」按钮（`POST /api/connect/restart`）；`error` → 显示 `message` + 「重启采集端」按钮；`qq_conflict`/`waiting_qr`/`starting` 且不在 `/connect` 页 → "QQ 未连接" + 「去连接」链接。
- 路由守卫：`first_run === true` 时任何页面都跳到 `/connect`。

**D2. 今日页 `/`**（FR-7.1）
- 顶部大字 `summary`，下方按时间排序的事件卡片：左侧类型色条、类型标签、标题、时间（DDL 显示「xx:xx 截止」红字）、地点、群名；`pending_confirm` 显示「待确认」小标签；`done` 置灰划线。
- 每 10s 刷新。右上角「立即同步」按钮（`POST /api/sync`，409 时 toast "QQ 未连接"）和「导出今日到日历」（直接链接 `/api/export.ics?from=&to=`）。
- 空状态：插画式文字「今天没有待办，轻松一天 🎉」+ 引导去演示控制台。
- 点卡片打开详情抽屉（D4）。

**D3. 本周页 `/week`**（FR-7.2）
- 7 列（手机上改为 7 段纵向列表），从今天起 7 天，每列标题「周三 10/1」，今天高亮。
- 每天的事件按时间排；只有 deadline 的事件显示为带「DDL」徽标的条目，和普通事件视觉上一眼能区分。
- 顶部「导出本周」按钮。

**D4. 事件详情抽屉**（FR-8）
- 右侧滑出（手机为底部全屏抽屉），内容：标题、类型、开始/结束/截止时间、地点、要求、置信度（百分比进度条）、来源群、状态。
- 「查看来源」折叠区：`sources` 列表，每条显示发送者、时间、原文；原文中的时间词、地点（如 A203）用黄色背景高亮（简单正则即可）。
- 「变更记录」：`history` 渲染为 `2 版 · 10/1 14:03 · 时间：~~周二 14:00~~ → 周五 14:00；地点：~~A301~~ → A203`（字段名翻译成中文，时间戳格式化；status 翻译为中文）。有变更记录的事件在卡片上也显示「已按最新通知更新」小标签。
- 按钮：「标记完成」「标记取消」「恢复」（`PATCH`）、「导出这一条」（链接 `/api/events/:id/export.ics`）。

**D5. 连接页 `/connect`**（`架构.md` §4、§7）
每 2s 轮询状态，按 `state` 显示：
- `starting`：全屏加载「正在登录 QQ…」
- `waiting_qr`：大图 `<img src={'/api/connect/qrcode?t='+Date.now()}>`（每 2s 换 t）+「用手机 QQ 扫码登录（仅首次需要）」
- `qq_conflict`：「ClassRep 需要接管电脑版 QQ，期间请用手机 QQ 聊天」+ 大按钮「关闭电脑版 QQ 并继续」
- `error`：`message` 文案 + 「重启采集端」+「下载最新版 QQ」链接 `https://im.qq.com/pcqq`
- `online`：**不自动跳走**，显示「✅ QQ 已连接（QQ号），正在接收群消息」+「查看今日日程 →」按钮；若是本机首次看到 online（localStorage 没记过）弹一次提示「电脑版 QQ 已由 ClassRep 接管，聊天请用手机 QQ」
- 页面底部小字链接「没有 QQ？先用演示模式看看 →」跳 `/demo`（此时不再被守卫拦截：点击后 `localStorage.skipConnect=1`，守卫放行）。
- 「AI 接入」卡片（FR-11.6）：服务商下拉（目前只有 DeepSeek）+ API Key 密码框 + 保存；已配置时显示「已接入 · sk-****xxxx」（来自 .env 时注明）+「更换」。

**D6. 群管理页 `/groups`**（FR-10）
表格/卡片列表：群名、消息数、事件数、开关（`PATCH`）、「删除本群数据」（二次确认弹窗，文案「将删除该群的所有消息和日程，无法恢复」）。说明文字：「数据只保存在你的电脑上，原始消息 7 天后自动清理」。
顶部模糊搜索框（FR-10.4，`lib/groups.ts` 的 `filterGroups`），没结果时显示「没有找到和「x」相关的群」。

**D7. 演示控制台 `/demo`**（FR-11）
- 剧本列表（`/api/demo/scenarios`），每个一个「回放」按钮，回放中显示 loading，完成后 toast「已注入 N 条消息」。
- 回放过的剧本（`active: true`）按钮变为红色「取消」（`POST /api/demo/undo`），只删这个剧本的假数据（FR-11.5）。
- 「清空演示数据」按钮（二次确认）。
- 「粘贴聊天记录」：群名输入框 + 大文本框 + 提交。
- 统计卡：累计过滤 `filtered_count` 条、AI 调用 `llm_called_count` 次（读 `/health`，FR-3.2）。

**D8. 打磨（M1 之后）**
- 真后端联调：去掉 mock 跑一遍所有页面。
- 手机浏览器实测（同 WiFi 访问 `http://<电脑IP>:8000`）：局域网写操作会返回 403，此时按钮应 toast「请在电脑上操作」，不要白屏。
- `pnpm --filter web build` 产物在 `apps/web/dist`，由后端 serve。
- 月历视图（P1，FR-7.5，有余力再做）。

## 我不做

原则上不改后端。例外（已在群里同步）：`/api/settings/llm`（`routes/settings.ts`、`llm-settings.ts`）、`/api/demo/undo`、后台模式 `presence.ts`、@ 规则（`onebot.ts`/`history.ts`），以及 `scripts/dev.mjs` 系列开发启动脚本。其他后端问题仍找 B/C。
