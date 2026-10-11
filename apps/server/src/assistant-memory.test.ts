import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { db, openDb } from './db/index.js';
import { applyAssistantMemoryRules, assistantMemoryState, assistantSuppression, deleteAssistantMemory, saveAssistantMemory } from './assistant-memory.js';
import { registerAssistantMemoryRoutes } from './routes/assistant-memory.js';
import { clearGroupEventData } from './event-group-data.js';
import type { ExtractedEvent } from './pipeline/extract.js';
import type { Message } from './types.js';

const message: Message = { group_id: 'synthetic', group_name: '人工群', message_id: 'm1', sender_name: '人工老师', text: '物理作业周五交', sent_at: 1 };
const event = (changes: Partial<ExtractedEvent> = {}): ExtractedEvent => ({ action: 'create', update_of: null, type: 'assignment', title: '物理作业', description: '', start_at: null, end_at: null, deadline_at: 2, location: null, action_required: null, confidence: 1, level: 2, source_message_ids: ['m1'], ...changes });
const rule = { text: '人工测试：物理作业不加入日程', action: 'exclude_calendar', course: '物理', event_types: ['assignment'] };
beforeEach(() => {
  openDb(':memory:');
  db.prepare("INSERT INTO groups(group_id,name,adapter,course_name,created_at) VALUES('synthetic','人工群','wechat','物理',1)").run();
  db.prepare("INSERT INTO messages(message_id,group_id,sender_name,text,sent_at,source,created_at) VALUES('m1','synthetic','人工老师',?,1,'wechat',1)").run(message.text);
});
describe('explicit assistant memories', () => {
  it('never seeds a user preference; creates, edits, disables and deletes only explicitly', () => {
    expect(assistantMemoryState().rules).toEqual([]);
    const saved = saveAssistantMemory(rule);
    expect(assistantMemoryState().rules).toEqual([saved]);
    expect(saveAssistantMemory({ enabled: false, text: '临时停用' }, saved.id)).toMatchObject({ enabled: false, text: '临时停用' });
    expect(applyAssistantMemoryRules('synthetic', [event()], [message])).toHaveLength(1);
    expect(deleteAssistantMemory(saved.id)).toBe(true);
    expect(assistantMemoryState().rules).toEqual([]);
  });
  it('suppresses only matching new notifications, retains source and deduplicates retry receipts', () => {
    const saved = saveAssistantMemory(rule);
    expect(applyAssistantMemoryRules('synthetic', [event()], [message])).toEqual([]);
    expect(applyAssistantMemoryRules('synthetic', [event()], [message])).toEqual([]);
    const records = assistantMemoryState().recent_suppressions;
    expect(records).toHaveLength(1);
    expect(assistantSuppression(records[0]!.id)?.sources).toEqual([message]);
    expect(db.prepare('SELECT text FROM messages').get()?.text).toBe(message.text);
    deleteAssistantMemory(saved.id);
    expect(applyAssistantMemoryRules('synthetic', [event()], [message])).toHaveLength(1);
    expect(assistantSuppression(records[0]!.id)?.sources).toEqual([message]);
  });
  it('does not hide exams, existing event updates, other courses or invalid source references', () => {
    saveAssistantMemory(rule);
    const others = [event({ type: 'exam' }), event({ action: 'update', update_of: 7 }), event({ action: 'cancel', update_of: 7 }), event({ source_message_ids: ['missing'] })];
    expect(applyAssistantMemoryRules('synthetic', others, [message])).toEqual(others);
    db.prepare("UPDATE groups SET course_name='数学'").run();
    expect(applyAssistantMemoryRules('synthetic', [event()], [message])).toHaveLength(1);
  });
  it('unbound groups and similarly named courses never filter from titles; notes never filter', () => {
    db.prepare('UPDATE groups SET course_name=NULL').run();
    saveAssistantMemory(rule);
    expect(applyAssistantMemoryRules('synthetic', [event({ title: '数学作业提到物理' })], [message])).toHaveLength(1);
    expect(applyAssistantMemoryRules('synthetic', [event()], [message])).toHaveLength(1);
    db.prepare('UPDATE groups SET course_name=?').run('物理化学');
    expect(applyAssistantMemoryRules('synthetic', [event()], [message])).toHaveLength(1);
    openDb(':memory:');
    saveAssistantMemory({ text: '喜欢简洁答复', action: 'note' });
    expect(applyAssistantMemoryRules('synthetic', [event()], [message])).toHaveLength(1);
  });
  it('new spaces have neither rules nor exclusion snapshots', () => {
    saveAssistantMemory(rule); applyAssistantMemoryRules('synthetic', [event()], [message]);
    openDb(':memory:');
    expect(assistantMemoryState()).toEqual({ scope: 'current_space', rules: [], recent_suppressions: [] });
  });
  it('clearing a group removes its source snapshots, retains other groups and prevents reimport', async () => {
    saveAssistantMemory(rule);
    applyAssistantMemoryRules('synthetic', [event()], [message]);
    const id = assistantMemoryState().recent_suppressions[0]!.id;
    db.prepare(`INSERT INTO assistant_suppressions(dedupe_key,rule_id,group_id,title,course,sources,created_at)
      SELECT 'other',rule_id,'other',title,course,sources,created_at FROM assistant_suppressions WHERE id=?`).run(id);
    db.exec('BEGIN');
    try { clearGroupEventData('synthetic', true); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    expect(assistantSuppression(id)).toBeNull();
    expect(assistantMemoryState().recent_suppressions).toHaveLength(1);
    expect(assistantMemoryState().rules).toHaveLength(1);
    expect(db.prepare('SELECT message_id FROM message_seen WHERE group_id=?').get('synthetic')?.message_id).toBe('m1');
    const app = new Hono(); registerAssistantMemoryRoutes(app);
    expect((await app.request(`/api/assistant/memories/suppressions/${id}`)).status).toBe(404);
  });
  it('rejects wildcard, malformed and unknown tool-like rule fields', () => {
    for (const invalid of [{ ...rule, course: '' }, { ...rule, event_types: [] }, { ...rule, shell: 'anything' }, null, [], { ...rule, action: 'delete_source_messages' }]) {
      expect(() => saveAssistantMemory(invalid)).toThrow();
    }
  });
  it('serves actual CRUD and source details, including validation and missing IDs', async () => {
    const app = new Hono(); registerAssistantMemoryRoutes(app);
    const created = await app.request('/api/assistant/memories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule) });
    expect(created.status).toBe(201);
    const saved = await created.json() as { id: number };
    const changed = await app.request(`/api/assistant/memories/${saved.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    expect(changed.status).toBe(200);
    expect((await changed.json() as { enabled: boolean }).enabled).toBe(false);
    expect((await app.request('/api/assistant/memories/999', { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`/api/assistant/memories/${saved.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/api/assistant/memories')).status).toBe(200);
  });
});
