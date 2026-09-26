// 局域网只读中间件（架构.md D10：本机全权限、局域网只读）。
// 放在单独文件里是为了能直接测：index.ts 有顶层 await 和监听，import 它就会起服务。
import type { Context, MiddlewareHandler } from 'hono';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** @hono/node-server 会把 Node 的 req/res 挂在 c.env 上 */
interface NodeServerEnv {
  incoming?: { socket?: { remoteAddress?: string } };
}

/** 取连接来源 IP；取不到（无 env、无 socket、地址为空）时返回 ''，按非本机处理。 */
export function remoteAddressOf(c: Context): string {
  const nodeEnv = c.env as NodeServerEnv | undefined;
  const raw = nodeEnv?.incoming?.socket?.remoteAddress ?? '';
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

/** 只有 loopback 算本机；空地址不算。 */
export function isLocalAddress(addr: string): boolean {
  return addr !== '' && LOOPBACK.has(addr);
}

/** 非本机的写操作 → 403；GET/HEAD 一律放行。 */
export function lanReadOnly(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && !isLocalAddress(remoteAddressOf(c))) {
      return c.json({ error: '局域网访问只读' }, 403);
    }
    await next();
  };
}
