// ClassRep 后端入口：启动顺序见 00-总约定 §6。
// 读 .env → openDb() → 建 Hono app → 局域网只读中间件 → 注册路由 → 静态文件
// → 监听（8000 起顺延）→ startScheduler() → startNapcat() → 清理任务 → 打包版才自动开浏览器
import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';
import { db, openDb } from './db/index.js';
import { startNapcat, stopNapcat } from './napcat/index.js';
import { getConnectStatus } from './napcat/state.js';
import { getPipelineStats, startScheduler } from './pipeline/index.js';
import { startCleanupJob } from './jobs/cleanup.js';
import { lanReadOnly } from './lan-guard.js';
import { installCrashHandlers } from './crash-log.js';
import { trustSystemCertificates } from './system-ca.js';
import { registerBusinessRoutes } from './routes/business.js';
import { registerConnectRoutes } from './routes/connect.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerPresence } from './presence.js';
import { DATA_DIR, WEB_DIST } from './paths.js';
import type { HealthDTO } from './types.js';

trustSystemCertificates(); // 杀毒软件拦截 HTTPS 时也能连上 AI（见 system-ca.ts）

const START_PORT = 8000;
const END_PORT = 8010;
const STARTED_AT = Date.now();

// 打包版（前端产物在 ROOT/app/web/dist 下）才自动开浏览器；开发时用 Vite 的 5173
const isPackaged = WEB_DIST.includes(`${join('app', 'web', 'dist')}`);

/** @hono/node-server 会把 Node 的 req/res 挂在 c.env 上（lan-guard 里读 remoteAddress） */
const app = new Hono();

// 局域网只读中间件：非 loopback 且方法不是 GET/HEAD → 403。
// 来源 IP 取不到时按「非本机」处理（宁可只读，也不放行写操作）。
app.use('*', lanReadOnly());

app.get('/health', (c) => {
  let dbState: HealthDTO['db'] = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbState = 'error';
  }
  const stats = getPipelineStats();
  const qq = getConnectStatus().state;
  const body: HealthDTO = {
    status: dbState === 'ok' && qq === 'online' && stats.llm !== 'error' ? 'ok' : 'degraded',
    db: dbState,
    qq,
    llm: stats.llm,
    jev: 'disabled',
    filtered_count: stats.filtered_count,
    llm_called_count: stats.llm_called_count,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
  };
  return c.json(body);
});

registerBusinessRoutes(app);
registerConnectRoutes(app);
registerSettingsRoutes(app);

// 后台模式（scripts/dev.mjs --background 设 AUTO_EXIT=1）：网页全关掉后自动退出
const AUTO_EXIT = process.env.AUTO_EXIT === '1';
if (AUTO_EXIT) registerPresence(app, () => shutdown());

// 00-总约定 §7：错误一律 { error: '中文' }；不存在的接口也不例外（默认是纯文本 404）
app.notFound((c) => c.json({ error: '接口不存在' }, 404));
app.onError((err, c) => {
  console.error(`接口出错 ${c.req.method} ${c.req.path}：${err.message}`);
  return c.json({ error: '服务器内部错误' }, 500);
});

// 静态文件：WEB_DIST 存在才 serve，非 /api、非 /health 的 GET 回落到 index.html
if (existsSync(WEB_DIST)) {
  const INDEX_HTML = join(WEB_DIST, 'index.html');
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const path = c.req.path;
    if (path.startsWith('/api') || path === '/health') return next();
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const file = join(WEB_DIST, rel);
    if (rel !== 'index.html' && !file.startsWith(WEB_DIST)) {
      return c.json({ error: '非法路径' }, 400);
    }
    if (existsSync(file)) {
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
      const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => resolve(true));
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

openDb();

const port = await listenWithFallback();
console.log(`ClassRep 已启动：http://localhost:${port}`);

startScheduler();
startNapcat();
startCleanupJob();

if (isPackaged) {
  // 打包版才自动打开浏览器（架构.md §3）
  exec(`start "" http://localhost:${port}`);
}

let stopping = false;
function shutdown(): void {
  if (stopping) return;
  stopping = true;
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
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows 上直接关掉黑窗口发的是 SIGHUP（架构.md §3 第 7 步）
process.on('SIGHUP', shutdown);

// process.exit() 也会走这里：再兜一次 stopNapcat（可能已经停过了，幂等）
process.on('exit', () => {
  try {
    stopNapcat();
  } catch {
    // 退出路径上不再抛
  }
});
