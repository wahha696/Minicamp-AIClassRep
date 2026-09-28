import type { MiddlewareHandler } from 'hono';
import { accountDataState, tryAcquireAccountMutationLease } from './accounts.js';

const ACCOUNT_DATA_PREFIXES = [
  '/api/today',
  '/api/export.ics',
  '/api/events',
  '/api/groups',
  '/api/demo',
  '/api/import',
  '/api/sync',
  '/api/todos',
  '/api/timetable',
  '/api/settings/memory',
  '/api/trash',
  '/api/pet/chat',
] as const;

function isAccountDataPath(path: string): boolean {
  return ACCOUNT_DATA_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * 账号数据请求统一 fail closed：切库中或挂库失败时，读请求也不能看到旧账号数据。
 * 读写都必须携带账号 epoch 并持有共享 lease：旧页面既不能跨号读，也不能迟到写；
 * 切号会等已经放行的请求结束。ICS 这类浏览器直接下载不能加 header，只对 GET/HEAD 接受同值查询参数。
 */
export function accountMutationGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!isAccountDataPath(c.req.path)) return next();
    if (c.req.method === 'OPTIONS') return next();

    const state = accountDataState();
    if (state === 'switching') {
      return c.json({ error: '账号正在切换，请稍后重试' }, 409);
    }
    if (state === 'error') {
      return c.json({ error: '账号数据库挂载失败，请重新连接或重启后重试' }, 503);
    }
    const isRead = c.req.method === 'GET' || c.req.method === 'HEAD';
    const headerEpoch = c.req.header('X-ClassRep-Account-Epoch')?.trim();
    const queryEpoch = isRead && c.req.path.endsWith('/export.ics')
      ? c.req.query('account_epoch')?.trim()
      : undefined;
    const rawEpoch = headerEpoch || queryEpoch;
    if (!rawEpoch) {
      return c.json({ error: '账号上下文已失效，请刷新后重试' }, 409);
    }
    const lease = tryAcquireAccountMutationLease(rawEpoch || undefined);
    if (lease === null) {
      return c.json({ error: '账号已切换或正在切换，请刷新后重试' }, 409);
    }
    try {
      await next();
    } finally {
      lease.release();
    }
  };
}
