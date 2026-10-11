// ClassRep 后端入口：启动顺序见 00-总约定 §6。
// 读 .env → openDb() → 建 Hono app → 局域网只读中间件 → 注册路由 → 静态文件
// → 监听（8000 起顺延）→ startScheduler() → startNapcat() → 清理任务 → 打包版才自动开浏览器
import { exec } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, statSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';
import { db, onAccountSwitch } from './db/index.js';
import { accountDataState, accountEpoch, initAccounts, workspaceRuntime, waitForAccountTransitions, waitForMutationLeases, startAutomaticBackupScheduler } from './accounts.js';

import { startNapcat, stopNapcat } from './napcat/index.js';
import { getConnectStatus } from './napcat/state.js';
import { getPipelineStats, startScheduler } from './pipeline/index.js';
import { getDualScoreLog } from './pipeline/jev.js';
import { ensureFastjudgeRuntime, getFastjudgeRoot, localJevAvailable, stopLocalWorker } from './pipeline/jev-local.js';
import { startCleanupJob, pauseCleanup } from './jobs/cleanup.js';
import { accessGuard } from './lan-guard.js';
import { currentLanToken, lanEnabledAtBoot } from './lan-settings.js';
import { accountMutationGuard } from './account-request-guard.js';
import { installCrashHandlers } from './crash-log.js';
import { trustSystemCertificates } from './system-ca.js';
import { registerBusinessRoutes } from './routes/business.js';
import { registerConnectRoutes } from './routes/connect.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerPetChatRoutes } from './routes/pet-chat.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTimetableRoutes } from './routes/timetable.js';
import { registerTodoRoutes } from './routes/todos.js';
import { registerTrashRoutes } from './routes/trash.js';
import { registerDataRoutes } from './routes/data.js';
import { redactSensitive } from './redact.js';
import { registerReminderRoutes } from './routes/reminders.js';
import { quiesceScheduler } from './pipeline/scheduler.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerWechatConnectionRoutes } from './routes/wechat-connect.js';
import { registerWechatGroupRoutes } from './routes/wechat-groups.js';
import { registerWechatMessageRoutes } from './routes/wechat-messages.js';
import { WechatPreparation } from './ingest/wechat-preparation.js';
import { wechatCapability } from './ingest/wechat-python.js';
import { getOnebotFacts, resetAfterRestart, stopOnebotClient } from './napcat/onebot.js';

import { startUpdateChecker } from './update-check.js';
import { DATA_DIR, ROOT, WEB_DIST } from './paths.js';
import { desktopSession } from './napcat/desktop-qq.js';
import { desktopModeGuard } from './napcat/desktop-guard.js';
import type { HealthDTO } from './types.js';
import type { Server } from 'node:http';

let httpServer: Server | undefined;

trustSystemCertificates(); // 杀毒软件拦截 HTTPS 时也能连上 AI（见 system-ca.ts）

const START_PORT = 8000;
const END_PORT = 8010;
const STARTED_AT = Date.now();
const LAUNCH_ID = process.env.CLASSREP_LAUNCH_ID || randomUUID();
const INSTALLATION_ID = createHash('sha256').update(realpathSync(ROOT).toLowerCase()).digest('hex');
let stopping = false;

// 启动.bat（launcher.mjs 设 CLASSREP_OPEN_BROWSER=1）才自动开浏览器；pnpm dev 时用 Vite 的 5173，不开
const openBrowserOnStart = process.env.CLASSREP_OPEN_BROWSER === '1';

/** @hono/node-server 会把 Node 的 req/res 挂在 c.env 上（lan-guard 里读 remoteAddress） */
const app = new Hono();
// All coordinators are inert: user consent/actions are required before any
// WeChat discovery, identity, contact, key or message read is started.
const wechat = new WechatPreparation({ root: ROOT, epoch: accountEpoch, workspace: workspaceRuntime,
  stopWechatIntake: () => {}, settled: waitForAccountTransitions });
onAccountSwitch(() => wechat.workspaceChanged());

// 局域网只读中间件：非 loopback 且方法不是 GET/HEAD → 403。
// 来源 IP 取不到时按「非本机」处理（宁可只读，也不放行写操作）。
app.use('*', async (c, next) => stopping ? c.json({ error: '课代表正在退出，请稍候重新启动' }, 503) : next());
app.use('*', accessGuard({ lanToken: currentLanToken }));
app.use('*', accountMutationGuard());
app.use('*', desktopModeGuard());

app.get('/health', (c) => {
  const accountReady = accountDataState() === 'ready';
  let dbState: HealthDTO['db'] = 'ok';
  let pending = 0;
  try {
    if (!accountReady) throw new Error('account database unavailable');
    db.prepare('SELECT 1').get();
    // 待整理 = 未处理且未被过滤的消息，只算启用的群（群行不存在按启用算）
    pending = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m
             LEFT JOIN groups g ON g.group_id = m.group_id
            WHERE m.processed = 0 AND m.filtered_out = 0 AND COALESCE(g.enabled, 1) = 1`,
        )
        .get() as { n: number }
    ).n;
  } catch {
    dbState = 'error';
  }
  // 恢复入口无需 epoch，但切换/挂库失败时绝不能从仍挂着的旧账号库或内存统计泄露聚合信息。
  const stats = getPipelineStats(accountReady);
  const qq = getConnectStatus().state;
  const wechatState = wechat.intake.status().state;
  const body: HealthDTO = {
    status: dbState === 'ok' && (qq === 'online' || wechatState === 'collecting') && stats.llm !== 'error' ? 'ok' : 'degraded',
    wechat: wechatState,
    db: dbState,
    qq,
    llm: stats.llm,
    jev: stats.jev,
    jev_mode: stats.jev_mode,
    jev_route: stats.jev_route,
    jev_local: stats.jev_local,
    filtered_count: stats.filtered_count,
    jev_filtered_count: stats.jev_filtered_count,
    jev_called_count: stats.jev_called_count,
    llm_called_count: stats.llm_called_count,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    pending,
  };
  // DEMO + 账号就绪时附带 dual 批摘要（无原文）；非 DEMO / 未就绪不暴露
  if (env.DEMO_MODE && accountReady) {
    body.dual_score_log = getDualScoreLog(10);
  }
  return c.json({ ...body, app: 'classrep', launch_id: LAUNCH_ID, installation_id: INSTALLATION_ID, demo_available: env.DEMO_MODE });
});

registerBusinessRoutes(app, { setWechatGroupEnabled: (id, enabled) => wechat.setGroupEnabled(id, enabled),
  wechatCollectingGroupIds: () => wechat.collectingGroupIds() });
registerConnectRoutes(app, { wechatState: () => wechat.intake.status().state });
registerWorkspaceRoutes(app, async () => { wechat.invalidate(); await wechat.intake.stop(); });
registerWechatConnectionRoutes(app, wechat.connection);
registerWechatGroupRoutes(app, wechat.catalog);
registerWechatMessageRoutes(app, wechat.intake, wechat.catalog);
// 局域网只读开关：启动时读一次决定监听地址；默认只监听本机
const LISTEN_LAN = lanEnabledAtBoot();
let listenPort = START_PORT;
registerSetupRoutes(app);
registerSettingsRoutes(app, { listening: LISTEN_LAN, port: () => listenPort });
registerReminderRoutes(app);
registerPetChatRoutes(app);
registerTodoRoutes(app);
registerTimetableRoutes(app);
registerMemoryRoutes(app);
registerTrashRoutes(app);
registerDataRoutes(app, async () => { await wechat.catalog.stop(); await wechat.intake.stop(); });

// 运行期 = 启动窗口：关闭命令窗口或 Ctrl+C 即退出（SIGINT/SIGHUP → shutdown），关网页不影响。

// 00-总约定 §7：错误一律 { error: '中文' }；不存在的接口也不例外（默认是纯文本 404）
app.notFound((c) => c.json({ error: '接口不存在' }, 404));
app.onError((err, c) => {
  console.error(`接口出错 ${c.req.method} ${c.req.path}：${redactSensitive(err)}`);
  return c.json({ error: '服务器内部错误' }, 500);
});

// 静态文件：WEB_DIST 存在才 serve，非 /api、非 /health 的 GET 回落到 index.html
if (existsSync(WEB_DIST)) {
  const INDEX_HTML = join(WEB_DIST, 'index.html');
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const path = c.req.path;
    if (path.startsWith('/api') || path === '/health') return next();
    let rel: string;
    try {
      rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    } catch {
      return c.json({ error: '非法路径' }, 400); // 畸形 % 编码
    }
    const file = join(WEB_DIST, rel);
    const r = relative(WEB_DIST, file);
    if (r.startsWith('..') || isAbsolute(r)) {
      return c.json({ error: '非法路径' }, 400);
    }
    if (existsSync(file) && statSync(file).isFile()) {
      const type = mimeOf(file);
      const body = await readFile(file);
      return c.body(body, 200, { 'Content-Type': type });
    }
    const html = await readFile(INDEX_HTML);
    return c.body(html, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function mimeOf(file: string): string {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME[file.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/** 端口从 8000 起，EADDRINUSE 则 +1 重试，最多到 8010 */
async function listenWithFallback(): Promise<number> {
  for (let port = START_PORT; port <= END_PORT; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = serve({ fetch: app.fetch, port, hostname: LISTEN_LAN ? '0.0.0.0' : '127.0.0.1' }, () => {
        httpServer = server as Server;
        resolve(true);
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`端口 ${port} 被占用，换 ${port + 1} 试试`);
        } else {
          console.error(`监听 ${port} 失败：${err.message}`);
        }
        resolve(false);
      });
    });
    if (ok) return port;
  }
  throw new Error(`端口 ${START_PORT}~${END_PORT} 都被占用了`);
}

// 未捕获异常：中文打印 + 追加写日志，进程不退出（演示时不能因为一条坏消息就整个挂掉）。
// 放在 openDb() 之前：启动阶段（建库、建目录）出问题也要能记下来。防 EPIPE 死循环 / 日志上限见 crash-log.ts
installCrashHandlers(join(DATA_DIR, 'logs', 'server.log'));

// 空间登记与安全兜底启动。记住的 QQ 只用于重连，已验证 lifecycle 才能开放其空间。
await initAccounts({ workspace: {
  wechatCapability: () => wechatCapability(ROOT),
  verifyIdentity: (identity) => {
    if (identity.platform === 'wechat') return wechat.connection.verifies(identity.account_id);
    const facts = getOnebotFacts();
    return facts.wsConnected && !facts.kicked && facts.selfId === identity.account_id;
  },
  revalidateIdentity: (identity) => identity.platform === 'wechat'
    ? wechat.connection.revalidate(identity.account_id) : Promise.resolve(true),
  stopCollectors: () => { stopOnebotClient(); wechat.invalidate(); },
  restartCollectors: resetAfterRestart,
} });
startAutomaticBackupScheduler();


const port = await listenWithFallback();
listenPort = port;
console.log(`ClassRep 已启动：http://localhost:${port}${LISTEN_LAN ? '（已开启局域网只读访问）' : ''}`);
if (env.FASTJUDGE_MODE !== 'jev') {
  const fjRoot = getFastjudgeRoot();
  console.log(`本地快判：${!fjRoot
    ? '未配置（把 classrep-fastjudge 放到项目根目录即自动启用）'
    : localJevAvailable() ? `就绪（${fjRoot}）` : `已找到 ${fjRoot}，但模型文件缺失`}`);
  ensureFastjudgeRuntime(); // 模型在、python 环境缺时后台供给（克隆版开箱即用）
}

startScheduler();
await startNapcat();
startCleanupJob();

if (openBrowserOnStart && process.platform === 'win32') {
  // 用实际监听的端口（8000 被占会顺延），架构.md §3
  exec(`start "" http://localhost:${port}`);
  // 打包版后台检查新版本：下载到 data/update/pending.json，下次启动由 启动.bat + app/update.mjs 应用
  startUpdateChecker();
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  desktopSession.dispose();
  stopOnebotClient();
  try { await wechat.stop(); } catch { /* Still release the other local services. */ }
  await waitForAccountTransitions();
  await quiesceScheduler(); // Let already-running AI batches commit before closing their database.
  await waitForMutationLeases(); // Accepted business requests may still be completing an import/sync.
  if (httpServer) {
    const server = httpServer;
    httpServer = undefined;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }
  pauseCleanup();
  try {
    stopLocalWorker(); // R1：常驻快判子进程随主进程回收
  } catch {
    // 退出路径上不再抛
  }
  try {
    stopNapcat();
  } catch {
    // 退出路径上不再抛
  }
  try {
    db.close();
  } catch {
    // 同上
  }
  console.log('ClassRep 已退出');
  await new Promise<void>(resolve => setImmediate(resolve));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows 上直接关掉黑窗口发的是 SIGHUP（架构.md §3 第 7 步）
process.on('SIGHUP', shutdown);

// process.exit() 也会走这里：再兜一次 stopNapcat（可能已经停过了，幂等）
process.on('exit', () => {
  void wechat.stop(); // Kill owned children synchronously; exit cannot await reaping.
  try {
    stopNapcat();
  } catch {
    // 退出路径上不再抛
  }
});
