import type { Hono } from 'hono';
import { z } from 'zod';
import { isLocalAddress, remoteAddressOf } from '../lan-guard.js';
import { HistoryJobs } from '../ingest/history-jobs.js';
import type { WechatIntake } from '../ingest/wechat-intake.js';

const epoch = z.string().min(1).max(200);
const create = z.object({ platform: z.enum(['qq', 'wechat']), days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
  expected_account_epoch: epoch, group_ids: z.array(z.string().min(1).max(200)).min(1).max(10000).optional(),
  intake_id: z.uuidv4().optional(), approve_history_read: z.literal(true).optional() }).strict();
const mutation = z.object({ expected_account_epoch: epoch, intake_id: z.uuidv4().optional() }).strict();
const messages: Record<string, string> = {
  HISTORY_SCOPE_CHANGED: '账号、空间或选群已变化；已保存进度保留，请刷新连接状态',
  HISTORY_QQ_OFFLINE: 'QQ 未连接，请连接后继续',
  HISTORY_WECHAT_UNAVAILABLE: '请先开启微信所选群采集，再继续历史任务',
  HISTORY_NO_GROUPS: '请先选择需要读取的群',
  HISTORY_CONSENT_REQUIRED: '请确认微信历史读取说明',
  HISTORY_NOT_FOUND: '当前空间中没有这项历史任务',
};
export function registerHistoryJobRoutes(app: Hono, intake: WechatIntake, suppliedJobs?: HistoryJobs): HistoryJobs {
  const jobs = suppliedJobs ?? new HistoryJobs(intake);
  if (!suppliedJobs) jobs.coordinateQQ();
  app.use('/api/history-jobs/*', async (c, next) => {
    if (!isLocalAddress(remoteAddressOf(c))) return c.json({ error: '请在本机管理历史读取任务' }, 403);
    await next();
  });
  app.get('/api/history-jobs', (c) => {
    try { return c.json({ jobs: jobs.list() }); }
    catch { return c.json({ error: '空间切换中，暂时无法读取任务状态' }, 409); }
  });
  app.get('/api/history-jobs/:id', (c) => {
    try {
      const job = jobs.get(c.req.param('id'));
      return job ? c.json({ job }) : c.json({ error: messages.HISTORY_NOT_FOUND }, 404);
    } catch { return c.json({ error: '空间切换中，暂时无法读取任务状态' }, 409); }
  });
  app.post('/api/history-jobs', async (c) => {
    const parsed = create.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请选择平台、1 / 7 / 30 天和当前空间' }, 400);
    try { return c.json({ job: jobs.create(parsed.data) }, 202); }
    catch (error) { return c.json({ error: messages[error instanceof Error ? error.message : ''] ?? '无法创建历史任务，已保存进度保留' }, 409); }
  });
  for (const action of ['cancel', 'retry'] as const) app.post(`/api/history-jobs/:id/${action}`, async (c) => {
    const parsed = mutation.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请刷新后再操作历史任务' }, 400);
    try {
      const b = parsed.data, id = c.req.param('id')!;
      const job = action === 'cancel' ? jobs.cancel(id, b.expected_account_epoch) : jobs.retry(id, b.expected_account_epoch, b.intake_id);
      return c.json({ job });
    } catch (error) { return c.json({ error: messages[error instanceof Error ? error.message : ''] ?? '历史任务暂时不可用，已保存进度保留' }, 409); }
  });
  return jobs;
}
