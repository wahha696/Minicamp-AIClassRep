// Jev 快判分类器训练数据（操作手册 §2.4）。纯合成模式（不花 API，当天可训）：
//   node train/dist/train/gen-jev-data.js --n 10000 --seed 1
// 产出 train/data/jev-train.jsonl / jev-val.jsonl（8:2）。
// 行格式：{"text": "群名 [SEP] 上一条 [SEP] 本条", "label": 0|1, ...溯源字段}
// 负样本重点：没说定时间的随口约（手册 §2.4 点名的最难类型）；正样本覆盖「说定时间的聚餐/开黑」。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './lib/paths.js';
import { mulberry32, pick, shuffle } from './lib/rand.js';

// ---------- 语料 ----------

const GROUPS = [
  '2023级计算机学院年级群', '计科2301班', '软工2302通知群', '高数(下)课程群', '数据结构课程群',
  '大学英语IV学习群', '计算机网络课程群', '电子信息2303班', '物联2201班群', '班委群',
];

const CHATTERS = ['哈哈', '6', '收到', '确实', '+1', '好的', '[表情]', '冲', '真的假的'];

const COURSES = ['高数', '线代', '大物', '英语', '数据结构', '操作系统', '计网', '毛概', '体育'];
const PLACES = ['3号楼201', 'A203', '5号楼301', '大礼堂', '二食堂', '北门', '操场', '图书馆三楼'];

const WHEN_EXPR = ['明天下午两点', '今晚8点', '本周五', '下周一上午10点前', '10月16号', '周日23:59', '下周三', '这周五23:59', '后天早上8点', '下周二14:00'];

const NOTICE_TPL = [
  '通知：{course}第{n}章作业已布置，{when}23:59前学习通提交，附原始数据并转PDF',
  '{course}期中考试定在{when}，{place}，闭卷，带学生证和计算器',
  '选课确认{when}10点截止，没确认的视为放弃，都在教务系统操作',
  '班委{when}在{place}开会，各班委带好本周总结',
  '班费每人50，{when}前转给我',
  '毕业照{when}操场拍，穿好班服',
  '{course}答疑改到{when}，{place}，自愿参加',
  '原定周日的春游因下雨取消，改到{when}，时间地点另行通知',
];

const POS_DATE = [
  '今晚8点开黑，来的扣1，就今晚8点',
  '说定了啊，周六晚7点北门集合去吃烧烤',
  '那就这样，周五早上6:00校门口集合爬山，不见不散',
  '周三晚上7点一起自习，老地方图书馆三楼',
  '就定明天中午12点二食堂门口拼饭，谁去说一声',
  '周日下午两点篮球场3v3，输的请奶茶',
  '明晚10点线上短会，讨论分工，腾讯会议号到时候发',
  '这周六下午3点大礼堂彩排，班级节目全员到',
];

const VAGUE = [
  '晚上约饭吗', '有人开黑吗', '周末有人去打球吗', '改天聚一聚呗', '谁要拼车回去',
  '下午有人拼奶茶吗', '有人想一起自习吗', '晚上一起去看电影吗', '要不哪天一起吃个饭',
  '有人想一起报四六级吗', '晚点一起回宿舍？', '要不要一起报名运动会',
];

const NEG_CHIT = [
  '哈哈哈哈哈哈', '[表情]', '6', '确实', '笑死', '早上好', '晚安', '+1',
  '今天好冷', '食堂新出的麻辣香锅不错', '谁拿我充电器了', '昨晚游戏打到三点', '这周课好少',
  '出一辆二手自行车，80块九成新，私聊', '谁的校园卡掉在二食堂了', '拼单吗满减差10',
  '新出的剧有人看吗', '北门新开了家麻辣烫', '今天图书馆人好多', '冲',
  '这个老师上课好水', '洗衣服的机器又坏了', '有人拼外卖吗满减差12', '求个网课答案',
];

const FRAGMENT_POS = ['A203', '记得带2B铅笔', '改成周四了', '是3号楼201', '老师说截止是23:59', '下午两点半，别记错', '带上学生证', '换成腾讯会议了', '就今晚，定了'];

const FRAGMENT_PREV = [
  '明天下午的课代表会议定在哪？', '作业交到哪个教室来着', '小测改到哪天了',
  '班会时间和地点是什么', '答疑还办吗', '作业几号截止来着',
];

const GRAY_NEG = [
  '听说期中不难，去年的题很简单', '听说这科老师给分高', '有人说这次考试取消，假的吧',
  '课表怎么还没出', '选课系统崩了刷不出来', '这课去年挂科率多少',
];

// ---------- 行构造 ----------

interface JevRow {
  text: string;
  label: 0 | 1;
  group_name: string;
  prev: string | null;
  msg: string;
  source: 'synthetic';
  kind: string;
}

function fill(tpl: string, rng: () => number): string {
  return tpl
    .replaceAll('{course}', pick(rng, COURSES))
    .replaceAll('{n}', String(1 + Math.floor(rng() * 9)))
    .replaceAll('{when}', pick(rng, WHEN_EXPR))
    .replaceAll('{place}', pick(rng, PLACES));
}

/** 训练输入形态：群名 [SEP] 上一条(可选) [SEP] 本条 */
function makeText(group: string, prev: string | null, msg: string): string {
  return prev ? `${group} [SEP] ${prev} [SEP] ${msg}` : `${group} [SEP] [SEP] ${msg}`;
}

function row(label: 0 | 1, group: string, prev: string | null, msg: string, kind: string): JevRow {
  return { text: makeText(group, prev, msg), label, group_name: group, prev, msg, source: 'synthetic', kind };
}

/** 合成一条样本；配比贴合手册 §2.4（正:负 ≈ 1:3，含硬负/硬正对照） */
function synthRow(rng: () => number): JevRow {
  const r = rng();
  const group = pick(rng, GROUPS);

  if (r < 0.15) {
    // 正式通知（含 {when} 绝对时间），前面常带同学追问或闲聊
    const msg = fill(pick(rng, NOTICE_TPL), rng);
    const prev = rng() < 0.35 ? pick(rng, FRAGMENT_PREV) : rng() < 0.6 ? pick(rng, CHATTERS) : null;
    return row(1, group, prev, msg, 'notice');
  }
  if (r < 0.2) {
    // 硬正：说定了具体时间/日期的约定（对照随口约）
    const prev = rng() < 0.6 ? pick(rng, CHATTERS) : null;
    return row(1, group, prev, pick(rng, POS_DATE), 'dated');
  }
  if (r < 0.25) {
    // 零碎拼图：上一条是追问，本条补关键信息
    return row(1, group, pick(rng, FRAGMENT_PREV), pick(rng, FRAGMENT_POS), 'fragment');
  }
  if (r < 0.5) {
    // 硬负：没说定时间的随口约（手册 §2.4 点名的最缠人类型）
    const prev = rng() < 0.5 ? pick(rng, CHATTERS) : null;
    return row(0, group, prev, pick(rng, VAGUE), 'vague');
  }
  if (r < 0.8) {
    const prev = rng() < 0.6 ? pick(rng, CHATTERS) : null;
    return row(0, group, prev, pick(rng, NEG_CHIT), 'chat');
  }
  // 灰色负样本：传闻/问询/系统吐槽，压误报
  const prev = rng() < 0.5 ? '有人说这次考试取消了？' : pick(rng, CHATTERS);
  return row(0, group, prev, pick(rng, GRAY_NEG), 'gray');
}

// ---------- CLI ----------

const args = process.argv.slice(2);
const numArg = (k: string, d: number): number => {
  const i = args.indexOf(`--${k}`);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : d;
};

async function main(): Promise<void> {
  const n = numArg('n', 2000);
  const seed = numArg('seed', 7);
  const rng = mulberry32(seed);

  const rows: JevRow[] = [];
  for (let i = 0; i < n; i++) rows.push(synthRow(rng));
  const mixed = shuffle(rng, rows);
  const cut = Math.floor(mixed.length * 0.8);
  const train = mixed.slice(0, cut);
  const val = mixed.slice(cut);

  mkdirSync(DATA_DIR, { recursive: true });
  const trainFile = join(DATA_DIR, 'jev-train.jsonl');
  const valFile = join(DATA_DIR, 'jev-val.jsonl');
  const dump = (file: string, xs: JevRow[]): void => {
    writeFileSync(file, xs.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  };
  dump(trainFile, train);
  dump(valFile, val);

  const byKind = new Map<string, { pos: number; neg: number }>();
  for (const r of mixed) {
    const k = byKind.get(r.kind) ?? { pos: 0, neg: 0 };
    if (r.label === 1) k.pos++;
    else k.neg++;
    byKind.set(r.kind, k);
  }
  const pos = mixed.filter((x) => x.label === 1).length;
  console.log(`合成 ${mixed.length} 条（正 ${pos} / 负 ${mixed.length - pos} = 1:${((mixed.length - pos) / Math.max(1, pos)).toFixed(1)}）`);
  for (const [k, v] of byKind) console.log(`  ${k.padEnd(9)} 正 ${String(v.pos).padStart(5)}  负 ${String(v.neg).padStart(5)}`);
  console.log(`→ ${trainFile}\n→ ${valFile}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
