// 手动验收 C3：把一个剧本按调度器的方式分批喂给 LLM，打印提取结果。
//   pnpm --filter server exec tsx src/pipeline/try-extract.ts reschedule
// 不碰数据库：已有事件用内存里一个极简的 reconcile 模拟，好让后面批次的改期 / 取消能对上 id。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOCK_DIR } from '../paths.js';
import type { EventType, Message } from '../types.js';
import { type ActiveEventBrief, extractEvents, fmtShanghai } from './extract.js';
import { isNoise } from './filter.js';
import { llmStats } from './stats.js';

interface Scenario {
  title: string;
  group: { id: string; name: string };
  messages: { offset_minutes: number; sender: string; text: string }[];
}

const BATCH = 30;
const CONTEXT = 10;

const name = process.argv[2] ?? 'reschedule';
const sc = JSON.parse(readFileSync(join(MOCK_DIR, `${name}.json`), 'utf8')) as Scenario;
const now = Date.now();
const msgs: Message[] = sc.messages.map((m, i) => ({
  message_id: `demo-${name}-${i + 1}`,
  group_id: sc.group.id,
  group_name: sc.group.name,
  sender_name: m.sender,
  text: m.text,
  sent_at: now + m.offset_minutes * 60_000,
}));

const t = (ms: number | null) => (ms == null ? '-' : fmtShanghai(ms));
const events: (ActiveEventBrief & { status: string; version: number })[] = [];
let nextId = 1;

console.log(`剧本：${sc.title}（${msgs.length} 条）  当前时间：${fmtShanghai(now)}\n`);

for (let i = 0; i < msgs.length; i += BATCH) {
  const batch = msgs.slice(i, i + BATCH);
  const candidates = batch.filter((m) => !isNoise(m.text));
  console.log(`== 批次 ${i / BATCH + 1}：${batch.length} 条，过滤后 ${candidates.length} 条`);
  if (candidates.length === 0) continue;

  const out = await extractEvents({
    groupId: sc.group.id,
    groupName: sc.group.name,
    candidates,
    context: msgs.slice(Math.max(0, i - CONTEXT), i),
    now,
    activeEvents: events.filter((e) => e.status === 'active'),
  });

  for (const ev of out) {
    console.log(
      `  ${ev.action}${ev.update_of != null ? ` #${ev.update_of}` : ''} [${ev.type}] ${ev.title}  ` +
        `开始 ${t(ev.start_at)} | 截止 ${t(ev.deadline_at)} | 地点 ${ev.location ?? '-'} | ` +
        `要求 ${ev.action_required ?? '-'} | conf ${ev.confidence} | 来源 ${ev.source_message_ids.join(',')}`,
    );
    const target = events.find((e) => e.id === ev.update_of && e.status === 'active');
    if (target && ev.action === 'cancel') {
      target.status = 'cancelled';
    } else if (target && ev.action === 'update') {
      if (ev.title) target.title = ev.title;
      target.start_at = ev.start_at ?? target.start_at;
      target.end_at = ev.end_at ?? target.end_at;
      target.deadline_at = ev.deadline_at ?? target.deadline_at;
      target.location = ev.location ?? target.location;
      target.action_required = ev.action_required ?? target.action_required;
      target.version++;
    } else {
      events.push({
        id: nextId++,
        type: ev.type as EventType,
        title: ev.title,
        start_at: ev.start_at,
        end_at: ev.end_at,
        deadline_at: ev.deadline_at,
        location: ev.location,
        action_required: ev.action_required,
        level: ev.level ?? 2,
        status: 'active',
        version: 1,
      });
    }
  }
}

console.log(`\n== 最终事件（llm=${llmStats.llm}，调用 ${llmStats.called} 次）`);
for (const e of events) {
  console.log(
    `  #${e.id} ${e.status} v${e.version} [${e.type}] ${e.title}  开始 ${t(e.start_at)} | 截止 ${t(e.deadline_at)} | 地点 ${e.location ?? '-'}`,
  );
}
