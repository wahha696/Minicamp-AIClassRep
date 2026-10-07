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
