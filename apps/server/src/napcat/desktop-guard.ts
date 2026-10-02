import type { MiddlewareHandler } from 'hono';
import { desktopSession } from './desktop-qq.js';

/** Another tab cannot log out, restart or mutate the paused account mid-handoff. */
export function desktopModeGuard(): MiddlewareHandler {
  return async (c, next) => {
    const read = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const control = c.req.path.startsWith('/api/connect/desktop-qq') || c.req.path.startsWith('/api/presence');
    if (desktopSession.isActive() && !read && !control && c.req.path.startsWith('/api/')) {
      return c.json({ error: 'ClassRep 已暂停，请先返回 ClassRep' }, 409);
    }
    return next();
  };
}
