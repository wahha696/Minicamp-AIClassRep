# 分工 B：后端骨架 + 数据库 + 业务 API

> **给 AI 的开场白（复制粘贴）**：
> 你在开发 ClassRep 项目。请先完整阅读 `架构.md`、`需求文档.md`、`docs/分工/00-总约定.md`，然后阅读本文件。我负责「分工 B」。**只修改本文件「我的文件」列出的路径**；共享类型、表结构、函数签名、API 格式以 `00-总约定.md` 为准，不得擅自修改。每次只做我指定的一个任务，做完告诉我怎么验证。

## 我的前提条件

任意电脑，装 Node ≥ 22.13（推荐 24）和 pnpm（`npm i -g pnpm`）。**我是第一个开工的人，B0 做完其他三人才开始。**

## 我的文件

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, .env.example, .gitignore（追加）
apps/server/package.json, apps/server/tsconfig.json, apps/server/build.mjs
apps/server/src/index.ts, paths.ts, env.ts, types.ts
apps/server/src/db/
apps/server/src/ingest/index.ts, ingest/demo.ts
apps/server/src/routes/business.ts
apps/server/src/jobs/cleanup.ts
```

## 任务清单（按顺序，一次给 AI 一条）

**B0. 骨架（最高优先级，半天内完成并合进 main）**
1. pnpm workspace：`apps/server`、`apps/web`。根 `package.json` 脚本：
   - `dev`：并行跑 `pnpm --filter server dev`（`tsx watch src/index.ts`）和 `pnpm --filter web dev`（vite，端口 5173，`/api` 和 `/health` 代理到 `http://localhost:8000`）
   - `build`：`pnpm -r build`；`typecheck`：`pnpm -r typecheck`；`test`：`pnpm -r test`；`pack:win`：`node scripts/pack.mjs`
2. 依赖：server 装 `hono @hono/node-server zod openai`，dev 装 `typescript tsx esbuild vitest @types/node`。
3. `apps/web`：`pnpm create vite web --template react-ts`，装 `react-router-dom tailwindcss @tailwindcss/vite`，首页显示「ClassRep」即可（之后归 D）。
4. 仓库根放一个空的 `启动.bat`（内容先抄 `架构.md` §3，之后归 A）——`paths.ts` 靠它找根目录。
5. `.gitignore` 追加 `napcat/`、`data/*`、`!data/mock/`、`release/`、`.env.release`。
6. 按 `00-总约定.md` §3 **建出全部文件**。§4 `types.ts` 逐字照抄。§6 所有函数写成能编译的空实现：
   - `startNapcat/stopNapcat` 空函数；`getConnectStatus` 返回 `{state:'error', since:Date.now(), message:'未实现', first_run:false}`；`callAction` reject；`syncHistory` 返回 `{groups:0,messages:0}`；
   - `startScheduler` 空；`runPipelineNow` 返回 resolved；`getPipelineStats` 返回 `{filtered_count:0,llm_called_count:0,llm:'unconfigured'}`；
   - `registerConnectRoutes` 注册 §7 的 4 个接口返回假数据。
7. `build.mjs`：esbuild 打包 `src/index.ts` → `dist/index.js`，`platform:'node'`，`format:'esm'`，`bundle:true`，`target:'node22'`，加 banner `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`。
8. 验收：`pnpm i && pnpm dev` 打开 `http://localhost:5173` 能看到页面，`curl localhost:8000/health` 有 JSON，`pnpm typecheck` 通过。合进 main，**群里通知大家开工**。

**B1. `paths.ts` + `env.ts` + `db/`**
- `paths.ts` 按 `00-总约定.md` §6。
- `env.ts`：不装 dotenv，自己读 `ROOT/.env` 或 `ROOT/app/.env`（`KEY=VALUE` 逐行，`#` 开头忽略），不覆盖已存在的 `process.env`。导出 `env` 对象含默认值。
- `db/index.ts`：`new DatabaseSync(DATA_DIR/classrep.db)`，执行 `PRAGMA journal_mode=WAL`，执行 `00-总约定.md` §5 全部建表语句。`DATA_DIR` 不存在时创建。
- 验收：vitest 用 `:memory:` 库测建表成功。

**B2. `ingest/index.ts`**
`ingestMessages`、`upsertGroup` 按 `00-总约定.md` §6 的描述。事务包起来。验收：vitest 测「同一条插两次只剩一条」「enabled=0 的群消息被丢弃」「新群自动登记」。

**B3. 事件查询接口**
`/api/today`、`/api/events`、`/api/events/:id`、`PATCH /api/events/:id`。
- 「今天」按 **Asia/Shanghai** 计算：今天 0 点的毫秒 = 用 `Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'})` 取日期字符串，再 `Date.parse(\`${d}T00:00:00+08:00\`)`。
- 排序时间 = `start_at ?? deadline_at`。
- `summary`：`今天 N 件事，最急的是 HH:mm 标题`；最急 = 排序时间 ≥ 现在的第一个，没有则第一个；无事件时 `今天没有待办，轻松一天`。
- `group_name` 通过 join `groups` 表取得。
- 验收：vitest 往库里塞几条事件测返回。

**B4. `.ics` 导出**（不用第三方库，手写）
- `BEGIN:VCALENDAR` / `VERSION:2.0` / `PRODID:-//ClassRep//CN` / 带一段 `VTIMEZONE`（Asia/Shanghai，`TZOFFSETFROM/TO:+0800`，`STANDARD` 从 `19700101T000000`）。
- 每个事件：`UID:classrep-<id>@local`、`DTSTAMP`（UTC）、`SUMMARY:[类型中文]标题`、`LOCATION`、`DESCRIPTION`（description + action_required）。
- 有 `start_at`：`DTSTART;TZID=Asia/Shanghai:yyyymmddThhmmss`，`DTEND` = `end_at ?? start_at+1小时`。
- 只有 `deadline_at`：`DTSTART` = `DTEND` = 截止时刻（`SUMMARY` 前加 `【截止】`）。
- 两者都没有的事件不导出。
- 文本转义 `\\ ; ,` 与换行；行尾 `\r\n`；超过 75 字节折行。
- 响应头 `Content-Type: text/calendar; charset=utf-8`、`Content-Disposition: attachment; filename="classrep.ics"`。
- 验收：导出的文件拖进 macOS 日历/Outlook/手机日历，时间正确。

**B5. 群管理接口**
`GET /api/groups`（带 message_count、event_count）、`PATCH /api/groups/:id`、`DELETE /api/groups/:id/data`（事务里删 event_history → event_sources → events → messages）。

**B6. 演示接口 `ingest/demo.ts`**
- `GET /api/demo/scenarios`：读 `MOCK_DIR/*.json` 返回 name（文件名去扩展名）、title、count。
- `POST /api/demo/replay`：按 `00-总约定.md` §8 转成 `Message[]` → `ingestMessages(msgs,'demo')` → `await runPipelineNow()`。
- `POST /api/demo/reset`：删除 `group_id LIKE 'demo-%'` 的群及其全部数据。
- `POST /api/import/text`：`group_id = 'demo-import-' + 群名`；逐行解析，支持 `昵称：内容`、`昵称: 内容`、`昵称 12:30:45` 下一行是内容（QQ 复制格式）三种；解析不了的行归到上一条；`sent_at` 用当前时间依次 +1 秒。

**B7. `index.ts` 完整版 + `/health` + 访问控制 + 清理任务**
- 启动顺序按 `00-总约定.md` §6。端口从 8000 起，`EADDRINUSE` 则 +1 重试，最多到 8010。
- 静态文件：`WEB_DIST` 存在则 serve，并把非 `/api`、非 `/health` 的 GET 请求回落到 `index.html`（前端路由）。
- 打包版（`WEB_DIST` 在 `app/` 下）才自动打开浏览器：`exec('start "" http://localhost:<port>')`。
- 局域网只读中间件：取 `c.env.incoming.socket.remoteAddress`，不是 `127.0.0.1`/`::1`/`::ffff:127.0.0.1` 且方法不是 GET/HEAD → 403 `{error:'局域网访问只读'}`。
- `/health`：`db` 用 `SELECT 1` 试；`status` = db ok 且 `qq==='online'` 且 `llm!=='error'` 时为 `ok`，否则 `degraded`。
- `jobs/cleanup.ts`：启动时跑一次，之后每小时一次，删 `sent_at < 现在 - RAW_MSG_TTL_DAYS 天` 的 messages（event_sources 里有快照，不受影响）。
- 控制台输出全部用中文、简短，例如 `ClassRep 已启动：http://localhost:8000`。

**B8. 联调 M1**：和 C、D 一起把「回放 → 今日页 → 改期 → 详情 → 导出」走通。

## 我不做

NapCat 相关、LLM 调用与事件合并逻辑、前端页面。
