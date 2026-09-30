// Jev 阈值校准 + 延迟测量（会真实调用 LLM 与 Jev；用 :memory: 库，不碰 data/classrep.db）：
//   pnpm --filter server exec tsx src/pipeline/jev-calibrate.ts                 全部剧本
//   pnpm --filter server exec tsx src/pipeline/jev-calibrate.ts noisy cancel    指定剧本
//
// 做法：
// 1. 关掉 Jev，只用 LLM 把剧本跑一遍（和线上同样的分批与上下文），把 event_sources 里的消息当作「真通知」参考答案；
// 2. 同样的批次再只调 Jev 打分；
// 3. 输出：真通知的分数（最低的几条最要紧）、各阈值下的召回率与 LLM 输入省下的比例、Jev / LLM 各自耗时。
// 参考答案来自 LLM，本身可能有错：打印出来的「真通知最低分」那几条要人工看一眼。
import { db, openDb } from '../db/index.js';
import { env } from '../env.js';
import { buildDemoMessages, listScenarios } from '../ingest/demo.js';
import { ingestMessages } from '../ingest/index.js';
import type { Message } from '../types.js';
import { isNoise } from './filter.js';
import { runPipelineNow } from './index.js';
import { JEV_DROP_BELOW, JEV_URGENT_AT, resetJevBackoff, scoreWithJev } from './jev.js';
import { localJevReady } from './jev-local.js';
import { jevStats, llmStats } from './stats.js';

const BATCH = 30;
const CONTEXT = 10;

// 快判已本地化（产品决策 2026-09-29 起 FASTJUDGE_MODE 默认 local）：本地模式下不再需要
// TypeSafe key，验收门必须能在"只有本地模型"的配置里跑起来，否则本地化交付无法验收。
if (!env.LLM_API_KEY || (!env.TYPESAFE_API_KEY && !localJevReady())) {
  console.error(
    '需要在仓库根目录 .env 里配置 LLM_API_KEY，且满足以下之一：\n' +
      '  · FASTJUDGE_MODE=local 且本地快判可用（classrep-fastjudge/models/local-jev-v1.joblib 或 LOCAL_JEV_MODEL_PATH/FASTJUDGE_ROOT）\n' +
      '  · 或配置 TYPESAFE_API_KEY（FASTJUDGE_MODE=jev/dual 的远端对照）',
  );
  process.exit(2);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = args.length ? args : listScenarios().map((s) => s.name);

interface Scored {
  scenario: string;
  msg: Message;
  score: number;
  positive: boolean;
}

const all: Scored[] = [];
const jevMs: { n: number; ms: number }[] = [];
const llmMs: number[] = [];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : NaN;
};

for (const name of names) {
  // ---- 1. 参考答案：只用 LLM ----
  openDb(':memory:');
  const msgs = buildDemoMessages(name, Date.now());
  if (!msgs) throw new Error(`剧本不存在：${name}`);
  ingestMessages(msgs, 'demo');
  env.ENABLE_JEV = false;
  const calls0 = llmStats.called;
  const t0 = Date.now();
  await runPipelineNow();
  const llmCalls = llmStats.called - calls0;
  llmMs.push((Date.now() - t0) / Math.max(1, llmCalls));
  const positives = new Set(
    (db.prepare('SELECT DISTINCT message_id FROM event_sources').all() as { message_id: string }[]).map((r) => r.message_id),
  );

  // ---- 2. 同样的批次只调 Jev ----
  env.ENABLE_JEV = true;
  resetJevBackoff();
  for (let i = 0; i < msgs.length; i += BATCH) {
    const batch = msgs.slice(i, i + BATCH);
    const context = msgs.slice(0, i).filter((m) => !isNoise(m.text)).slice(-CONTEXT);
    const candidates = batch.filter((m) => !isNoise(m.text));
    if (!candidates.length) continue;
    const t = Date.now();
    const scores = await scoreWithJev(candidates, context, msgs[0]!.group_name);
    if (!scores) throw new Error(`Jev 调用失败（剧本 ${name}），先检查 key / 网络`);
    jevMs.push({ n: candidates.length, ms: Date.now() - t });
    candidates.forEach((msg, k) => all.push({ scenario: name, msg, score: scores[k]!, positive: positives.has(msg.message_id) }));
  }
  const mine = all.filter((s) => s.scenario === name);
  console.log(
    `${name.padEnd(14)} 候选 ${String(mine.length).padStart(3)} 条  参考真通知 ${positives.size} 条  LLM ${llmCalls} 次`,
  );
}

// ---- 3. 报告 ----
const pos = all.filter((s) => s.positive).sort((a, b) => a.score - b.score);
const neg = all.filter((s) => !s.positive);

console.log('\n======== 真通知里 Jev 分数最低的 10 条（阈值必须低于这些，除非参考答案本身错了）');
for (const s of pos.slice(0, 10)) {
  console.log(`  ${s.score.toFixed(3)}  [${s.scenario}] ${s.msg.sender_name}：${s.msg.text.slice(0, 50)}`);
}
console.log('\n======== 非通知里 Jev 分数最高的 10 条（会被当成「确定是」立刻处理，只影响花费不影响正确性）');
for (const s of [...neg].sort((a, b) => b.score - a.score).slice(0, 10)) {
  console.log(`  ${s.score.toFixed(3)}  [${s.scenario}] ${s.msg.sender_name}：${s.msg.text.slice(0, 50)}`);
}

console.log(`\n======== 阈值扫描（候选 ${all.length} 条，参考真通知 ${pos.length} 条）`);
console.log('  丢弃阈值  真通知召回  候选丢弃率');
for (const th of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
  const kept = pos.filter((s) => s.score >= th).length;
  const dropped = all.filter((s) => s.score < th).length;
  const mark = th === JEV_DROP_BELOW ? '  ← 当前' : '';
  console.log(`  ${th.toFixed(2).padStart(8)}  ${((kept / Math.max(1, pos.length)) * 100).toFixed(1).padStart(8)}%  ${((dropped / all.length) * 100).toFixed(1).padStart(8)}%${mark}`);
}
const urgentPos = pos.filter((s) => s.score >= JEV_URGENT_AT).length;
const urgentNeg = neg.filter((s) => s.score >= JEV_URGENT_AT).length;
console.log(
  `\n  立即处理阈值 ${JEV_URGENT_AT}：命中真通知 ${urgentPos}/${pos.length}（这些不用等攒批），误报 ${urgentNeg} 条（只是早调一次 LLM）`,
);

console.log('\n======== 耗时');
console.log(`  Jev：${jevMs.length} 次，p50 ${pct(jevMs.map((j) => j.ms), 50)}ms，p90 ${pct(jevMs.map((j) => j.ms), 90)}ms，最大 ${Math.max(...jevMs.map((j) => j.ms))}ms（超时设置 ${env.JEV_TIMEOUT_MS}ms）`);
for (const j of jevMs) console.log(`    ${String(j.n).padStart(2)} 条 → ${j.ms}ms`);
console.log(`  LLM：每次平均 ${Math.round(pct(llmMs, 50))}ms（各剧本平均的中位数），最近一次 ${llmStats.lastMs}ms`);
console.log(`  Jev 调用 ${jevStats.called} 次，LLM 调用 ${llmStats.called} 次`);

const missed = pos.filter((s) => s.score < JEV_DROP_BELOW);
if (missed.length) {
  console.log(`\n❌ 当前丢弃阈值 ${JEV_DROP_BELOW} 会丢掉 ${missed.length} 条参考真通知，检查上面最低分那几条`);
  process.exit(1);
}
console.log(`\n✅ 当前丢弃阈值 ${JEV_DROP_BELOW} 不丢参考真通知`);
process.exit(0);
