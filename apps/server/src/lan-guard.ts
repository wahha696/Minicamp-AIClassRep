// 访问控制中间件（修复计划 S1/S2）。三道闸，按顺序：
//   1. Host 校验（防 DNS rebinding）：只认 localhost / 127.0.0.1 / [::1] / 本机网卡 IP，端口不限。
//   2. 本机请求（loopback）：写操作再校验 Origin（防本机其他网页 CSRF）；Origin 缺省放行
//      （curl、sendBeacon 同源时浏览器会带 Origin，跨站一定带，所以缺省只可能是非浏览器客户端）。
//   3. 局域网请求：只有「局域网只读」开关打开时才可能到这里（关着时服务只监听 127.0.0.1）；
//      必须带有效 token（首次 ?token= 进来写 cookie），只读，且敏感接口（二维码/设置/连接控制）一律 403。
// 放在单独文件里是为了能直接测：index.ts 有顶层 await 和监听，import 它就会起服务。
import { networkInterfaces } from 'node:os';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
export const LAN_COOKIE = 'classrep_lan';

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

/** 本机所有网卡的 IPv4 地址（局域网手机用 http://<这个>:8000 访问） */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/** "host:port" / "[::1]:port" / "host" → 小写主机名（IPv6 保留方括号） */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.lastIndexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

/** 局域网访问里永远不开放的接口：扫码登录、AI Key、连接控制（二维码被别人扫了 = 别人的号登进采集端） */
export function isSensitivePath(path: string): boolean {
  return (
    path.startsWith('/api/connect/qrcode') ||
    path.startsWith('/api/settings/llm') ||
    path.startsWith('/api/settings/ai') ||
    path.startsWith('/api/settings/lan') ||
    path.startsWith('/api/timetable/csu')
  );
}

/** Origin 是否为本应用自己（本机名或本机网卡 IP，端口不限）；'null'（沙箱 iframe、file://）不算 */
export function isAllowedOrigin(origin: string, lanHosts: string[]): boolean {
  let host: string;
  try {
    host = hostnameOf(new URL(origin).host);
  } catch {
    return false;
  }
  return LOCAL_HOSTNAMES.has(host) || lanHosts.includes(host);
}

export interface GuardOptions {
  /** 当前局域网只读开关 + token；返回 null = 局域网关闭 */
  lanToken: () => string | null;
  /** 本机网卡地址（测试注入） */
  lanHosts?: () => string[];
}

/**
 * 访问控制中间件。
 * - 非法 Host → 421（DNS rebinding）
 * - 本机写操作 + 跨站 Origin → 403
 * - 局域网：开关关闭 / token 不对 → 401；写操作 → 403；敏感接口 → 403
 */
export function accessGuard(opts: GuardOptions): MiddlewareHandler {
  const lanHosts = opts.lanHosts ?? lanAddresses;
  return async (c, next) => {
    const method = c.req.method;
    const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const local = isLocalAddress(remoteAddressOf(c));

    // 1) Host 校验。测试（app.request）里没有 Host 头时按 localhost 处理
    const host = hostnameOf(c.req.header('host') ?? 'localhost');
    const hostOk = LOCAL_HOSTNAMES.has(host) || lanHosts().includes(host);
    if (!hostOk) return c.json({ error: '非法访问地址' }, 421);

    if (local) {
      // 2) 本机：写操作校验 Origin（缺省 = 非浏览器客户端，放行）
      if (isWrite) {
        const origin = c.req.header('origin');
        if (origin !== undefined && !isAllowedOrigin(origin, lanHosts())) {
          return c.json({ error: '拒绝跨站请求' }, 403);
        }
        // S2：写接口必须 JSON。表单的 Content-Type 变不成 application/json，
        // 这一条把「不带 Origin 的 HTML 表单简单请求 CSRF」也挡掉
        const ct = c.req.header('content-type') ?? '';
        if (!ct.includes('application/json')) {
          return c.json({ error: '写请求需要 JSON' }, 415);
        }
      }
      await next();
      return;
    }

    // 3) 局域网
    const token = opts.lanToken();
    if (token === null) return c.json({ error: '未开启局域网访问' }, 403);
    const q = c.req.query('token');
    if (q !== undefined && q === token) {
      // 首次带 ?token= 进来：写 cookie，之后页面里的 fetch 自动带上
      setCookie(c, LAN_COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 365 });
    } else if (getCookie(c, LAN_COOKIE) !== token) {
      return c.json({ error: '需要电脑上「设置 → 手机访问」里的链接才能打开' }, 401);
    }
    if (isWrite) return c.json({ error: '局域网访问只读' }, 403);
    if (isSensitivePath(c.req.path)) return c.json({ error: '该内容只能在电脑上查看' }, 403);
    await next();
  };
}

/** 兼容旧名：只读 + 无 token（仅测试和极简场景用） */
export function lanReadOnly(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD' && !isLocalAddress(remoteAddressOf(c))) {
      return c.json({ error: '局域网访问只读' }, 403);
    }
    await next();
  };
}
