// .ics 导出（FR-9）。手写 iCalendar，不用第三方库。
// 时间约定：库里都是毫秒时间戳；只有这里和「页面显示」「LLM prompt」转成文本。
import type { EventDTO, EventType } from './types.js';

const CRLF = '\r\n';
const PRODID = '-//ClassRep//CN';

/** 类型中文名（SUMMARY 用；其余取值由 C 的 prompt 保证） */
const TYPE_CN: Record<EventType, string> = {
  exam: '考试',
  assignment: '作业',
  meeting: '会议',
  activity: '活动',
  announcement: '通知',
  other: '其他',
};

/** 导出时间一律按上海时间（架构 §5：ICS 带时区） */
const TZID = 'Asia/Shanghai';
const TZ_OFFSET = '+0800';

// ===== 时间格式化

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** 'yyyymmddThhmmss'（上海本地时间，配合 TZID 用） */
function formatLocal(ms: number): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZID,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .formatToParts(new Date(ms))
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  // en-CA 的 hour 在 24 小时制下可能给出 '24'（表示当天 0 点）
  const hour = p.hour === '24' ? '00' : (p.hour ?? '00');
  return `${p.year}${p.month}${p.day}T${hour}${p.minute}${p.second}`;
}

/** 'yyyymmddThhmmssZ'（UTC，DTSTAMP 用） */
function formatUtc(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// ===== 文本转义与折行

/**
 * 转义 `\ ; ,` 和换行（RFC 5545 §3.3.11）。
 * 反斜杠必须第一个换，否则会把后面新加的转义再转一次。
 */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * 按 UTF-8 字节折行：**含续行前导空格**每行最多 75 字节（RFC 5545 §3.1），
 * 所以首行内容 75 字节、续行内容 74 字节。不切断多字节字符。
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = ch;
      bytes = size;
      limit = 74; // 续行前面还有一个空格占 1 字节
      continue;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** 一个内容行：先折行，再加 CRLF */
function line(text: string): string {
  return foldLine(text) + CRLF;
}

// ===== 日历

/** 上海时区定义：固定 +0800，没有夏令时（STANDARD 从 19700101T000000 起） */
function vtimezoneLines(): string[] {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${TZID}`,
    'BEGIN:STANDARD',
    // RFC 5545 §3.6.5：VTIMEZONE 子组件的 DTSTART 必须是本地时间（不带 Z）
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${TZ_OFFSET}`,
    `TZOFFSETTO:${TZ_OFFSET}`,
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

/** 排序时间 = start_at ?? deadline_at；两个都空的排最后 */
function sortTime(e: EventDTO): number | null {
  return e.start_at ?? e.deadline_at;
}

/** 一个有时间的字段摘要（description + action_required），都没有就返回 null */
function buildDescription(event: EventDTO): string | null {
  const parts = [event.description, event.action_required]
    .map((s) => s?.trim() ?? '')
    .filter((s) => s !== '');
  return parts.length === 0 ? null : parts.join('\n');
}

function writeEvent(event: EventDTO, now: number): string[] {
  const lines: string[] = [];
  const typeCn = TYPE_CN[event.type] ?? TYPE_CN.other;

  lines.push('BEGIN:VEVENT');
  lines.push(`UID:classrep-${event.id}@local`);
  lines.push(`DTSTAMP:${formatUtc(now)}`);

  if (event.start_at !== null) {
    lines.push(`DTSTART;TZID=${TZID}:${formatLocal(event.start_at)}`);
    const end = event.end_at ?? event.start_at + 3600_000;
    lines.push(`DTEND;TZID=${TZID}:${formatLocal(end)}`);
    lines.push(`SUMMARY:${escapeIcsText(`[${typeCn}]${event.title}`)}`);
  } else if (event.deadline_at !== null) {
    // 只有截止时刻：DTSTART = DTEND = 截止时刻，标题前加【截止】
    const at = formatLocal(event.deadline_at);
    lines.push(`DTSTART;TZID=${TZID}:${at}`);
    lines.push(`DTEND;TZID=${TZID}:${at}`);
    lines.push(`SUMMARY:${escapeIcsText(`【截止】[${typeCn}]${event.title}`)}`);
  } else {
    return []; // 两个时间都没有的事件不导出
  }

  if (event.location !== null && event.location !== '') {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }
  const description = buildDescription(event);
  if (description !== null) {
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  }
  lines.push('END:VEVENT');
  return lines;
}

/**
 * 生成 .ics 文本。没有可导出的事件时也返回合法的空日历（只含 VTIMEZONE）。
 * `now` 只影响 DTSTAMP，测试里传固定值。
 */
export function buildIcs(events: EventDTO[], now: number = Date.now()): string {
  const exportable = events
    .filter((e) => e.start_at !== null || e.deadline_at !== null)
    .sort((a, b) => {
      const ta = sortTime(a);
      const tb = sortTime(b);
      if (ta === null || tb === null) return ta === tb ? a.id - b.id : ta === null ? 1 : -1;
      return ta === tb ? a.id - b.id : ta - tb;
    });
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, ...vtimezoneLines()];
  for (const event of exportable) {
    lines.push(...writeEvent(event, now));
  }
  lines.push('END:VCALENDAR');

  return lines.map(line).join('');
}
