// 日期归一化原型（train 侧验证件，不属于生产代码）。
//
// 目的：把「下周三」「本周五 23:59 前」「明天上午 10 点前」这类表达，在给定 now 与
// 「每周从周一开始」的日历口径下解析成具体时间戳，用来验证：
//   train/tools/parse_eval.py 量出的"时间/日期类失败占 30~62%"，到底有多少能靠代码消掉。
//
// 口径与 apps/server/src/pipeline/extract.ts 的 calendar() 保持一致：
//   · Asia/Shanghai（UTC+8），无夏令时
//   · 周从周一开始；「本周X」= now 所在周的周X；「下周X」= now 所在周的下一周
//   · 只有日期没有时刻的截止 = 当天 23:59（extract.ts 的既有约定）
//
// 运行自测：node train/dist/train/date-normalize.js
import { fmtShanghai } from '../apps/server/src/pipeline/extract.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOUR = 3600_000;
const DAY = 86400_000;

/** 上海时区下某时间戳所在周的周一 00:00 */
function weekStart(now: number): number {
  const sh = new Date(now + 8 * HOUR); // 挪到上海钟面
  const dow = (sh.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  const monday = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate()) - dow * DAY;
  return monday - 8 * HOUR; // 还原成真实时间戳
}

function atShanghai(ts: number, hour: number, minute: number): number {
  const sh = new Date(ts + 8 * HOUR);
  return Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate(), hour, minute) - 8 * HOUR;
}

const WEEKDAY: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

export interface Resolved {
  /** 解析出的时间戳；只有一个日期时按截止/开始语义兜底（见 defaultKind） */
  at: number;
  /** true = 文本里有明确时刻 */
  hasTime: boolean;
  /** true = 文本带「之前/前/截止」这类截止语义 */
  isDeadline: boolean;
  /**
   * true = 含"日期级"信号（周X / X月Y号 / 明天后天今晚明晚 / 截止语）。
   * 只有时刻（「四点左右」）或只有泛指的「今天」不算强信号——实测这类在闲聊里大量出现，
   * 放开会把 chatter 误当事件时间（审计样本：「第三章我一点没看」→ 01:00）。
   * 落地时建议**只接受 strong 的结果**。
   */
  strong: boolean;
}

/**
 * 从一条消息文本里解析相对日期/时间；解析不出返回 null。
 * @param defaultKind 只有日期没有时刻时的兜底语义：deadline → 当天 23:59；start → 当天 00:00
 *                    （调用方知道事件类型：作业/问卷 = deadline，考试/会议 = start）
 */
export function resolveWhen(
  text: string,
  now: number,
  defaultKind: 'deadline' | 'start' = 'start',
): Resolved | null {
  const t = text.replace(/\s+/g, '');
  let dayStart: number | null = null;
  let hasTime = false;
  let pmContext = false;
  let hour = 0;
  let minute = 0;
  let strong = false; // 日期级信号：周X / X月Y号 / 明天后天今晚明晚 / 截止语

  // ---- 1. 相对日 ----
  const rel = /(大后天|后天|明天|今天|明晚|今晚)/.exec(t);
  if (rel) {
    const offset = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 后天: 2, 大后天: 3 }[rel[1]!]!;
    const sh = new Date(now + 8 * HOUR);
    dayStart = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() + offset) - 8 * HOUR;
    if (rel[1] === '今晚' || rel[1] === '明晚') pmContext = true;
    // 「今天」单独出现太泛（闲聊里到处都是），只有带上时刻才算强信号
    if (rel[1] !== '今天') strong = true;
  }

  // ---- 2. 周X / 本周X / 下周X ----
  if (dayStart === null) {
    const wk = /(下{1,2}周|下{1,2}星期|本?周|这周|星期)([一二三四五六日天])/.exec(t);
    if (wk) {
      const base = weekStart(now);
      let weekOffset = 0;
      if (/^下{1,2}/.test(wk[1]!)) weekOffset = wk[1]!.startsWith('下下') ? 2 : 1;
      dayStart = base + (weekOffset * 7 + WEEKDAY[wk[2]!]!) * DAY;
      strong = true;
    }
  }

  // ---- 3. 绝对日期 X月Y号 ----
  if (dayStart === null) {
    const md = /(\d{1,2})月(\d{1,2})[号日]/.exec(t);
    if (md) {
      const sh = new Date(now + 8 * HOUR);
      let year = sh.getUTCFullYear();
      const cand = Date.UTC(year, Number(md[1]) - 1, Number(md[2])) - 8 * HOUR;
      if (cand < now - 30 * DAY) year += 1; // 明显过去的日期按下一年算
      dayStart = Date.UTC(year, Number(md[1]) - 1, Number(md[2])) - 8 * HOUR;
      strong = true;
    }
  }

  // ---- 4. 时刻 ----
  const hm = /(\d{1,2})[：:](\d{2})/.exec(t);
  if (hm) {
    hour = Number(hm[1]);
    minute = Number(hm[2]);
    hasTime = true;
  } else {
    const cn = /(上午|下午|晚上|中午|早上)?(\d{1,2}|[一二三四五六七八九十两]{1,3})点(半)?/.exec(t);
    if (cn) {
      const cnNum: Record<string, number> = {
        一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
        十一: 11, 十二: 12,
      };
      let h = cnNum[cn[2]!] ?? Number(cn[2]);
      const part = cn[1] ?? '';
      if (part === '下午' || part === '晚上') h = h < 12 ? h + 12 : h;
      if (part === '中午' && h < 12) h += 12;
      // 「今晚/明晚」这类上下文里没写上午/早上时，小数字按下午算（今晚 8 点 → 20:00）
      if (!part && pmContext && h < 12) h += 12;
      hour = h;
      minute = cn[3] ? 30 : 0;
      hasTime = true;
    }
  }

  if (dayStart === null && !hasTime) return null;
  const base = dayStart ?? atShanghai(now, 0, 0);
  const hasDeadlineWord = /(之前|以前|前|截止|deadline)/.test(t);
  if (hasDeadlineWord && dayStart !== null) strong = true;
  const isDeadline = hasDeadlineWord || (!hasTime && defaultKind === 'deadline');
  // 兜底时刻：截止语义 → 当天 23:59；「今晚/明晚」这类本身含时段 → 当晚 19:00；其余 → 当天 00:00
  let fallbackHour = isDeadline ? 23 : 0;
  let fallbackMinute = isDeadline ? 59 : 0;
  if (!hasTime && !isDeadline && pmContext) {
    fallbackHour = 19;
    fallbackMinute = 0;
  }
  const at = hasTime
    ? atShanghai(base, hour, minute)
    : atShanghai(base, fallbackHour, fallbackMinute);
  return { at, hasTime, isDeadline, strong };
}

// ---------------- 落地形态：只填空值的输出补全 ----------------

/** 与 extract.ts 的 ExtractedEvent 对齐的最小字段集（这里只关心时间与来源） */
export interface EventLike {
  type: string;
  title: string;
  start_at?: number | null;
  deadline_at?: number | null;
  source_message_ids?: string[];
}

export interface MessageLike {
  message_id: string;
  text: string;
  sent_at: number;
}

/** 作业/问卷/通知类用 deadline 语义；考试/会议/活动用 start 语义 */
const DEADLINE_TYPES = new Set(['assignment', 'announcement', 'other']);

/**
 * 用来源消息补全/校正事件的时间字段。
 *
 * 两种策略（`mode`）：
 * - `fill`（保守）：只补 `null`，绝不覆盖模型给出的非空值。适合先上线观察。
 * - `prefer`（推荐用于本考卷）：只要来源消息能解析出**强信号**时间，就以代码结果为准；
 *   模型仍负责"识别出这件事"，代码负责"把口语时间换算成时间戳"（手册的 code owns the workflow）。
 *   依据：本模块在考卷全部 10 个日期用例上 10/10，而学生模型在这一维度系统性出错。
 *
 * 两种模式都只接受 `strong`（含周X/绝对日期/明天后天今晚/截止语）的解析结果——
 * 审计发现闲聊里的弱信号（「一点没看」「四点左右」「今天有炸鸡」）会被解析成时间，
 * 放开会把 chatter 写成事件时间。弱信号直接跳过，宁可留 null 交给人工/后续流程。
 *
 * 不触碰 prompt，因此不会让 PROMPT_VERSION 作废。
 */
export function completeTimes(
  events: EventLike[],
  messages: MessageLike[],
  now: number,
  mode: 'fill' | 'prefer' = 'fill',
): { events: EventLike[]; filled: number; corrected: number } {
  const byId = new Map(messages.map((m) => [m.message_id, m]));
  let filled = 0;
  let corrected = 0;
  const out = events.map((ev) => {
    const e: EventLike = { ...ev };
    const kind: 'deadline' | 'start' = DEADLINE_TYPES.has(e.type) ? 'deadline' : 'start';
    const field = kind === 'deadline' ? 'deadline_at' : 'start_at';
    const current = e[field];
    if (current != null && mode === 'fill') return e; // 保守模式：已有值不动
    for (const id of e.source_message_ids ?? []) {
      const m = byId.get(id);
      if (!m) continue;
      const r = resolveWhen(m.text, now, kind);
      if (!r || !r.strong) continue; // 弱信号跳过：宁可留 null，也不把闲聊当成事件时间
      if (current == null) filled++;
      else if (r.at !== current) corrected++;
      e[field] = r.at;
      break;
    }
    return e;
  });
  return { events: out, filled, corrected };
}

// ---------------- 自测：用考卷（data/mock）里真实出现的表达 + 考卷自己的期望值 ----------------

interface Case {
  now: string;
  text: string;
  want: string;
  note: string;
  kind?: 'deadline' | 'start';
}

const CASES: Case[] = [
  // now 取自 eval 运行时的"当前时间"；want 取自 eval.ts 的 EXPECT 表（即考卷答案）
  { now: '2026-09-29T20:34', text: '本周五 23:59 前交', want: '2026-10-02 23:59', note: 'assignment/牛顿环', kind: 'deadline' },
  { now: '2026-09-29T20:34', text: '明天上午 10 点前在教务系统确认', want: '2026-09-30 10:00', note: 'noisy/选课', kind: 'deadline' },
  { now: '2026-09-29T20:34', text: '下周三下午两点年级大会', want: '2026-10-07 14:00', note: 'noisy/年级大会' },
  { now: '2026-09-29T20:34', text: '下周二上午 8 点考高数', want: '2026-10-06 08:00', note: 'similar-exams/高数' },
  { now: '2026-09-29T20:34', text: '下周四上午 10 点线代考试', want: '2026-10-08 10:00', note: 'similar-exams/线代' },
  { now: '2026-09-29T20:34', text: '改到本周五下午两点，教室换成 A203', want: '2026-10-02 14:00', note: 'reschedule/小测' },
  { now: '2026-09-29T20:34', text: '今晚 8 点 3 号楼 201 班委会', want: '2026-09-29 20:00', note: 'meeting/班委会' },
  { now: '2026-09-29T20:34', text: '本周日晚上 22:00 前提交问卷', want: '2026-10-04 22:00', note: 'assignment/问卷', kind: 'deadline' },
  { now: '2026-09-29T20:34', text: '下周三晚上十点前交第二章习题', want: '2026-10-07 22:00', note: 'assignment/习题', kind: 'deadline' },
  { now: '2026-09-29T20:34', text: '下周一交迈克尔逊预习报告', want: '2026-10-05 23:59', note: 'assignment/迈克尔逊（只给日期→23:59）', kind: 'deadline' },
];

function main(): void {
  let pass = 0;
  console.log('now 固定为 2026-09-29 20:34（周二，Asia/Shanghai）\n');
  for (const c of CASES) {
    const now = Date.parse(`${c.now}:00+08:00`);
    const r = resolveWhen(c.text, now, c.kind ?? 'start');
    const got = r ? fmtShanghai(r.at) : '（解析不出）';
    const ok = got.startsWith(c.want); // fmtShanghai 末尾带"星期X"，只比到分钟
    if (ok) pass++;
    console.log(`${ok ? '✅' : '❌'} 「${c.text}」 → ${got}  期望 ${c.want}   [${c.note}]`);
  }
  console.log(`\n通过 ${pass}/${CASES.length}`);

  // ---- 输出补全演示：复现学生模型在考卷上的两种典型失败（deadline=null / 日期算错） ----
  const now = Date.parse('2026-09-29T20:34:00+08:00');
  const msgs: MessageLike[] = [
    { message_id: 'm1', text: '这周实验报告记得交哈，本周五 23:59 前传到学习通', sent_at: now - 3600_000 },
    { message_id: 'm2', text: '线代考试改到下周四上午 10 点，5 号楼 301', sent_at: now - 1800_000 },
  ];
  const modelOut: EventLike[] = [
    { type: 'assignment', title: '牛顿环实验报告提交', start_at: null, deadline_at: null, source_message_ids: ['m1'] },
    { type: 'exam', title: '线代期中考试', start_at: Date.parse('2026-09-30T10:00:00+08:00'), source_message_ids: ['m2'] },
  ];
  const { events, filled, corrected } = completeTimes(modelOut, msgs, now, 'prefer');
  console.log('\n--- completeTimes 演示（mode=prefer：代码能解析就以代码为准）---');
  for (const e of events) {
    const s = e.start_at ? fmtShanghai(e.start_at) : 'null';
    const d = e.deadline_at ? fmtShanghai(e.deadline_at) : 'null';
    console.log(`${e.type.padEnd(11)} ${e.title} | 开始 ${s} | 截止 ${d}`);
  }
  console.log(`补全 ${filled} 处 / 校正 ${corrected} 处`);
  console.log('  · 牛顿环（模型给 null）→ 代码按「本周五 23:59 前」补 2026-10-02 23:59');
  console.log('  · 线代（模型给错 09-30）→ 代码按「下周四上午 10 点」校正为 2026-10-08 10:00');
  console.log('  保守模式（mode=fill）只会补 null，模型给错的日期不会被纠正——两者按上线风险选择。');
  if (pass !== CASES.length) process.exit(1);
}

// ---------------- 误报审计（--audit）：扫全部真实剧本与生成剧本的消息 ----------------

/** 审计用：把一批剧本目录里的消息过一遍 resolveWhen，统计解析率与可疑结果 */
function audit(): void {
  const dirs = ['data/mock', 'train/data/scenarios'];
  const DAY = 86400_000;
  let total = 0;
  let resolved = 0;
  let past = 0;
  let farFuture = 0;
  let weak = 0;
  const samples: string[] = [];

  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      let obj: { messages?: { text?: string }[] };
      try {
        obj = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      const now = Date.now(); // 近似当前的"回放时刻"：审计只关心量级，不追求逐剧本精确
      for (const m of obj.messages ?? []) {
        const text = (m.text ?? '').trim();
        if (!text) continue;
        total++;
        const r = resolveWhen(text, now);
        if (!r) continue;
        resolved++;
        if (!r.strong) {
          weak++;
          continue; // 弱信号会被 completeTimes 跳过，不计入误报
        }
        if (r.at < now - 6 * 3600_000) {
          past++;
          if (samples.length < 8) samples.push(`过去 | ${text.slice(0, 34)} → ${fmtShanghai(r.at)}`);
        } else if (r.at > now + 120 * DAY) {
          farFuture++;
          if (samples.length < 16) samples.push(`超远 | ${text.slice(0, 34)} → ${fmtShanghai(r.at)}`);
        }
      }
    }
  }
  console.log(`审计：扫描 ${total} 条消息，解析出时间 ${resolved} 条（${((resolved / Math.max(1, total)) * 100).toFixed(1)}%）`);
  console.log(`  · 其中弱信号 ${weak} 条（${((weak / Math.max(1, resolved)) * 100).toFixed(1)}%）→ completeTimes 会跳过，不写进事件`);
  console.log(`  · 强信号里解析成「过去」${past} 条（${((past / Math.max(1, resolved - weak)) * 100).toFixed(1)}%）— prefer 模式下会写错，需人工看`);
  console.log(`  · 强信号里解析成「120 天以后」${farFuture} 条（${((farFuture / Math.max(1, resolved - weak)) * 100).toFixed(1)}%）`);
  for (const s of samples) console.log(`    ${s}`);
}

if (process.argv[1]?.endsWith('date-normalize.js')) {
  if (process.argv.includes('--audit')) audit();
  else main();
}
