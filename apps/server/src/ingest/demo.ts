// 演示回放 / 粘贴导入（FR-11.1/11.3）。主人是 B。
// 剧本格式见 00-总约定 §8：一个文件一个群，文本只写相对时间。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MOCK_DIR } from '../paths.js';
import type { Message } from '../types.js';

export interface ScenarioMeta {
  name: string;
  title: string;
  count: number;
}

interface ScenarioMessage {
  offset_minutes: number;
  sender: string;
  text: string;
}

interface Scenario {
  title: string;
  group: { id: string; name: string };
  messages: ScenarioMessage[];
}

/** 剧本名 → 文件名。只允许普通文件名，挡掉路径穿越。 */
function scenarioFile(name: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const file = join(MOCK_DIR, `${name}.json`);
  if (!file.startsWith(MOCK_DIR)) return null;
  return file;
}

function readScenario(name: string): Scenario | null {
  const file = scenarioFile(name);
  if (file === null) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const s = parsed as Partial<Scenario>;
  if (typeof s.title !== 'string') return null;
  if (s.group === undefined || typeof s.group.id !== 'string' || typeof s.group.name !== 'string') {
    return null;
  }
  if (!Array.isArray(s.messages)) return null;
  return s as Scenario;
}

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** GET /api/demo/scenarios：读 MOCK_DIR/*.json，坏文件跳过 */
export function listScenarios(): ScenarioMeta[] {
  let files: string[];
  try {
    files = readdirSync(MOCK_DIR);
  } catch {
    return [];
  }
  const out: ScenarioMeta[] = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    const scenario = readScenario(file.slice(0, -'.json'.length));
    if (scenario === null) continue;
    out.push({
      name: file.slice(0, -'.json'.length),
      title: scenario.title,
      count: scenario.messages.length,
    });
  }
  return out;
}

/**
 * 剧本 → Message[]。`sent_at = 回放时刻 + offset_minutes 分钟`；
 * `message_id = demo-<剧本名>-<序号>`（序号从 1 起）。
 * 剧本不存在或格式不对时返回 null。
 */
export function buildDemoMessages(name: string, now: number = Date.now()): Message[] | null {
  const scenario = readScenario(name);
  if (scenario === null) return null;
  return scenario.messages.map((m, i) => ({
    message_id: `demo-${name}-${i + 1}`,
    group_id: scenario.group.id,
    group_name: scenario.group.name,
    sender_name: typeof m.sender === 'string' ? m.sender : '',
    text: typeof m.text === 'string' ? m.text : '',
    sent_at: now + toNumber(m.offset_minutes) * 60_000,
  }));
}

// ===== 粘贴导入（FR-11.3）

// QQ 复制格式的行：整行是「昵称 + 时间」，内容在下一行。必须整行匹配，
// 否则会被 COLON_RE 抢走（时间戳本身带冒号）。
const TIME_RE = /^([^:：]{1,32}?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
// 「昵称：内容」：昵称里不能有空格（否则 "张老师 12:30:45" 会被误判），内容里可以有冒号
const COLON_RE = /^(\S{1,32}?)[:：]\s*(.*)$/;

/**
 * 解析粘贴的聊天记录，支持三种写法：
 * 1. `昵称：内容` / `昵称: 内容`
 * 2. `昵称 12:30:45`（QQ 复制格式），下一行是内容
 * 3. 解析不了的行归到上一条消息
 * 消息自带的时间戳只用来判断格式，`sent_at` 一律用当前时间依次 +1 秒。
 * `groupName` 为空时，若第一行不像消息就当作群名用掉。
 */
export function parseImportedText(
  groupName: string,
  text: string,
  now: number = Date.now(),
): Message[] {
  const lines = text.split(/\r?\n/);
  const isTimeLine = (line: string): boolean => TIME_RE.test(line.trim());
  const isColonLine = (line: string): boolean => COLON_RE.test(line.trim());
  // 有 QQ 时间戳格式的行 → 按 QQ 格式解析；否则按「昵称：内容」
  const mode: 'qq' | 'colon' = lines.some(isTimeLine) ? 'qq' : 'colon';

  let name = groupName.trim();
  const bodies: { sender: string; text: string }[] = [];
  // QQ 格式里时间戳和内容是两行，这里记下"上一条还没吃到内容"
  let pending: { sender: string; text: string } | null = null;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    // 只在第一行、且它不像任何消息格式时，才当作群名
    if (index === 0 && name === '' && !isTimeLine(trimmed) && !isColonLine(trimmed)) {
      name = trimmed;
      return;
    }
    if (mode === 'qq') {
      const time = TIME_RE.exec(trimmed);
      if (time !== null) {
        // 昵称行：新建一条空内容的消息，等下一行填内容
        pending = { sender: (time[1] ?? '').trim(), text: '' };
        bodies.push(pending);
        return;
      }
      if (pending !== null && pending.text === '') {
        pending.text = trimmed;
        return;
      }
    } else {
      const colon = COLON_RE.exec(trimmed);
      if (colon !== null) {
        bodies.push({ sender: (colon[1] ?? '').trim(), text: (colon[2] ?? '').trim() });
        return;
      }
    }
    // 解析不了的行：归到上一条
    const last = bodies[bodies.length - 1];
    if (last === undefined) return;
    last.text = last.text === '' ? trimmed : `${last.text}\n${trimmed}`;
    pending = null;
  });

  const group_id = `demo-import-${name}`;
  return bodies
    .filter((b) => b.sender !== '' || b.text !== '')
    .map((b, i) => ({
      message_id: `import-${now}-${i}`,
      group_id,
      group_name: name,
      sender_name: b.sender,
      text: b.text,
      sent_at: now + i * 1000,
    }));
}
