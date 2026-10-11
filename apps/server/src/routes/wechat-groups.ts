import type { Hono } from 'hono';
import { z } from 'zod';
import { isLocalAddress, remoteAddressOf } from '../lan-guard.js';
import type { WechatCatalog } from '../ingest/wechat-catalog.js';

const request = z.object({ expected_account_epoch: z.string().min(1).max(200),
  data_root: z.string().min(1).max(4096),
  approve_key_read: z.literal(true), approve_contact_read: z.literal(true) }).strict();
const selection = z.object({ expected_account_epoch: z.string().min(1).max(200),
  catalog_id: z.string().uuid(), group_ids: z.array(z.string().regex(/^[\w-]+@chatroom$/)).max(10000) }).strict();
const messages: Record<string, string> = {
  WECHAT_SELECTION_NOT_CURRENT: '空间或微信账号已变化，请重新读取群列表',
  WECHAT_SELECTION_STATE_INVALID: '已保存的微信选群状态异常，未覆盖原数据，请检查本地数据',
  WECHAT_SELECTION_SAVE_FAILED: '选群保存失败，原选择仍保留，请稍后重试',
  WECHAT_CATALOG_NOT_CURRENT: '微信登录或空间已变化，请重新连接后刷新群列表',
  WECHAT_CATALOG_BUSY: '上一次群列表读取尚未结束，请稍后重试',
  WECHAT_GROUP_SELECTION_INVALID: '群列表已变化，请刷新后重新选择',
  WECHAT_CATALOG_METADATA_INVALID: '微信存储目录尚未核实，请重新选择存储位置',
  WECHAT_CATALOG_CONTACT_SCOPE_ACCOUNT_NOT_FOUND: '所选目录下未找到当前微信账号，请核对微信存储位置',
  WECHAT_CATALOG_CONTACT_SCOPE_ACCOUNT_AMBIGUOUS: '同一账号存在多个数据目录，需要核对后再读取',
  WECHAT_CATALOG_SNAPSHOT_LOCK_BUSY: '微信正在整理数据，请稍后刷新群列表',
  WECHAT_CATALOG_TIMEOUT: '读取群列表超时，组件已停止，请稍后重试',
};

/** Contract only, not registered in production. Uses the application's Host/
 * Origin access guard and adds local-only protection for private group lists.
 * File scope is supplied by the owned controller, never account/PID from HTTP.
 */
export function registerWechatGroupRoutes(app: Hono, catalog: WechatCatalog): void {
  app.get('/api/connect/wechat/groups', (c) => {
    if (!isLocalAddress(remoteAddressOf(c))) return c.json({ error: '请在本机查看微信选群列表' }, 403);
    return c.json({ ...catalog.status(), scope: catalog.scope(), catalog: catalog.catalog(), selected_group_ids: catalog.selectedGroupIds() });
  });
  app.post('/api/connect/wechat/groups/refresh', async (c) => {
    if (!isLocalAddress(remoteAddressOf(c))) return c.json({ error: '请在本机选择要读取的微信群' }, 403);
    const parsed = request.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请确认群列表读取说明后重试，不需要填写微信账号' }, 400);
    try {
      const result = await catalog.refresh(parsed.data.expected_account_epoch, true, true, parsed.data.data_root);
      return c.json({ catalog: result, collecting: false });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return c.json({ error: messages[code] ?? '暂时无法读取微信选群列表，请核对电脑微信后重试' }, 409);
    }
  });
  app.post('/api/connect/wechat/groups/selection', async (c) => {
    if (!isLocalAddress(remoteAddressOf(c))) return c.json({ error: '请在本机选择要读取的微信群' }, 403);
    const parsed = selection.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请从当前群列表选择，不需要填写账号或群名' }, 400);
    try {
      const result = await catalog.select(parsed.data.catalog_id, parsed.data.expected_account_epoch, parsed.data.group_ids);
      return c.json({ selected_group_ids: result.groups.map((group) => group.group_id), collecting: false });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return c.json({ error: messages[code] ?? '无法确认所选群，请核对微信连接后重新选择' }, 409);
    }
  });
}
