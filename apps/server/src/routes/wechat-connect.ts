import type { Hono } from 'hono';
import { z } from 'zod';
import { isLocalAddress, remoteAddressOf } from '../lan-guard.js';
import type { WechatConnection } from '../ingest/wechat-connection.js';

const epoch = z.string().min(1).max(200);
const connect = z.object({ expected_account_epoch: epoch, approve_identity_read: z.literal(true) }).strict();
const disconnect = z.object({ expected_account_epoch: epoch, connection_id: z.string().uuid().nullable() }).strict();
const messages: Record<string, string> = {
  WECHAT_CONNECTION_STALE: '连接状态已变化，请刷新后重试',
  WECHAT_WORKSPACE_NOT_READY: '空间尚未就绪，请稍后重试',
  WECHAT_CONNECTION_BUSY: '微信连接正在处理，请稍后重试',
  WECHAT_CONNECTION_ALREADY_OPEN: '微信已经连接，请先断开后再重连',
  WECHAT_NOT_RUNNING: '请先打开并登录电脑微信',
  WECHAT_VERSION_UNSUPPORTED: '当前微信版本尚未通过兼容验证',
  WECHAT_MULTIPLE_CLIENTS: '检测到多个微信实例，请保留要连接的一个后重试',
  WECHAT_RUNTIME_MISSING: '微信组件不完整，请重新安装课代表后重试',
  WECHAT_IDENTITY_LOST: '微信登录状态无法确认，请检查电脑微信后重新连接',
};

/** Not registered in production until consent UI + selected-group intake are ready. */
export function registerWechatConnectionRoutes(app: Hono, connection: WechatConnection): void {
  app.get('/api/connect/wechat/status', (c) => {
    const state = connection.status();
    return c.json(isLocalAddress(remoteAddressOf(c)) ? state : { ...state, connection_id: null, nickname: undefined });
  });
  for (const action of ['connect', 'disconnect'] as const) {
    app.post(`/api/connect/wechat/${action}`, async (c) => {
      if (!isLocalAddress(remoteAddressOf(c))) return c.json({ error: '请在本机管理微信连接' }, 403);
      const input = await c.req.json().catch(() => null);
      const parsed = (action === 'connect' ? connect : disconnect).safeParse(input);
      if (!parsed.success) return c.json({ error: action === 'connect'
        ? '请确认读取说明后重新连接，不需要填写微信账号' : '连接状态已过期，请刷新后重试' }, 400);
      try {
        if (action === 'connect') await connection.connect(parsed.data.expected_account_epoch, true);
        else await connection.disconnect(parsed.data.expected_account_epoch, (parsed.data as z.infer<typeof disconnect>).connection_id);
        return c.json({ ok: true });
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        return c.json({ error: messages[code] ?? '微信暂时无法连接，请检查登录后重试，原有数据保留' }, 409);
      }
    });
  }
}
