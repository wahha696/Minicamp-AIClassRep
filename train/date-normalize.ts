// train 侧的日期模块"试验台"：实现只有一份 —— 生产代码 apps/server/src/pipeline/date-normalize.ts。
// 这里只做两件事：
//   1) 转出生产实现（避免两边漂移：此前 train 侧有一份副本，改一处忘另一处就会不一致）
//   2) 提供离线自测与误报审计 CLI（都不需要 GPU/API）
//
// 运行：
//   node train/dist/train/date-normalize.js            # 自测（考卷 10 例 + 跨周边界 + 策略演示）
//   node train/dist/train/date-normalize.js --audit     # 扫全部剧本消息，统计解析率与弱信号占比
import { resolveWhen, completeTimes } from '../apps/server/src/pipeline/date-normalize.js';
import { fmtShanghai } from '../apps/server/src/pipeline/extract.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export { resolveWhen, completeTimes };

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
  // 跨周边界（与 extract.ts 的 calendar() 同口径：每周从周一开始）
  { now: '2026-09-28T00:30', text: '本周五下午三点开班会', want: '2026-10-02 15:00', note: '周一凌晨：本周 = 09-28 起' },
  { now: '2026-10-04T23:50', text: '本周一交的作业还没改', want: '2026-09-28 00:00', note: '周日深夜：本周一仍是 09-28' },
  { now: '2026-10-04T23:50', text: '下周一上午九点年级大会', want: '2026-10-05 09:00', note: '周日深夜：下周一 = 次日' },
  { now: '2026-10-04T23:50', text: '明天上午九点年级大会', want: '2026-10-05 09:00', note: '相对日与下周一致（互校）' },
];

function main(): void {
  let pass = 0;
  console.log('now 固定为 2026-09-29 20:34（周二，Asia/Shanghai）\n');
  for (const c of CASES) {
    const now = Date.parse(`${c.now}:00+08:00`);
    const r = resolveWhen(c.text, now, c.kind ?? 'start');
    const got = r ? fmtShanghai(r.at) : '（解析不出）';
    const ok = got.startsWith(c.want);
    if (ok) pass++;
    console.log(`${ok ? '✅' : '❌'} 「${c.text}」 → ${got}  期望 ${c.want}   [${c.note}]`);
  }
  console.log(`\n通过 ${pass}/${CASES.length}`);

  const now = Date.parse('2026-09-29T20:34:00+08:00');
  const msgs = [
    { message_id: 'm1', text: '这周实验报告记得交哈，本周五 23:59 前传到学习通' },
    { message_id: 'm2', text: '线代考试改到下周四上午 10 点，5 号楼 301' },
  ];
  const modelOut = [
    { type: 'assignment', start_at: null, deadline_at: null, source_message_ids: ['m1'] },
    { type: 'exam', start_at: Date.parse('2026-09-30T10:00:00+08:00'), deadline_at: null, source_message_ids: ['m2'] },
  ];
  const { events, filled, corrected } = completeTimes(modelOut, msgs, now, 'prefer');
  console.log('\n--- completeTimes 演示（mode=prefer：代码能解析就以代码为准）---');
  for (const e of events) {
    console.log(`${e.type.padEnd(11)} | 开始 ${e.start_at ? fmtShanghai(e.start_at) : 'null'} | 截止 ${e.deadline_at ? fmtShanghai(e.deadline_at) : 'null'}`);
  }
  console.log(`补全 ${filled} 处 / 校正 ${corrected} 处`);
  console.log('  · 牛顿环（模型给 null）→ 代码按「本周五 23:59 前」补 2026-10-02 23:59');
  console.log('  · 线代（模型给错 09-30）→ 代码按「下周四上午 10 点」校正为 2026-10-08 10:00');
  console.log('  保守模式（mode=fill）只会补 null，模型给错的日期不会被纠正——两者按上线风险选择。');
  if (pass !== CASES.length) process.exit(1);
}

// ---------------- 误报审计（--audit）：扫全部真实剧本与生成剧本的消息 ----------------

function audit(): void {
  const dirs = ['data/mock', 'train/data/scenarios'];
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
      const now = Date.now();
      for (const m of obj.messages ?? []) {
        const text = (m.text ?? '').trim();
        if (!text) continue;
        total++;
        const r = resolveWhen(text, now);
        if (!r) continue;
        resolved++;
        if (!r.strong) {
          weak++;
          continue;
        }
        if (r.at < now - 6 * 3600_000) {
          past++;
          if (samples.length < 8) samples.push(`过去 | ${text.slice(0, 34)} → ${fmtShanghai(r.at)}`);
        } else if (r.at > now + 120 * 86400_000) {
          farFuture++;
          if (samples.length < 16) samples.push(`超远 | ${text.slice(0, 34)} → ${fmtShanghai(r.at)}`);
        }
      }
    }
  }
  const strong = Math.max(1, resolved - weak);
  console.log(`审计：扫描 ${total} 条消息，解析出时间 ${resolved} 条（${((resolved / Math.max(1, total)) * 100).toFixed(1)}%）`);
  console.log(`  · 其中弱信号 ${weak} 条（${((weak / Math.max(1, resolved)) * 100).toFixed(1)}%）→ completeTimes 会跳过，不写进事件`);
  console.log(`  · 强信号里解析成「过去」${past} 条（${((past / strong) * 100).toFixed(1)}%）— prefer 模式下会写错，需人工看`);
  console.log(`  · 强信号里解析成「120 天以后」${farFuture} 条（${((farFuture / strong) * 100).toFixed(1)}%）`);
  for (const s of samples) console.log(`    ${s}`);
}

if (process.argv[1]?.endsWith('date-normalize.js')) {
  if (process.argv.includes('--audit')) audit();
  else main();
}
