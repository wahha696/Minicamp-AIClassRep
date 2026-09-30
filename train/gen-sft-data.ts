// 教师蒸馏数据制备（操作手册 §2.1/2.3）：剧本回放 → 生产 prompt → 教师提取 → 质量门 → sharegpt JSONL。
//   node train/dist/train/gen-sft-data.js --dryrun               # 只构建 prompt + 预览，不调 API
//   node train/dist/train/gen-sft-data.js                        # 全量（需 .env 的 LLM_API_KEY）
//   node train/dist/train/gen-sft-data.js --max-candidates 15    # 4B 档缩批（省窗口）
//   node train/dist/train/gen-sft-data.js --limit 50             # 先用 50 个剧本试跑
//
// 产出：train/data/sft-v1.jsonl（sharegpt）+ sft-v1-rejects.jsonl（质量门拒收留档）。
// 铁律：只读 train/data/scenarios/（data/mock/ 是 eval 考卷，物理隔离）；prompt 逐字节来自 extract.ts。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseExtraction } from '../apps/server/src/pipeline/extract.js';
import { JsonlWriter, readJsonl } from './lib/jsonl.js';
import { ARTIFACTS_DIR, DATA_DIR, SCENARIO_DIR } from './lib/paths.js';
import { estTokens, type ScenarioJson } from './lib/prompts.js';
import { planScenario, stripThink, type BatchJob } from './lib/sft.js';
import { teacherConfig, teacherExtract, usage } from './lib/teacher.js';

// ---------- 剧本装载（只进 train/data/scenarios/） ----------

interface Loaded {
  name: string;
  json: ScenarioJson;
}

function loadScenarios(dir: string, limit: number): Loaded[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    console.error(`剧本目录不存在：${dir}（先跑 gen-scenarios.js）`);
    process.exit(2);
  }
  const out: Loaded[] = [];
  for (const f of files) {
    if (limit > 0 && out.length >= limit) break;
    try {
      const json = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ScenarioJson;
      out.push({ name: f.replace(/\.json$/, ''), json });
    } catch (e) {
      console.warn(`跳过坏剧本 ${f}：${(e as Error).message}`);
    }
  }
  return out;
}

/** 按剧本名哈希 → 确定性随机回放时刻（未来 1~45 天 10:00~21:30 上海时间），让日历行充分变化 */
function replayNowFor(scenarioName: string): number {
  let h = 2166136261;
  for (let i = 0; i < scenarioName.length; i++) {
    h ^= scenarioName.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  const rng = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const day = 1 + Math.floor(rng() * 45);
  const d = new Date(Date.now() + day * 86400_000 + 8 * 3600_000);
  const hour = 10 + Math.floor(rng() * 12);
  const minute = Math.floor(rng() * 12) * 5;
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600_000;
  return dayStart + hour * 3600_000 + minute * 60_000;
}

// ---------- 行格式 ----------

interface SftRow {
  conversations: { from: 'system' | 'human' | 'gpt'; value: string }[];
  meta: {
    scenario: string;
    template: string;
    batch: number;
    prompt_version: number;
    replay_now: number;
    teacher_model: string;
    n_events: number;
    negative: boolean;
    est_tokens: number;
  };
}

interface RejectRow {
  scenario: string;
  template: string;
  batch: number;
  prompt_version: number;
  reason: string;
  raw: string;
}

// ---------- CLI 参数 ----------

const args = process.argv.slice(2);
const flagOf = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const numArg = (k: string, d: number): number => {
  const v = Number(flagOf(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};
const hasFlag = (k: string): boolean => args.includes(`--${k}`);

const DRY = hasFlag('dryrun');
const LIMIT = numArg('limit', 0);
const CONC = Math.max(1, Math.min(8, numArg('concurrency', 3)));
const MAX_CAND = Math.max(3, Math.min(30, numArg('max-candidates', 30)));
const MIN_CONF = Math.min(1, Math.max(0.5, Number(flagOf('min-confidence')) || 0.8));
const OUT_FILE = flagOf('out') ?? 'sft-v1.jsonl';
const REJECT_FILE = `${OUT_FILE.replace(/\.jsonl$/, '')}-rejects.jsonl`;
/** 剧本目录可用 --dir 覆盖（冒烟测试用）；默认 train/data/scenarios/，绝不指向 data/mock/ */
const SCENARIOS_DIR = flagOf('dir') ?? SCENARIO_DIR;

async function main(): Promise<void> {
  const scenarios = loadScenarios(SCENARIOS_DIR, LIMIT);
  if (scenarios.length === 0) {
    console.error(`没有剧本可处理：${SCENARIO_DIR}`);
    process.exit(2);
  }

  // 1) 展开全部训练任务
  const jobs: BatchJob[] = [];
  for (const s of scenarios) {
    jobs.push(...planScenario(s.json, s.name, replayNowFor(s.name), MAX_CAND));
  }
  const tokList = jobs.map((j) => estTokens(j.pair.system + j.pair.user)).sort((a, b) => a - b);
  const negCount = jobs.filter((j) => j.negative).length;
  console.log(
    `剧本 ${scenarios.length} 个 → 训练批次 ${jobs.length} 个（负样本剧本批 ${negCount}）| ` +
      `样本 token 估算：p50 ${tokList[Math.floor(tokList.length / 2)]}，max ${tokList[tokList.length - 1]}`,
  );

  // 2) dryrun：样例 prompt 落 artifacts，不调 API
  if (DRY) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const j0 = jobs[0];
    if (j0) {
      const file = join(ARTIFACTS_DIR, 'sft-sample-prompt.txt');
      writeFileSync(
        file,
        [
          `# scenario=${j0.scenario} batch=${j0.batchIndex} PROMPT_VERSION=${j0.pair.prompt_version}`,
          '# ============ system ============',
          j0.pair.system,
          '# ============ user ============',
          j0.pair.user,
          '',
        ].join('\n'),
        'utf8',
      );
      console.log(`dryrun：样例 prompt 已写到 ${file}，未调用教师 API。`);
    }
    return;
  }

  // 3) 正式蒸馏
  const teacher = teacherConfig();
  console.log(`教师：${teacher.model} @ ${teacher.baseURL} | 并发 ${CONC} | confidence ≥ ${MIN_CONF}`);

  const writer = new JsonlWriter<SftRow>(join(DATA_DIR, OUT_FILE), (r) => `${r.meta.scenario}#${r.meta.batch}`);
  const rejects = new JsonlWriter<RejectRow>(
    join(DATA_DIR, REJECT_FILE),
    (r) => `${r.scenario}#${r.batch}:${r.reason.slice(0, 40)}`,
  );
  const stats = { ok: 0, rejected: 0, failed: 0, events: 0 };
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]!;
      try {
        const res = await teacherExtract(job.pair.system, job.pair.user);
        usage.add(res);
        const jsonText = stripThink(res.content);
        const parsed = parseExtraction(jsonText, new Set(job.pair.valid_ids));

        const rejectRow = (reason: string): void => {
          rejects.write({
            scenario: job.scenario,
            template: job.template,
            batch: job.batchIndex,
            prompt_version: job.pair.prompt_version,
            reason,
            raw: jsonText.slice(0, 2000),
          });
          stats.rejected++;
        };

        if (jsonText === '') {
          stats.rejected++;
          continue;
        }
        if (!parsed.ok) {
          rejectRow(`解析失败: ${parsed.error}`);
          continue;
        }
        if (parsed.events.some((ev) => ev.confidence < MIN_CONF)) {
          rejectRow(`存在 confidence < ${MIN_CONF} 的事件`);
          continue;
        }
        if (job.negative && parsed.events.length > 0) {
          rejectRow(`负样本剧本却提取出 ${parsed.events.length} 个事件`);
          continue;
        }

        const row: SftRow = {
          conversations: [
            { from: 'system', value: job.pair.system },
            { from: 'human', value: job.pair.user },
            { from: 'gpt', value: jsonText },
          ],
          meta: {
            scenario: job.scenario,
            template: job.template,
            batch: job.batchIndex,
            prompt_version: job.pair.prompt_version,
            replay_now: job.replayNow,
            teacher_model: res.model,
            n_events: parsed.events.length,
            negative: job.negative,
            est_tokens: estTokens(`${job.pair.system}${job.pair.user}${jsonText}`),
          },
        };
        if (writer.write(row)) {
          stats.ok++;
          stats.events += parsed.events.length;
        }
        if (stats.ok % 25 === 0) {
          console.log(`  … 收 ${stats.ok} / 拒 ${stats.rejected} / 错 ${stats.failed} | 事件 ${stats.events} | ${usage.text()}`);
        }
      } catch (e) {
        stats.failed++;
        usage.failures++;
        console.warn(`  ✗ ${job.scenario}#${job.batchIndex}: ${(e as Error).message}`);
      }
    }
  }
  console.log(`开始教师蒸馏：${jobs.length} 个批次，并发 ${CONC}`);
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  // 4) 汇总报告
  const rows = readJsonl<SftRow>(join(DATA_DIR, OUT_FILE));
  const withEvents = rows.filter((r) => r.meta.n_events > 0).length;
  const tokens = rows.map((r) => r.meta.est_tokens).sort((a, b) => a - b);
  const pct = (q: number): number => (tokens.length ? tokens[Math.min(tokens.length - 1, Math.floor((q / 100) * tokens.length))]! : 0);
  const ratio = (n: number): string => `${((n / Math.max(1, rows.length)) * 100).toFixed(0)}%`;
  console.log(`\n======== 蒸馏结果 ${OUT_FILE}`);
  console.log(
    `样本 ${rows.length}（本次新增 ${stats.ok}，已存在跳过 ${writer.skipped}，拒收 ${stats.rejected}，调用失败 ${stats.failed}）`,
  );
  console.log(
    `有事件批次 ${withEvents}（${(withEvents / Math.max(1, rows.length) * 100).toFixed(0)}%）| 空批次 ${rows.length - withEvents}（${((1 - withEvents / Math.max(1, rows.length)) * 100).toFixed(0)}%）`,
  );
  if (tokens.length) {
    console.log(`token：p50 ${tokens[Math.floor(tokens.length / 2)]} p90 ${pct(90)} p99 ${pct(99)} max ${tokens[tokens.length - 1]}`);
  }
  console.log(usage.text());
  if (stats.failed > 0) console.log('⚠ 有失败调用：直接重跑本命令即自动断点续跑补齐。');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
