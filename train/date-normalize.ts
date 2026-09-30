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

  // ---- 1. 相对日 ----
  const rel = /(大后天|后天|明天|今天|明晚|今晚)/.exec(t);
  if (rel) {
    const offset = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 后天: 2, 大后天: 3 }[rel[1]!]!;
    const sh = new Date(now + 8 * HOUR);
    dayStart = Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() + offset) - 8 * HOUR;
    if (rel[1] === '今晚' || rel[1] === '明晚') pmContext = true;
  }

  // ---- 2. 周X / 本周X / 下周X ----
  if (dayStart === null) {
    const wk = /(下{1,2}周|下{1,2}星期|本?周|这周|星期)([一二三四五六日天])/.exec(t);
    if (wk) {
      const base = weekStart(now);
      let weekOffset = 0;
      if (/^下{1,2}/.test(wk[1]!)) weekOffset = wk[1]!.startsWith('下下') ? 2 : 1;
      dayStart = base + (weekOffset * 7 + WEEKDAY[wk[2]!]!) * DAY;
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
  const isDeadline = /(之前|以前|前|截止|deadline)/.test(t) || (!hasTime && defaultKind === 'deadline');
  const at = hasTime
    ? atShanghai(base, hour, minute)
    : atShanghai(base, isDeadline ? 23 : 0, isDeadline ? 59 : 0);
  return { at, hasTime, isDeadline };
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
  if (pass !== CASES.length) process.exit(1);
}

if (process.argv[1]?.endsWith('date-normalize.js')) main();
