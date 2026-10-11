import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from './db/index.js';
import { createDiagnosticReport } from './diagnostics.js';

beforeEach(() => {
  openDb(':memory:');
});

function addMessage(id: string, group: string, text: string, reason: string, filtered = 0): void {
  db.prepare(
    `INSERT INTO messages
      (message_id, group_id, sender_name, text, sent_at, source, processed, filtered_out, decision_reason, created_at)
     VALUES (?, ?, ?, ?, ?, 'onebot', 1, ?, ?, ?)`,
  ).run(id, group, '真实姓名不能泄露', text, Date.now() - 3600_000, filtered, reason, Date.now());
}

describe('脱敏诊断报告', () => {
  it('跨平台合并按来源群关联，不把同号其他群的消息关联进去', () => {
    addMessage('shared-id', 'wx-source', '人工通知', 'event_recognized');
    addMessage('shared-id', 'unrelated', '人工其他消息', 'llm_no_event');
    db.exec("INSERT INTO events(id,group_id,title,type,deadline_at,status,confidence,created_at,updated_at) VALUES (1,'qq-primary','人工','exam',100,'active',1,1,1)");
    db.exec("INSERT INTO event_sources(event_id,message_id,group_id,group_name,platform,sender_name,text,sent_at) VALUES (1,'shared-id','wx-source','人工','wechat','人工','人工通知',1)");
    const rows = createDiagnosticReport().messages as Array<Record<string, unknown>>;
    expect(rows.find(row => row.decision === 'event_recognized')?.linked_event_types).toEqual(['exam']);
    expect(rows.find(row => row.decision === 'llm_no_event')?.linked_event_types).toEqual([]);
  });
  it('解释逐条决策，但不包含正文、标识、姓名、路径或密钥', () => {
    addMessage('secret-message-id', 'secret-group-id', '明天 14:00 在 A301 考试，验证码 123456', 'event_recognized');
    addMessage('another-id', 'secret-group-id', '哈哈哈哈', 'rule_noise', 1);
    const report = createDiagnosticReport();
    const json = JSON.stringify(report);
    for (const secret of [
      'secret-message-id', 'secret-group-id', '真实姓名不能泄露', 'A301', '验证码', '123456', '明天 14:00',
    ]) expect(json).not.toContain(secret);
    expect(report).toMatchObject({
      format: 'classrep-diagnostic-v1',
      decision_counts: { event_recognized: 1, rule_noise: 1 },
      database: { integrity: 'ok' },
    });
    const messages = report.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages.map((item) => item.decision).sort()).toEqual(['event_recognized', 'rule_noise']);
    expect(messages.every((item) => item.group === 'group-1')).toBe(true);
  });

  it('旧库已处理行没有细原因时明确标为 legacy，而非假装已识别', () => {
    addMessage('old', 'g', '旧消息', 'pending');
    const report = createDiagnosticReport();
    expect(report.decision_counts).toEqual({ legacy_processed: 1 });
  });
});
