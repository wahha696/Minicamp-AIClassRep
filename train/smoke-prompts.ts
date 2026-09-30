// 同源桥冒烟：不配 Key、不碰数据库，验证「训练样本 prompt 逐字节来自生产构造器」。
//   pnpm --filter server exec tsx ../../train/smoke-prompts.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDemoMessages } from '../apps/server/src/ingest/demo.js';
import { ARTIFACTS_DIR } from './lib/paths.js';
import { PROMPT_VERSION, buildPromptPair, estTokens, makeBatches, type PromptPair } from './lib/prompts.js';

console.log(`PROMPT_VERSION = ${PROMPT_VERSION}`);

// 固定回放时刻（明天同时刻），保证两次构建输入一致
const now = Date.now() + 86400_000;
const msgs = buildDemoMessages('noisy', now);
if (!msgs) throw new Error('noisy 剧本读取失败');

const batches = makeBatches(msgs);
const totalCandidates = batches.reduce((n, b) => n + b.candidates.length, 0);
console.log(
  `\nnoisy.json：${msgs.length} 条消息 → ${batches.length} 个有效批次，` +
    `候选 ${totalCandidates} 条（规则层过滤掉 ${msgs.length - totalCandidates} 条）`,
);

// 确定性断言：同输入构建两遍，system / user 必须逐字节相等
let samplePair: PromptPair | undefined;
for (const [i, batch] of batches.entries()) {
  const pair = buildPromptPair(msgs, batch, now);
  const again = buildPromptPair(msgs, batch, now);
  if (pair.system !== again.system || pair.user !== again.user) {
    throw new Error(`批次 ${i} 的 prompt 不确定：同输入两次构建结果不同`);
  }
  const tok = estTokens(`${pair.system}${pair.user}`);
  console.log(
    `  批次 ${i + 1}：候选 ${String(batch.candidates.length).padStart(2)} 条 | ` +
      `system ${pair.system.length} 字 + user ${pair.user.length} 字 ≈ ${tok} tok`,
  );
  if (i === 0) samplePair = pair;
}

if (!samplePair) throw new Error('没有得到任何样本');

// 落一份人眼可查的样例（不进训练集，只供检查 prompt 形态）
const out = join(ARTIFACTS_DIR, 'sample-prompt.txt');
mkdirSync(ARTIFACTS_DIR, { recursive: true });
writeFileSync(
  out,
  [
    `# PROMPT_VERSION=${PROMPT_VERSION}`,
    '# ============ system ============',
    samplePair.system,
    '# ============ user ============',
    samplePair.user,
    '',
  ].join('\n'),
  'utf8',
);
console.log(`\n✅ 确定性断言通过，样例已写到 ${out}`);
console.log(`✅ PROMPT_VERSION=${PROMPT_VERSION}，同源桥工作正常`);
