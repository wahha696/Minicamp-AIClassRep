import type { Hono } from 'hono';
import { validReminderRules } from '../../../../shared/reminders.js';
import { getReminderSettings, saveReminderRules } from '../reminders/settings.js';

export function registerReminderRoutes(app: Hono): void {
  app.get('/api/settings/reminders', c => {
    try { return c.json(getReminderSettings()); }
    catch { return c.json({ error: '提醒设置读取失败，未启用自动发送' }, 503); }
  });
  app.put('/api/settings/reminders', async c => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!validReminderRules(body) || Object.keys(body).some(key => !['enabled', 'before_minutes', 'daily_limit', 'quiet_hours', 'missed_policy'].includes(key))
      || body.before_minutes.length > 16) return c.json({ error: '请设置不重复的正整数分钟（最多 16 个）和正整数每日上限' }, 400);
    if (body.enabled) return c.json({ error: '手机提醒尚未完成渠道验证和绑定，暂不能开启自动发送' }, 409);
    try { return c.json(saveReminderRules(body)); }
    catch { return c.json({ error: '提醒设置保存失败，原设置未变更' }, 503); }
  });
}
