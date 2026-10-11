import type { Hono } from 'hono';
import { z } from 'zod';
import { isLocalAddress, remoteAddressOf } from '../lan-guard.js';
import type { WechatIntake } from '../ingest/wechat-intake.js';
import type { WechatCatalog } from '../ingest/wechat-catalog.js';

const epoch = z.string().min(1).max(200), group = z.string().regex(/^[A-Za-z0-9_-]+@chatroom$/);
const base = z.object({ expected_account_epoch: epoch, intake_id: z.uuidv4() });
const start = z.object({ expected_account_epoch: epoch, catalog_id: z.uuidv4(), connection_id: z.uuidv4(),
  group_ids: z.array(group).min(1).max(10000), approve_key_read: z.literal(true),
  approve_message_read: z.literal(true), approve_selected_storage: z.literal(true) }).strict();
const history = base.extend({ group_id: group, days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  approve_history_read: z.literal(true), continue_existing: z.boolean() }).strict();
const retry = base.extend({ group_id: group, event_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100) }).strict();
const issueRequest = base.extend({ group_id: group }).strict();
const messages: Record<string, string> = {
  WECHAT_MESSAGE_NOT_CURRENT: '微信连接或空间已变化，请重新确认所选群后开始读取',
  WECHAT_MESSAGE_SELECTION_REQUIRED: '请先读取群列表并确认要采集的微信群',
  WECHAT_MESSAGE_ALREADY_STARTED: '微信采集正在运行或启动，请稍候',
  WECHAT_MESSAGE_STORAGE_UNAVAILABLE: '本地消息保存目录不可用，原有消息保留，请检查磁盘后重试',
  WECHAT_MESSAGE_LOCAL_RECEIPT_NOT_INITIALIZED: '已保存的微信进度文件缺失，已停止，避免自动跳过消息',
  WECHAT_MESSAGE_LOCAL_RECEIPT_ACTIVATION_MISMATCH: '微信选群状态与进度不一致，已停止，原有消息保留',
  WECHAT_HISTORY_REQUEST_INVALID: '请先结束当前刷新，或重新选择刷新天数',
};
export function registerWechatMessageRoutes(app: Hono, intake: WechatIntake, catalog: WechatCatalog): void {
  app.get('/api/connect/wechat/messages/status', (c) => {
    if (!isLocalAddress(remoteAddressOf(c))) return c.json({ error: '请在本机管理微信消息采集' }, 403);
    return c.json(intake.status());
  });
  for (const action of ['start', 'stop', 'history', 'issues', 'retry'] as const) {
    app.post(`/api/connect/wechat/messages/${action}`, async (c) => {
      if (!isLocalAddress(remoteAddressOf(c))) return c.json({ error: '请在本机管理微信消息采集' }, 403);
      const input: unknown = await c.req.json().catch(() => null);
      try {
        if (action === 'start') {
          const parsed = start.safeParse(input);
          if (!parsed.success) return c.json({ error: '请确认所选群和消息保存说明后再开始采集' }, 400);
          const body = parsed.data, scope = catalog.selectedScope(), offer = catalog.catalog();
          if (!scope || !offer || offer.catalog_id !== body.catalog_id || scope.connectionId !== body.connection_id
              || scope.epoch !== body.expected_account_epoch || scope.groups.length !== body.group_ids.length
              || new Set(body.group_ids).size !== body.group_ids.length
              || scope.groups.some((row) => !body.group_ids.includes(row.group_id))) throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
          await intake.start(body.expected_account_epoch, true, true, true);
        } else if (action === 'stop') {
          const parsed = base.strict().safeParse(input);
          if (!parsed.success) return c.json({ error: '采集状态已变化，请刷新后暂停' }, 400);
          await intake.stop(parsed.data.expected_account_epoch, parsed.data.intake_id);
        } else if (action === 'history') {
          const parsed = history.safeParse(input);
          if (!parsed.success) return c.json({ error: '请选择刷新 1、7 或 30 天，并确认历史整理说明' }, 400);
          const b = parsed.data;
          return c.json(await intake.history(b.expected_account_epoch, b.intake_id, b.group_id, b.days, true, b.continue_existing));
        } else if (action === 'issues') {
          const parsed = issueRequest.safeParse(input);
          if (!parsed.success) return c.json({ error: '请选择当前正在采集的微信群' }, 400);
          return c.json(await intake.issues(parsed.data.expected_account_epoch, parsed.data.intake_id, parsed.data.group_id));
        } else {
          const parsed = retry.safeParse(input);
          if (!parsed.success) return c.json({ error: '请选择需要重试的消息' }, 400);
          const b = parsed.data;
          await intake.retryIssues(b.expected_account_epoch, b.intake_id, b.group_id, b.event_ids);
        }
        return c.json({ ok: true });
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        return c.json({ error: messages[code] ?? '微信消息读取已停止，原有消息和进度保留，请检查连接后重试' }, 409);
      }
    });
  }
}
