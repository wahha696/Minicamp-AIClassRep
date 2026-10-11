import type { Hono } from 'hono';
import { ZodError } from 'zod';
import { assistantMemoryState, assistantSuppression, deleteAssistantMemory, saveAssistantMemory } from '../assistant-memory.js';

export function registerAssistantMemoryRoutes(app: Hono): void {
  app.get('/api/assistant/memories', c => c.json(assistantMemoryState()));
  app.get('/api/assistant/memories/suppressions/:id', c => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: '记录编号不合法' }, 400);
    const value = assistantSuppression(id);
    return value ? c.json(value) : c.json({ error: '记录不存在' }, 404);
  });
  app.post('/api/assistant/memories', async c => {
    try { return c.json(saveAssistantMemory(await c.req.json()), 201); }
    catch (error) { return c.json({ error: error instanceof ZodError ? '请填写偏好；排除日程须指定课程及事项类型' : error instanceof SyntaxError ? '请求体不是合法 JSON' : '无法保存偏好，请检查规则数量' }, 400); }
  });
  app.patch('/api/assistant/memories/:id', async c => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: '偏好编号不合法' }, 400);
    if (!assistantMemoryState().rules.some(r => r.id === id)) return c.json({ error: '偏好不存在' }, 404);
    try { return c.json(saveAssistantMemory(await c.req.json(), id)); }
    catch { return c.json({ error: '偏好格式不正确；排除规则须指定课程及事项类型' }, 400); }
  });
  app.delete('/api/assistant/memories/:id', c => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: '偏好编号不合法' }, 400);
    return deleteAssistantMemory(id) ? c.json({ ok: true }) : c.json({ error: '偏好不存在' }, 404);
  });
}
