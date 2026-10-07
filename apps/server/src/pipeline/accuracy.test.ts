import { describe, expect, it } from 'vitest';
import { scoreAccuracy, type AccuracyCaseResult, type AccuracyThresholds } from './accuracy.js';

const noMinimum: AccuracyThresholds = {
  minCases: 0,
  precision: 0,
  recall: 0,
  mutationActionRecall: 0,
  timeAccuracy: 0,
  locationAccuracy: 0,
  maxFalsePositivesPer1000: 1000,
};

const base = {
  action: 'create' as const,
  type: 'exam' as const,
  title: '高数小测',
  start_at: Date.parse('2026-10-08T14:00:00+08:00'),
  end_at: null,
  deadline_at: null,
  location: 'A301',
  action_required: null,
};

describe('准确率评分', () => {
  it('分别统计误报、漏报、多生成、动作与字段准确率', () => {
    const cases: AccuracyCaseResult[] = [
      { id: 'ok', expected: base, actual: [{ ...base, start_at: base.start_at + 4 * 60_000 }] },
      { id: 'miss', expected: { ...base, action: 'cancel' }, actual: [] },
      { id: 'false', expected: null, actual: [base] },
      { id: 'extra', expected: { ...base, action: 'update' }, actual: [{ ...base }, { ...base, title: '重复' }] },
    ];
    const report = scoreAccuracy(cases, noMinimum);
    expect(report).toMatchObject({
      cases: 4,
      true_positive_cases: 2,
      false_positive_events: 2,
      false_negative_cases: 1,
      precision: 0.5,
      recall: 2 / 3,
    });
    expect(report.mutation_action_recall).toEqual({ correct: 0, total: 2, accuracy: 0 });
    expect(report.action_recall).toEqual({
      create: { correct: 1, total: 1, accuracy: 1 },
      update: { correct: 0, total: 1, accuracy: 0 },
      cancel: { correct: 0, total: 1, accuracy: 0 },
    });
    expect(report.fields.start_at).toEqual({ correct: 2, total: 3, accuracy: 2 / 3 });
    expect(report.failures.map((failure) => failure.id).sort()).toEqual(['extra', 'false', 'miss']);
  });

  it('成熟度门槛会拦截样本不足，即使小样本全部正确', () => {
    const report = scoreAccuracy([{ id: 'only', expected: base, actual: [base] }]);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.problems).toContain('样本不足：1/100');
  });

  it('空字段不虚增准确率，模型凭空生成地点会计错', () => {
    const report = scoreAccuracy([
      { id: 'both-empty', expected: { ...base, location: null }, actual: [{ ...base, location: null }] },
      { id: 'hallucinated', expected: { ...base, location: null }, actual: [{ ...base, location: '不存在的教室' }] },
    ], noMinimum);
    expect(report.fields.location).toEqual({ correct: 0, total: 1, accuracy: 0 });
  });
});
