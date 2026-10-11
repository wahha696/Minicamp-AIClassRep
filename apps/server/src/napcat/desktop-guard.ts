import type { MiddlewareHandler } from 'hono';
import { desktopSession } from './desktop-qq.js';
import { db } from '../db/index.js';

function independentWechatOperation(path: string, method: string): boolean {
  if (method !== 'POST') return false;
  if (/^\/api\/connect\/wechat\/messages\/(start|stop|history|issues|retry)$/.test(path)) return true;
  const retry = /^\/api\/groups\/([^/]+)\/retry$/.exec(path);
  if (!retry) return false;
  try { return db.prepare('SELECT adapter FROM groups WHERE group_id=?').get(decodeURIComponent(retry[1]!))?.adapter === 'wechat'; }
  catch { return false; }
}

/** Another tab cannot log out, restart or mutate the paused account mid-handoff. */
export function desktopModeGuard(): MiddlewareHandler {
  return async (c, next) => {
    const read = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const control = c.req.path.startsWith('/api/connect/desktop-qq');
    if (desktopSession.isActive() && !read && !control && !independentWechatOperation(c.req.path, c.req.method) && c.req.path.startsWith('/api/')) {
      return c.json({ error: 'QQ 切换中，请先返回课代表再操作此功能' }, 409);
    }
    return next();
  };
}
