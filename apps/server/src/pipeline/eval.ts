// C6 评测：把剧本按真实流水线跑一遍（演示回放 → 入库 → runPipelineNow → 查库），逐条对照期望打分。
// 每改一次 prompt 就跑一次（会真实调用 LLM；用 :memory: 库，不碰 data/classrep.db）：
//   pnpm --filter server exec tsx src/pipeline/eval.ts                         以当前时间跑一次
//   pnpm --filter server exec tsx src/pipeline/eval.ts --week                  从当前时间起连续 7 天各跑一次（覆盖周一到周日）
//   pnpm --filter server exec tsx src/pipeline/eval.ts --now 2026-10-02T14:00 reschedule cancel
// 有不通过的项时退出码为 1。
import { db, openDb } from '../db/index.js';
import { env } from '../env.js';
import { buildDemoMessages, listScenarios } from '../ingest/demo.js';
import { ingestMessages } from '../ingest/index.js';
import type { EventStatus, EventType, Message } from '../types.js';
import { fmtShanghai, parseTime } from './extract.js';
import { completeTimes } from './date-normalize.js';
import { runPipelineNow } from './index.js';
import { llmStats } from './stats.js';

// ---------- 上海时间的日期换算（和 prompt 里写的规则一致：每周从周一开始） ----------

const H8 = 8 * 3600_000;
const DAY = 86400_000;
const midnight = (ms: number) => Math.floor((ms + H8) / DAY) * DAY - H8;
const weekday = (ms: number) => (new Date(ms + H8).getUTCDay() + 6) % 7; // 周一=0 … 周日=6
const [MON, TUE, WED, THU, FRI, SAT, SUN] = [0, 1, 2, 3, 4, 5, 6] as const;

/** 以某条消息的发送时间为基准，算出目标日期（上海时间 0 点）；hm 是期望的时刻，用来判断「已过」 */
type Day = (sent: number, hm: string) => number;
const plusDays = (n: number): Day => (s) => midnight(s) + n * DAY;
/** 「周X / 本周X」：本周的周X，该时刻已过则下周 */
const thisWeek = (wd: number): Day => (s, hm) => {
  const d = midnight(s) + ((((wd - weekday(s)) % 7) + 7) % 7) * DAY;
  const [h, m] = hm.split(':').map(Number);
  return d + (h! * 60 + m!) * 60_000 <= s ? d + 7 * DAY : d;
};
/** 「下周X」：下一周的周X */
const nextWeek = (wd: number): Day => (s) => midnight(s) + (7 - weekday(s) + wd) * DAY;

// ---------- 每个剧本的期望 ----------

interface Expect {
  title: RegExp; // 用标题认出是哪一条
  types: EventType[];
  status: EventStatus;
  field: 'start_at' | 'deadline_at';
  msg: number; // 时间以第几条消息（从 1 数）的发送时间为基准
  day: Day;
  hm?: string; // 'HH:mm'；不给则只比日期
  location?: string;
  requires?: string[]; // action_required 里应包含的词
  minVersion?: number;
}

const EXPECT: Record<string, Expect[]> = {
  reschedule: [
    { title: /小测/, types: ['exam'], status: 'active', field: 'start_at', msg: 60, day: thisWeek(FRI), hm: '14:00', location: 'A203', minVersion: 2 },
  ],
  cancel: [
    { title: /茶话会/, types: ['activity'], status: 'cancelled', field: 'start_at', msg: 1, day: thisWeek(SAT), hm: '14:00' },
  ],
  assignment: [
    { title: /牛顿环/, types: ['assignment'], status: 'active', field: 'deadline_at', msg: 1, day: thisWeek(FRI), hm: '23:59', requires: ['原始数据', 'PDF'] },
    { title: /迈克尔逊/, types: ['assignment'], status: 'active', field: 'deadline_at', msg: 13, day: nextWeek(MON) },
    { title: /第二章|习题/, types: ['assignment'], status: 'active', field: 'deadline_at', msg: 24, day: nextWeek(WED), hm: '22:00' },
    { title: /问卷/, types: ['assignment', 'announcement', 'other'], status: 'active', field: 'deadline_at', msg: 43, day: thisWeek(SUN), hm: '22:00' },
  ],
  meeting: [
    { title: /班委会/, types: ['meeting'], status: 'active', field: 'start_at', msg: 1, day: plusDays(0), hm: '20:00', location: '3号楼201' },
  ],
  noisy: [
    { title: /选课/, types: ['announcement', 'assignment', 'other'], status: 'active', field: 'deadline_at', msg: 21, day: plusDays(1), hm: '10:00', location: undefined },
    { title: /年级大会/, types: ['meeting', 'activity'], status: 'active', field: 'start_at', msg: 82, day: nextWeek(WED), hm: '14:00', location: '大礼堂' },
  ],
  'similar-exams': [
    { title: /高数/, types: ['exam'], status: 'active', field: 'start_at', msg: 1, day: nextWeek(TUE), hm: '08:00', location: '3号楼105' },
    { title: /线代/, types: ['exam'], status: 'active', field: 'start_at', msg: 12, day: nextWeek(THU), hm: '10:00', location: '5号楼301', minVersion: 2 },
  ],
};

// ---------- 打分 ----------

interface Row {
  id: number;
  type: EventType;
  title: string;
  status: EventStatus;
  start_at: number | null;
  deadline_at: number | null;
  location: string | null;
  action_required: string | null;
  confidence: number;
  version: number;
}

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, '');
const show = (ms: number | null) => (ms == null ? 'null' : fmtShanghai(ms));

function check(name: string, msgs: Message[], rows: Row[]): string[] {
  const exps = EXPECT[name];
  if (!exps) return ['eval.ts 里没有登记这个剧本的期望'];
  const problems: string[] = [];
  const matched = new Set<number>();
  for (const x of exps) {
    const hits = rows.filter((r) => x.title.test(r.title));
    if (hits.length === 0) {
      problems.push(`缺少 /${x.title.source}/`);
      continue;
    }
    if (hits.length > 1) problems.push(`/${x.title.source}/ 有 ${hits.length} 条（应合并为 1 条）`);
    for (const h of hits) matched.add(h.id);
    const r = hits[0]!;
    const tag = `#${r.id}「${r.title}」`;
    if (!x.types.includes(r.type)) problems.push(`${tag} type=${r.type}，应为 ${x.types.join('/')}`);
    if (r.status !== x.status) problems.push(`${tag} status=${r.status}，应为 ${x.status}`);
    const wantDay = x.day(msgs[x.msg - 1]!.sent_at, x.hm ?? '23:59');
    const want = fmtShanghai(wantDay).slice(0, 10) + (x.hm ? ` ${x.hm}` : '');
    const got = r[x.field];
    if (got == null || fmtShanghai(got).slice(0, want.length) !== want) {
      problems.push(`${tag} ${x.field}=${show(got)}，应为 ${want}（星期${fmtShanghai(wantDay).slice(-1)}）`);
    }
    if (x.location && !norm(r.location).includes(norm(x.location))) {
      problems.push(`${tag} location=${r.location ?? 'null'}，应含 ${x.location}`);
    }
    for (const k of x.requires ?? []) {
      if (!(r.action_required ?? '').includes(k)) problems.push(`${tag} action_required 缺「${k}」：${r.action_required ?? 'null'}`);
    }
    if (x.minVersion && r.version < x.minVersion) problems.push(`${tag} version=${r.version}，应 ≥ ${x.minVersion}（改动没合进来）`);
  }
  for (const r of rows) if (!matched.has(r.id)) problems.push(`多余事件 #${r.id}「${r.title}」[${r.type}]`);
  return problems;
}

// ---------- 运行 ----------

const realNow = Date.now.bind(Date);

async function runOnce(now: number, names: string[]): Promise<Map<string, string[]>> {
  // 让整条流水线（回放时刻、prompt 里的当前时间、调度）都以为现在是 now
  const offset = now - realNow();
  Date.now = () => realNow() + offset;
  openDb(':memory:');

  const replayed = new Map<string, Message[]>();
  for (const name of names) {
    const msgs = buildDemoMessages(name, Date.now());
    if (!msgs) throw new Error(`剧本不存在：${name}`);
    ingestMessages(msgs, 'demo');
    replayed.set(name, msgs);
  }
  const calls = llmStats.called;
  const t0 = realNow();
  await runPipelineNow();
  console.log(
    `\n======== 当前时间 ${fmtShanghai(now)}  LLM ${llmStats.called - calls} 次 ${((realNow() - t0) / 1000).toFixed(1)}s  llm=${llmStats.llm}`,
  );

  const out = new Map<string, string[]>();
  for (const [name, msgs] of replayed) {
    const rows = db
      .prepare(
        `SELECT id, type, title, status, start_at, deadline_at, location, action_required, confidence, version
         FROM events WHERE group_id = ? ORDER BY id`,
      )
      .all(msgs[0]!.group_id) as unknown as Row[];

    // --dates：评测"代码侧日期归一化"能救回多少（默认关闭，行为与原来完全一致）。
    // 只用来源消息补/正时间字段，不改标题/类型/状态，也不改模型输出本身——
    // 因此同一批模型输出可以同时给出"模型裸分"和"模型+代码"两条臂的对比。
    let graded = rows;
    if (useDates) {
      const srcStmt = db.prepare('SELECT message_id FROM event_sources WHERE event_id = ?');
      const input = rows.map((r) => ({
        id: r.id,
        type: r.type,
        start_at: r.start_at,
        deadline_at: r.deadline_at,
        source_message_ids: (srcStmt.all(r.id) as unknown as { message_id: string }[]).map((x) => x.message_id),
      }));
      const texts = msgs.map((m) => ({ message_id: m.message_id, text: m.text }));
      const { events, filled, corrected } = completeTimes(input, texts, now, 'prefer');
      graded = rows.map((r, i) => ({
        ...r,
        start_at: events[i]!.start_at ?? null,
        deadline_at: events[i]!.deadline_at ?? null,
      }));
      console.log(`     [dates] 按来源消息补全 ${filled} 处 / 校正 ${corrected} 处`);
    }

    const problems = check(name, msgs, graded);
    out.set(name, problems);
    console.log(`${problems.length ? '❌' : '✅'} ${name}`);
    for (const p of problems) console.log(`     ${p}`);
    if (problems.length || verbose) {
      for (const r of graded) {
        console.log(
          `     · #${r.id} ${r.status} v${r.version} [${r.type}] ${r.title} | 开始 ${show(r.start_at)} | 截止 ${show(r.deadline_at)} | ${r.location ?? '-'} | 要求 ${r.action_required ?? '-'} | conf ${r.confidence}`,
        );
      }
    }
  }
  Date.now = realNow;
  return out;
}

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const verbose = flag('-v');
const useDates = flag('--dates'); // 评测"代码侧日期归一化"的增益（默认关闭）
const nowIdx = args.indexOf('--now');
const base = nowIdx >= 0 ? parseTime(args[nowIdx + 1] ?? '') : realNow();
if (Number.isNaN(base)) throw new Error('--now 的格式：2026-10-02T14:00');
const picked = args.filter((a, i) => !a.startsWith('-') && i !== nowIdx + 1);
const names = picked.length ? picked : listScenarios().map((s) => s.name);

if (!env.LLM_API_KEY) {
  console.error('没有配置 LLM_API_KEY（仓库根目录 .env），评测需要真实调用 LLM');
  process.exit(2);
}

const runs = flag('--week') ? Array.from({ length: 7 }, (_, i) => base + i * DAY) : [base];
const results: Map<string, string[]>[] = [];
for (const now of runs) results.push(await runOnce(now, names));

if (runs.length > 1) {
  console.log(`\n======== 汇总\n${'剧本'.padEnd(16)}${runs.map((t) => `周${fmtShanghai(t).slice(-1)}`).join(' ')}`);
  for (const name of names) {
    console.log(`${name.padEnd(16)}${results.map((r) => (r.get(name)!.length ? ' ❌' : ' ✅')).join('  ')}`);
  }
}
const failed = results.reduce((n, r) => n + [...r.values()].filter((p) => p.length).length, 0);
console.log(`\n${failed ? `❌ ${failed} 项不通过` : '✅ 全部通过'}（${runs.length} 个时间点 × ${names.length} 个剧本）`);
process.exit(failed ? 1 : 0);
