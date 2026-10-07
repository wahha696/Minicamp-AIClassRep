// 对已人工复核、已脱敏的 JSONL 结果评分。每行：
// {"id":"case-1","privacy_reviewed":true,"expected":{...}|null,"actual":[{...}]}
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreAccuracy, type AccuracyCaseResult } from './accuracy.js';

const inputArg = process.argv.indexOf('--input');
const outputArg = process.argv.indexOf('--output');
const input = resolve(inputArg >= 0 ? process.argv[inputArg + 1] ?? '' : 'accuracy-results.jsonl');
const output = resolve(outputArg >= 0 ? process.argv[outputArg + 1] ?? '' : 'accuracy-report.json');
const records = readFileSync(input, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw new Error(`第 ${index + 1} 行不是合法 JSON`); }
  const item = parsed as AccuracyCaseResult & { privacy_reviewed?: unknown };
  if (item.privacy_reviewed !== true) throw new Error(`第 ${index + 1} 行未声明 privacy_reviewed=true`);
  if (typeof item.id !== 'string' || !Array.isArray(item.actual) || !('expected' in item)) {
    throw new Error(`第 ${index + 1} 行缺少 id / expected / actual`);
  }
  const strings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(item);
  if (strings.some((value) => /(?<!\d)\d{5,12}(?!\d)/.test(value))) {
    throw new Error(`第 ${index + 1} 行疑似仍含 QQ 号/学号，请先脱敏`);
  }
  return item;
});

const report = scoreAccuracy(records);
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`样本 ${report.cases} · Precision ${(report.precision * 100).toFixed(1)}% · Recall ${(report.recall * 100).toFixed(1)}% · F1 ${(report.f1 * 100).toFixed(1)}%`);
console.log(`每千条误报 ${report.false_positives_per_1000_messages.toFixed(1)} · 新增/改期/取消 ${(['create', 'update', 'cancel'] as const).map((kind) => {
  const score = report.action_recall[kind].accuracy;
  return score === null ? 'N/A' : `${(score * 100).toFixed(1)}%`;
}).join('/')}`);
console.log(`报告：${output}`);
if (!report.gate.passed) {
  for (const problem of report.gate.problems) console.error(`❌ ${problem}`);
  process.exitCode = 1;
} else {
  console.log('✅ 达到成熟发布门槛');
}
