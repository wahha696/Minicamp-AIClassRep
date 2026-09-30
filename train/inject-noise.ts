// 噪声注入：把生成剧本的信噪比拉回真实群聊水平（零 API 成本）。
//
// 为什么要做：线上分批是 BATCH=30 条消息一批、批内先按 isNoise 去噪再送模型。
// 实测真实群聊噪声约 78%、30 条批去噪后候选中位 6；而生成剧本噪声只有约 20%、
// 去噪后候选中位 20 —— 模型在"拥挤批次"上训练，上线却只面对 6 个候选（见 BATCH-SHAPE.md）。
//
// 做法：用生成剧本自带的闲聊消息当噪声池（不碰 data/mock 考卷），
// 按目标比例插回每个剧本的消息流（确定性随机，可复现），产出新剧本目录后再蒸馏。
//
//   node train/dist/train/inject-noise.js --noise-ratio 0.75 --limit 700
//   node train/dist/train/inject-noise.js --dir train/data/scenarios --out train/data/scenarios-noisy
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNoise } from '../apps/server/src/pipeline/filter.js';
import type { ScenarioJson, ScenarioMessageJson } from './lib/prompts.js';
import { SCENARIO_DIR } from './lib/paths.js';

const args = process.argv.slice(2);
const flagOf = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const numArg = (k: string, d: number): number => {
  const v = Number(flagOf(k));
  return Number.isFinite(v) && v !== 0 ? v : d;
};

const SRC = flagOf('dir') ?? SCENARIO_DIR;
const OUT = flagOf('out') ?? join(SCENARIO_DIR, '..', 'scenarios-noisy');
const RATIO = Math.min(0.9, Math.max(0.3, Number(flagOf('noise-ratio')) || 0.75));
const LIMIT = numArg('limit', 0);
const SEED = numArg('seed', 20260930);

/** 确定性 RNG（字符串种子 → mulberry32），保证同一批剧本每次注入结果一致 */
function rngFor(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = (h ^ SEED) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function main(): void {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.json')).sort();
  const scenarios: { name: string; json: ScenarioJson }[] = [];
  for (const f of files) {
    if (LIMIT > 0 && scenarios.length >= LIMIT) break;
    try {
      scenarios.push({ name: f.replace(/\.json$/, ''), json: JSON.parse(readFileSync(join(SRC, f), 'utf8')) as ScenarioJson });
    } catch (e) {
      console.warn(`跳过坏剧本 ${f}：${(e as Error).message}`);
    }
  }
  if (scenarios.length === 0) throw new Error(`没有剧本：${SRC}`);

  // 1) 噪声池：只取生成剧本里被判为噪声的短消息（不引入考卷 data/mock 的内容）
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const s of scenarios) {
    for (const m of s.json.messages ?? []) {
      const t = (m.text ?? '').trim();
      if (t && isNoise(t) && !seen.has(t)) {
        seen.add(t);
        pool.push(t);
      }
    }
  }
  if (pool.length < 10) throw new Error(`噪声池太小（${pool.length} 条），先确认剧本里有足够闲聊`);
  console.log(`噪声池：${pool.length} 条（来自 ${scenarios.length} 个剧本自带的闲聊）`);

  // 2) 逐个剧本注入噪声，直到噪声占比达到目标
  mkdirSync(OUT, { recursive: true });
  let totalMsgs = 0;
  let totalNoise = 0;
  let outCount = 0;
  for (const { name, json } of scenarios) {
    const msgs: ScenarioMessageJson[] = json.messages ?? [];
    if (msgs.length === 0) continue;
    const rng = rngFor(name);
    const noiseCount = msgs.filter((m) => isNoise((m.text ?? '').trim())).length;
    const realCount = msgs.length - noiseCount;
    // 目标：noise / (noise + real) ≈ RATIO  →  需要多少条噪声
    const need = Math.max(0, Math.ceil((RATIO * realCount) / (1 - RATIO)) - noiseCount);

    const merged: ScenarioMessageJson[] = [];
    const offsets = msgs.map((m) => m.offset_minutes);
    const span = Math.max(1, Math.max(...offsets) - Math.min(...offsets));
    for (let i = 0; i < need; i++) {
      const pick = pool[Math.floor(rng() * pool.length)]!;
      // 随机落在现有时间跨度内（分钟）
      const off = Math.floor(rng() * span) + Math.min(...offsets);
      merged.push({ offset_minutes: off, sender: `同学${1 + Math.floor(rng() * 40)}`, text: pick });
    }
    const all = [...msgs, ...merged].sort((a, b) => a.offset_minutes - b.offset_minutes);
    // 时间同分钟时保持稳定顺序（先原有、后注入）
    const stable = all
      .map((m, i) => ({ m, i }))
      .sort((a, b) => a.m.offset_minutes - b.m.offset_minutes || a.i - b.i)
      .map((x) => x.m);

    const outJson: ScenarioJson = { ...json, messages: stable };
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(outJson, null, 1), 'utf8');
    outCount++;
    totalMsgs += stable.length;
    totalNoise += stable.filter((m) => isNoise((m.text ?? '').trim())).length;
  }

  console.log(
    `写出 ${outCount} 个剧本 → ${OUT}\n` +
      `注入后：消息 ${totalMsgs} 条，噪声 ${totalNoise} 条（${((totalNoise / Math.max(1, totalMsgs)) * 100).toFixed(0)}%）` +
      `，目标噪声比例 ${(RATIO * 100).toFixed(0)}%`,
  );
}

main();
