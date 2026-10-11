import type { Hono } from 'hono';
import { z } from 'zod';
import { isAccountSwitching, resetCurrentWorkspaceData, workspaceRuntime } from '../accounts.js';
import { WorkspaceError } from '../workspaces/registry.js';

const schema = z.object({
  request_id: z.string().uuid(),
  expected_account_epoch: z.string().min(1).max(200),
  choice: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('create'), name: z.string().trim().min(1).max(256) }).strict(),
    z.object({ mode: z.literal('current') }).strict(),
    z.object({ mode: z.literal('known') }).strict(),
  ]),
  confirm_switch: z.boolean(),
}).strict();
const messages: Record<string, string> = {
  WORKSPACE_REQUEST_STALE: '登录状态已发生变化，请刷新后重试',
  WORKSPACE_SINGLE_FIXED: '本机只有一个固定空间，登录后自动接入，无需选择空间',
  WORKSPACE_LOGIN_NOT_VERIFIED: '平台登录已失效，请重新连接后再选择空间',
  WORKSPACE_SWITCH_CONFIRM_REQUIRED: '切换空间会停止原空间的采集，请先确认',
  WORKSPACE_NO_CURRENT: '当前没有可绑定的已登录空间，请新建空间',
  WORKSPACE_PLATFORM_ALREADY_BOUND: '此空间已经绑定该平台的另一个账号，请新建空间',
  WORKSPACE_CHOICE_INVALID: '账号已有归属，请刷新并进入其原空间',
  WORKSPACE_NAME_INVALID: '空间名称为空或过长，请修改后重试',
};
export function registerWorkspaceRoutes(app: Hono, stopWechat?: () => Promise<void>): void {
  app.post('/api/workspaces/reset-data', async (c) => {
    if (!stopWechat) return c.json({ error: '清空功能暂不可用' }, 503);
    if (isAccountSwitching()) return c.json({ error: '空间正在更新，请稍后重试' }, 409);
    const parsed = z.object({ expected_account_epoch: z.string().min(1).max(200),
      confirm: z.literal(true) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请确认清空当前空间的数据' }, 400);
    try {
      await resetCurrentWorkspaceData(parsed.data.expected_account_epoch, stopWechat);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof WorkspaceError && error.message === 'WORKSPACE_REQUEST_STALE') {
        return c.json({ error: messages.WORKSPACE_REQUEST_STALE }, 409);
      }
      return c.json({ error: '清空失败，请检查磁盘空间与权限后重试' }, 503);
    }
  });
  app.patch('/api/workspaces/name', async (c) => {
    const controller = workspaceRuntime();
    if (!controller) return c.json({ error: '空间功能尚未启用' }, 409);
    if (isAccountSwitching()) return c.json({ error: '空间正在更新，请稍后重试' }, 409);
    const parsed = z.object({ name: z.string().trim().min(1).max(256),
      expected_account_epoch: z.string().min(1).max(200) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请填写有效的空间名称' }, 400);
    try {
      await controller.rename(parsed.data.name, parsed.data.expected_account_epoch);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof WorkspaceError && messages[error.message]) return c.json({ error: messages[error.message] }, 409);
      return c.json({ error: '空间名称暂时无法保存，请重试' }, 503);
    }
  });
  // Only selects a destination for a collector-verified pending login.
  // No login-by-account-ID, arbitrary workspace switch, delete or unbind endpoint.
  app.post('/api/workspaces/choice', async (c) => {
    const controller = workspaceRuntime();
    if (!controller) return c.json({ error: '空间功能尚未启用' }, 409);
    if (isAccountSwitching()) return c.json({ error: '空间正在切换，请稍后重试' }, 409);
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '选择信息不完整，请刷新后重试' }, 400);
    try {
      await controller.choose(parsed.data);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof WorkspaceError && messages[error.message]) {
        return c.json({ error: messages[error.message] }, 409);
      }
      return c.json({ error: '空间暂时无法打开，原有数据已保留，请检查磁盘或权限后重试' }, 503);
    }
  });
}
