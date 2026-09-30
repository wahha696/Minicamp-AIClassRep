// 合成剧本生成器（操作手册 §2.1：教师模型按模板造「群聊剧本 + 期望事件」，不占 GPU）。
//   node train/dist/train/gen-scenarios.js --n 60 --template exam --seed 7
//   node train/dist/train/gen-scenarios.js --n 200 --concurrency 3        # 按配额全模板混合
//
// 产出 train/data/scenarios/<tpl>-<seed36>.json（与 data/mock/*.json 同构 + expected 质检字段）。
// 铁律：训练剧本只放 train/data/scenarios/，与 data/mock/（eval 考卷）物理隔离。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIO_DIR } from './lib/paths.js';
import { generate, parseLooseJson, usage } from './lib/teacher.js';
import type { ExpectedEventJson, InitialEventJson, ScenarioJson, ScenarioMessageJson } from './lib/prompts.js';

// ---------- 多样性语料 ----------

const GROUPS = [
  '2023级计算机学院年级群', '计科2301班', '软工2302通知群', '高数(下)课程群', '数据结构课程群',
  '大学英语IV学习群', '计算机网络课程群', '电子信息2303班', '物联2201班群', '2023级毕设交流群',
  '班委群', '概率论与数理统计A课程群',
];

const COURSES = [
  '高等数学', '线性代数', '概率论与数理统计', '数据结构', '操作系统', '计算机网络',
  '大学英语', '大学物理', '中国近现代史纲要', '体育', '程序设计基础', '数据库原理',
];

const TEACHERS = ['张老师', '李老师', '辅导员王老师', '辅导员陈老师', '教务处刘老师', '班主任赵老师'];

const CHAT_TOPICS = [
  '食堂哪个窗口好吃', '昨晚的游戏', '宿舍空调', '图书馆占座', '快递到了没拿', '周末去哪玩',
  '健身房办卡', '外卖满减拼单', '二手自行车', '校园卡丢了', '考研还是就业', '美剧追更',
];

const VAGUE_PROPOSALS = [
  '晚上约饭吗', '有人开黑吗', '周末有人去打球吗', '改天一起自习?', '谁要拼车去高铁站',
  '下午有人拼奶茶吗', '有人想一起去图书馆吗', '晚上去看电影吗', '要不哪天聚一聚',
];

// ---------- 模板库（对照手册 §2.1 数据配方：改期/取消/多事件/负样本/边界） ----------

interface Template {
  /** 教师生成剧本的设定文本 */
  brief: string;
  /** expected 事件数量区间（质检用；负样本为 [0,0]） */
  expected: [number, number];
  negative?: boolean;
  initial?: boolean;
}

const TEMPLATES: Record<string, Template> = {
  exam: {
    brief: '一场考试/小测/机考的通知：科目、日期时间（口语化表述）、教室、要带的东西（学生证/计算器/2B铅笔）。偶尔出现两场不同的考试。至少 6 条闲聊把通知打断。',
    expected: [1, 2],
  },
  assignment: {
    brief: '作业/实验报告/问卷/提交截止类通知：课程、提交方式（学习通/邮箱/纸质交）、截止时间（「下周三之前」「10 月 16 号」「明晚 10 点前」等表述）、格式要求（PDF、命名规范、附原始数据）。至少两份不同作业穿插出现。',
    expected: [1, 3],
  },
  activity: {
    brief: '说定了具体时间或日期的集体活动：班级聚餐、打球、开黑比赛、春游、班级合影。**必须出现确定的时间或日期**（如「周六晚 7 点北门」「周五早上 6:00 校门口集合」）；同时混入没有说定时间的随口提议（「晚上约饭吗」→ 大家回「好呀」但没人定时间 → 不算事件）做对照。',
    expected: [1, 3],
  },
  meeting: {
    brief: '班委会/组会/年级大会通知：具体时间、地点（3号楼201 / 大礼堂 / 腾讯会议号）、参会人、要带的东西或议题。可混一条无关闲聊线。',
    expected: [1, 2],
  },
  announcement: {
    brief: '需要行动但常无精确时刻的通知：选课确认、缴费、填表、注册、材料提交，通常有「X 月 X 日前」「明天 10 点前」这样的截止。',
    expected: [1, 2],
  },
  reschedule: {
    brief: '改期链：initial_events 里有一场考试/会议/活动，之后 2~3 条消息逐步改动它（「周六有事改到周日」「时间不变换个教室」「补充：记得带计算器」）。expected 里最终只留一个按最新信息填的 update（update_of=原 id），不许输出成 create。',
    expected: [1, 2],
    initial: true,
  },
  cancel: {
    brief: '取消：initial_events 里的原事件后来被明确取消（「取消」「不办了」「延期到下学期」）。expected 里该事件 action=cancel、update_of=原 id。混入一件没被取消的其它事项当干扰。',
    expected: [1, 2],
    initial: true,
  },
  multi: {
    brief: '多事件交织：3~5 个不同类型事项（作业+小测+活动+通知）散布在大量闲聊之间，彼此无关、时间各不相同、可能互相干扰（两个都提到「周四」）。闲聊至少 8 条。',
    expected: [3, 5],
  },
  backfill: {
    brief: '历史补齐：前 1/3 的消息 offset_minutes 在 -2880~-1400（一两天前的旧消息），其中一两个事项已建立过（放 initial_events）；后面的新消息里既有「对已有事件的重复提醒」（不要输出）也有真正的新事项（照常 create）。',
    expected: [1, 3],
    initial: true,
  },
  near_miss: {
    brief: '近似事件混淆：两件事名字接近但完全不同（「高数期中」vs「高数期末」、「线代期中」vs「线代习题课」），时间地点不同；另安排一条对第一件事的纯重复提醒（不要输出第二次）。',
    expected: [2, 2],
  },
  chat: {
    brief: '纯闲聊刷屏：表情包、附和、吐槽、拼外卖、二手买卖、失物招领、游戏。**绝不能出现任何说定时间的行动事项**；可以有「晚上约饭吗」「有人开黑吗」这类没说定时间的随口提议（有人回应但始终没人定时间）——它们不算事项。',
    expected: [0, 0],
    negative: true,
  },
};

const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** 生成剧本的用户指令骨架 */
const SPEC_HEADER = `你是一个大学班级群聊剧本作家，为「AI 课代表」项目造训练数据。写一个仿真 QQ 班级群聊天记录，只输出一个 JSON 对象：
{"group_name": "群名", "initial_events": [...], "messages": [...], "expected": [...]}

硬性格式：
- messages：50~70 条，元素 {"offset_minutes": 整数(≤0，历史消息可到 -2880), "sender": "中文昵称", "text": "消息"}，按时间递增（分钟可重复）；至少 12 个不同昵称；正式通知由老师/辅导员发。
- text：自然口语；可穿插 [图片]/[表情]/[转发]/[语音] 占位符（每种全文 ≤3 次）；有附和与跑题；事项信息拆散在多条消息、被闲聊打断，不要一条长消息说完所有字段。
- 时间表述口语化且多样：相对时间（今天/明天/今晚/下周三/这周五）、绝对日期（10 月 16 号）、时刻（下午两点/19:00）；只有日期没有时刻的截止默认当天 23:59。
- initial_events：改期/取消/历史类剧本必填——日历里已有的事件，id 从 100 递增，字段 {"id":100,"type":"exam|assignment|meeting|activity|announcement|other","title":"...","when":"YYYY-MM-DD HH:mm","location":"...或null","level":1~4}。
- expected：验收答案。每个要提取的事件一行 {"action":"create|update|cancel","type":"...","title":"...","when":"一句话（如 下周五 14:00）","update_of":原id或null,"location":null}；纯闲聊剧本 expected=[]；只有 update/cancel 给 update_of。
- 禁止在 text 里出现 JSON、代码块、网址。

真实感硬要求（这三个比例会与线上真实数据对齐，偏离太多视为不合格）：
- **闲聊占比 ≥75%**：绝大多数消息是「哈哈哈哈」「收到」「几点？」「我也去」「+1」「？？」这类**≤10 字**的短句；
  真正承载事项信息的消息**不超过 6 条**。
- **提到时间/日期的消息 ≤10%**：闲聊里不要出现时间；时间只在承载事项的那几条里说。
- **单条 text 多数 ≤10 字，最长 ≤40 字**：像真人打字（口语、可带错别字/表情/缩写/重复），
  不要写成公告体——「下周三前交哈」而不是「请于下周三前提交」；通知也拆成多条短消息夹在闲聊里。
`;

// ---------- 随机要素 ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

/** 每次生成的随机设定（多样性来源：群名 / 课程 / 通知角色 / 闲聊话题） */
function seedInstruction(rng: () => number): string {
  return [
    `群名就用：${pick(rng, GROUPS)}`,
    `主事项围绕课程「${pick(rng, COURSES)}」（也可以是班级事务）`,
    `发通知的角色：${pick(rng, TEACHERS)}`,
    `闲聊话题（挑 2~3 个铺开）：${pick(rng, CHAT_TOPICS)}、${pick(rng, CHAT_TOPICS)}`,
    `可穿插一条没说定时间的随口提议（不算事项）：「${pick(rng, VAGUE_PROPOSALS)}」`,
  ].join('\n');
}

// ---------- 教师生成 + 归一化校验 ----------

const VALID_TYPES = new Set(['exam', 'assignment', 'meeting', 'activity', 'announcement', 'other']);

interface RawScenario {
  group_name?: unknown;
  initial_events?: unknown;
  messages?: unknown;
  expected?: unknown;
}

function normalizeScenario(raw: unknown, tpl: string, tplDef: Template, seed: number): ScenarioJson | string {
  if (typeof raw !== 'object' || raw === null) return '输出不是对象';
  const r = raw as RawScenario;

  if (typeof r.group_name !== 'string' || r.group_name.length < 2 || r.group_name.length > 30) {
    return 'group_name 不合法';
  }
  // 消息数对齐真实群聊（data/mock 中位 60 条）。教师实测并不总照做"50~70 条"：
  // 15 例探针里 7 例落在 19~36 条 → 下限压到 32 可把产出率从 ~53% 提到 ~67%（省 1/4 生成费），
  // 同时仍比旧数据的 28 条更接近真实。上限 80 防止异常超长。
  if (!Array.isArray(r.messages) || r.messages.length < 32 || r.messages.length > 80) {
    return `messages 数量不对：${Array.isArray(r.messages) ? r.messages.length : '非数组'}`;
  }
  const msgs: ScenarioMessageJson[] = [];
  for (const m of r.messages) {
    if (typeof m !== 'object' || m === null) return 'messages 里有非对象元素';
    const mm = m as { offset_minutes?: unknown; sender?: unknown; text?: unknown };
    const text = typeof mm.text === 'string' ? mm.text.trim() : '';
    const sender = typeof mm.sender === 'string' ? mm.sender.trim() : '';
    if (!text || !sender) continue;
    if (text.length > 200) return '有消息超长（>200 字）';
    const off = Math.round(Number(mm.offset_minutes));
    if (!Number.isFinite(off)) return 'offset_minutes 不是数';
    msgs.push({ offset_minutes: Math.max(-2880, Math.min(0, off)), sender, text });
  }
  if (msgs.length < 35) return `有效消息太少：${msgs.length}（真实群聊中位 60 条，要求 ≥35）`;

  const expected: ExpectedEventJson[] = (Array.isArray(r.expected) ? r.expected : [])
    .filter(
      (e): e is ExpectedEventJson =>
        typeof e === 'object' && e !== null &&
        typeof (e as ExpectedEventJson).title === 'string' &&
        (e as ExpectedEventJson).title.trim() !== '' &&
        VALID_TYPES.has(String((e as ExpectedEventJson).type)),
    )
    .map((e) => ({ ...e, title: e.title.trim() }));
  const [lo, hi] = tplDef.expected;
  if (expected.length < Math.max(0, lo - 1) || expected.length > hi + 1) {
    return `expected 数量 ${expected.length} 超出模板区间 [${lo},${hi}]`;
  }

  const initial: InitialEventJson[] = (Array.isArray(r.initial_events) ? r.initial_events : [])
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e, i) => ({
      id: 100 + i,
      type: (VALID_TYPES.has(String(e.type)) ? String(e.type) : 'other') as InitialEventJson['type'],
      title: String(e.title ?? '').trim() || '未命名事项',
      when: typeof e.when === 'string' && e.when.trim() !== '' ? e.when.trim() : null,
      location: typeof e.location === 'string' && e.location.trim() !== '' ? e.location.trim() : null,
      level: Math.min(4, Math.max(1, Math.round(Number(e.level) || 2))),
    }));

  return {
    title: `${tpl}-${seed}`,
    group: { id: `syn-${tpl}-g${seed.toString(36)}`, name: r.group_name },
    messages: msgs,
    initial_events: initial,
    expected,
    meta: { template: tpl, seed, negative: tplDef.negative ?? false },
  };
}

async function genOne(tpl: string, seed: number): Promise<ScenarioJson | string> {
  const tplDef = TEMPLATES[tpl];
  if (!tplDef) return `没有模板 ${tpl}`;
  const rng = mulberry32(seed);
  const user = [
    SPEC_HEADER,
    `## 本剧本设定`,
    `类型：${tpl} —— ${tplDef.brief}`,
    seedInstruction(rng),
    `消息数量：${15 + Math.floor(rng() * 20)} 条左右`,
    tplDef.initial
      ? '改期/取消链至少 2 步（原通知 → 改一次 → 可能再改/取消）；initial_events 的 when 相对「今天」可过去可未来。'
      : '',
    tplDef.negative ? '这是负样本剧本：expected 必须是 []，全片不能出现说定时间的行动事项。' : '',
    '现在写剧本，只输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n');

  const res = await generate(
    [
      { role: 'system', content: '你是严谨的中文剧本数据工程师，只输出 JSON。' },
      { role: 'user', content: user },
    ],
    { temperature: 1.0, maxTokens: 8192, json: true },
  );
  usage.add(res);
  const parsed = parseLooseJson(res.content);
  if (parsed === undefined) return '输出不是 JSON';
  return normalizeScenario(parsed, tpl, tplDef, seed);
}

// ---------- CLI 主流程 ----------

const args = process.argv.slice(2);
const flagOf = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const numArg = (k: string, d: number): number => {
  const v = Number(flagOf(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

const WANT = numArg('n', 20);
const CONC = Math.max(1, Math.min(8, numArg('concurrency', 3)));
const SEED = numArg('seed', 1);
const ONLY = flagOf('template');
/** 输出目录（--out）：默认写 train/data/scenarios；做实验时用独立目录，避免污染主数据集 */
const OUT_DIR = flagOf('out') ?? SCENARIO_DIR;

async function main(): Promise<void> {
  if (ONLY && !TEMPLATES[ONLY]) {
    throw new Error(`没有模板 ${ONLY}，可选：${TEMPLATE_NAMES.join(', ')}`);
  }

  // 模板配额：正样本为主、负样本（chat）约 15%，贴近真实信噪比
  const weights: [string, number][] = [
    ['exam', 0.10], ['assignment', 0.12], ['activity', 0.10], ['meeting', 0.07], ['announcement', 0.07],
    ['reschedule', 0.10], ['cancel', 0.07], ['multi', 0.10], ['backfill', 0.07], ['near_miss', 0.05],
    ['chat', 0.15],
  ];
  const plan: string[] = [];
  for (let i = 0; i < WANT; i++) {
    if (ONLY) {
      plan.push(ONLY);
      continue;
    }
    let r = mulberry32(SEED * 1_000_003 + i)();
    let chosen = 'chat';
    for (const [name, w] of weights) {
      if (r < w) {
        chosen = name;
        break;
      }
      r -= w;
    }
    plan.push(chosen);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(
    `生成 ${plan.length} 个剧本 → ${OUT_DIR}` +
      `（模板：${[...new Set(plan)].map((t) => `${t}×${plan.filter((p) => p === t).length}`).join(' ')}）`,
  );

  const failures: string[] = [];
  let ok = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < plan.length) {
      const idx = cursor++;
      const tpl = plan[idx]!;
      const seed = SEED * 100_000 + idx;
      const file = join(OUT_DIR, `${tpl}-${seed.toString(36)}.json`);
      try {
        const scenario = await genOne(tpl, seed);
        if (typeof scenario === 'string') {
          failures.push(`#${idx} ${tpl}: ${scenario}`);
          continue;
        }
        writeFileSync(file, `${JSON.stringify(scenario, null, 1)}\n`, 'utf8');
        ok++;
        if (ok % 20 === 0 || ok === plan.length) {
          console.log(`  … ${ok}/${plan.length}（失败 ${failures.length}，${usage.text()}）`);
        }
      } catch (e) {
        failures.push(`#${idx} ${tpl}: ${(e as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  console.log(`\n完成：成功 ${ok}，失败 ${failures.length} → ${OUT_DIR}`);
  for (const f of failures.slice(0, 10)) console.log(`  ✗ ${f}`);
  console.log(usage.text());
  process.exit(failures.length > plan.length / 2 ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
