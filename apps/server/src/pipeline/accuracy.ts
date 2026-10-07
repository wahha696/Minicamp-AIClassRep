import type { ExtractedEvent } from './extract.js';

export type AccuracyEvent = Pick<
  ExtractedEvent,
  | 'action' | 'type' | 'title' | 'start_at' | 'end_at' | 'deadline_at'
  | 'location' | 'action_required'
>;

export interface AccuracyCaseResult {
  id: string;
  expected: AccuracyEvent | null;
  actual: AccuracyEvent[];
}

export interface AccuracyThresholds {
  minCases: number;
  precision: number;
  recall: number;
  mutationActionRecall: number;
  timeAccuracy: number;
  locationAccuracy: number;
  maxFalsePositivesPer1000: number;
}

export const MATURE_THRESHOLDS: AccuracyThresholds = {
  minCases: 100,
  precision: 0.95,
  recall: 0.95,
  mutationActionRecall: 0.95,
  timeAccuracy: 0.95,
  locationAccuracy: 0.95,
  maxFalsePositivesPer1000: 5,
};

interface MetricCount { correct: number; total: number; accuracy: number | null }

const text = (value: string | null | undefined) => (value ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s，。；：、,.!！?？（）()【】\[\]]+/g, '');

function similarity(expected: AccuracyEvent, actual: AccuracyEvent): number {
  let score = expected.action === actual.action ? 8 : 0;
  if (expected.type === actual.type) score += 4;
  if (text(expected.title) === text(actual.title)) score += 6;
  if (expected.start_at != null && actual.start_at != null && Math.abs(expected.start_at - actual.start_at) <= 300_000) score += 2;
  if (expected.deadline_at != null && actual.deadline_at != null && Math.abs(expected.deadline_at - actual.deadline_at) <= 300_000) score += 2;
  return score;
}

function bestMatch(expected: AccuracyEvent, actual: AccuracyEvent[]): AccuracyEvent | null {
  return [...actual].sort((a, b) => similarity(expected, b) - similarity(expected, a))[0] ?? null;
}

function ratio(correct: number, total: number): MetricCount {
  return { correct, total, accuracy: total === 0 ? null : correct / total };
}

function scoreField(
  cases: Array<{ expected: AccuracyEvent; actual: AccuracyEvent | null }>,
  field: keyof AccuracyEvent,
  equal: (a: unknown, b: unknown) => boolean,
): MetricCount {
  // null/null 不是“字段识别正确”，否则大量没有地点/结束时间的样本会虚高准确率；
  // 期望为空但模型凭空生成字段仍要计错。
  const relevant = cases.filter(({ expected, actual }) =>
    expected[field] !== null && expected[field] !== undefined ||
    actual?.[field] !== null && actual?.[field] !== undefined,
  );
  return ratio(
    relevant.filter(({ expected, actual }) => actual !== null && equal(expected[field], actual[field])).length,
    relevant.length,
  );
}

const exact = (a: unknown, b: unknown) => text(a as string | null) === text(b as string | null);
const timeWithin = (a: unknown, b: unknown) =>
  (a === null && b === null) ||
  (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 300_000);

export interface AccuracyReport {
  cases: number;
  expected_events: number;
  predicted_events: number;
  true_positive_cases: number;
  false_positive_events: number;
  false_negative_cases: number;
  precision: number;
  recall: number;
  f1: number;
  false_positives_per_1000_messages: number;
  action_accuracy: MetricCount;
  action_recall: Record<'create' | 'update' | 'cancel', MetricCount>;
  mutation_action_recall: MetricCount;
  fields: Record<string, MetricCount>;
  failures: Array<{ id: string; problems: string[] }>;
  gate: { passed: boolean; problems: string[]; thresholds: AccuracyThresholds };
}

export function scoreAccuracy(
  cases: AccuracyCaseResult[],
  thresholds: AccuracyThresholds = MATURE_THRESHOLDS,
): AccuracyReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const paired: Array<{ id: string; expected: AccuracyEvent; actual: AccuracyEvent | null }> = [];
  const failures: AccuracyReport['failures'] = [];

  for (const item of cases) {
    const problems: string[] = [];
    if (item.expected === null) {
      fp += item.actual.length;
      if (item.actual.length) problems.push(`误报 ${item.actual.length} 个事件`);
    } else if (item.actual.length === 0) {
      fn++;
      paired.push({ id: item.id, expected: item.expected, actual: null });
      problems.push('漏掉事件');
    } else {
      tp++;
      fp += Math.max(0, item.actual.length - 1);
      const actual = bestMatch(item.expected, item.actual);
      paired.push({ id: item.id, expected: item.expected, actual });
      if (item.actual.length > 1) problems.push(`多生成 ${item.actual.length - 1} 个事件`);
      if (actual?.action !== item.expected.action) problems.push(`动作应为 ${item.expected.action}，实际 ${actual?.action}`);
      if (actual?.type !== item.expected.type) problems.push(`类型应为 ${item.expected.type}，实际 ${actual?.type}`);
    }
    if (problems.length) failures.push({ id: item.id, problems });
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const action = ratio(paired.filter((x) => x.actual?.action === x.expected.action).length, paired.length);
  const actionRecall = Object.fromEntries((['create', 'update', 'cancel'] as const).map((kind) => {
    const relevant = paired.filter((x) => x.expected.action === kind);
    return [kind, ratio(relevant.filter((x) => x.actual?.action === kind).length, relevant.length)];
  })) as AccuracyReport['action_recall'];
  const mutation = paired.filter((x) => x.expected.action === 'update' || x.expected.action === 'cancel');
  const mutationAction = ratio(mutation.filter((x) => x.actual?.action === x.expected.action).length, mutation.length);
  const fields = {
    type: scoreField(paired, 'type', (a, b) => a === b),
    title: scoreField(paired, 'title', exact),
    start_at: scoreField(paired, 'start_at', timeWithin),
    end_at: scoreField(paired, 'end_at', timeWithin),
    deadline_at: scoreField(paired, 'deadline_at', timeWithin),
    location: scoreField(paired, 'location', exact),
    action_required: scoreField(paired, 'action_required', exact),
  };
  const timeParts = [fields.start_at, fields.end_at, fields.deadline_at];
  const time = ratio(timeParts.reduce((sum, part) => sum + part.correct, 0), timeParts.reduce((sum, part) => sum + part.total, 0));
  const fp1000 = cases.length === 0 ? 0 : (fp / cases.length) * 1000;
  const gateProblems: string[] = [];
  if (cases.length < thresholds.minCases) gateProblems.push(`样本不足：${cases.length}/${thresholds.minCases}`);
  if (precision < thresholds.precision) gateProblems.push(`精确率 ${(precision * 100).toFixed(1)}% < ${(thresholds.precision * 100).toFixed(1)}%`);
  if (recall < thresholds.recall) gateProblems.push(`召回率 ${(recall * 100).toFixed(1)}% < ${(thresholds.recall * 100).toFixed(1)}%`);
  for (const [kind, label] of [['create', '新增'], ['update', '改期'], ['cancel', '取消']] as const) {
    const metric = actionRecall[kind];
    if ((metric.accuracy ?? 0) < thresholds.mutationActionRecall) {
      gateProblems.push(`${label}动作召回${metric.total === 0 ? '无覆盖样本' : '未达标'}`);
    }
  }
  if ((time.accuracy ?? 0) < thresholds.timeAccuracy) gateProblems.push('时间字段准确率未达标');
  if ((fields.location.accuracy ?? 0) < thresholds.locationAccuracy) gateProblems.push('地点字段准确率未达标');
  if (fp1000 > thresholds.maxFalsePositivesPer1000) gateProblems.push(`每千条误报 ${fp1000.toFixed(1)} > ${thresholds.maxFalsePositivesPer1000}`);

  return {
    cases: cases.length,
    expected_events: tp + fn,
    predicted_events: tp + fp,
    true_positive_cases: tp,
    false_positive_events: fp,
    false_negative_cases: fn,
    precision,
    recall,
    f1,
    false_positives_per_1000_messages: fp1000,
    action_accuracy: action,
    action_recall: actionRecall,
    mutation_action_recall: mutationAction,
    fields: { ...fields, time_overall: time },
    failures,
    gate: { passed: gateProblems.length === 0, problems: gateProblems, thresholds },
  };
}
