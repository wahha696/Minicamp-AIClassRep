// 网页课表与文件导入共用同一套行列/课程解析规则。
interface CourseDTO {
  name: string;
  teacher: string;
  location: string;
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** 节次范围（第 start–end 节连排，如 1–4、9–12、11–12 都原样保留） */
  start: number;
  end: number;
  weeks: number[];
}
const DAY = 86_400_000;

/** 支持的节次上限：1–12 节（11–12 节晚课正常保留；超出会有明确 warning） */
export const MAX_SECTION = 12;

// 表头/行首里的星期 → 周几（1=周一 … 7=周日）；星期X、周X、周天/星期天别名都认
const WEEKDAY_VALUE: Record<string, number> = {
  星期一: 1,
  周一: 1,
  星期二: 2,
  周二: 2,
  星期三: 3,
  周三: 3,
  星期四: 4,
  周四: 4,
  星期五: 5,
  周五: 5,
  星期六: 6,
  周六: 6,
  星期日: 7,
  周日: 7,
  星期天: 7,
  周天: 7,
};

/** 单元格 → 周几：只看第一行（有些表把日期塞在同一格第二行），剥掉空白后按别名查表 */
function weekdayOfCell(cell: unknown): number | undefined {
  const first = String(cell ?? '').split('\n')[0]!.replace(/\s+/g, '');
  return WEEKDAY_VALUE[first];
}

// 「节次」标签：1-2 / 3－4 / 第1,2节 / 第3节 / 十一-十二 / 9 单节 都认（中文数字到十二）
const CN_SECTION: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

const SECTION_TOKEN = String.raw`(?:\d{1,2}|十[一二]?|[一二三四五六七八九])`;
const SECTION_LABEL_RE = new RegExp(
  `^(?:第)?(${SECTION_TOKEN})(?:\\s*[-－–—~～至,，、]\\s*(${SECTION_TOKEN}))?\\s*(?:节|大节)?$`,
);

function sectionNum(tok: string): number {
  return /^\d+$/.test(tok) ? Number(tok) : (CN_SECTION[tok] ?? NaN);
}

/** 「1-2」「第1,2节」「十一－十二」「9」→ {start,end}；不是节次标签返回 null */
export function parseSectionLabel(text: string): { start: number; end: number } | null {
  const t = String(text).trim().replace(/\s+/g, '');
  const m = SECTION_LABEL_RE.exec(t);
  if (!m) return null;
  const start = sectionNum(m[1]!);
  const end = m[2] !== undefined ? sectionNum(m[2]) : start;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) return null;
  return { start, end };
}

export interface ParsedTimetable {
  courses: CourseDTO[];
  warnings: string[];
  /** 表里自带校历时推算出的第 1 周周一（'YYYY-MM-DD'），推不出来就没有 */
  semesterStart?: string;
}

/** 超出 1–12 节（或区间倒序）时的一行警告；有内容才警告，空行静默跳过 */
function outOfRangeWarning(
  warnings: string[],
  p1: number,
  p2: number,
  content: string,
): void {
  warnings.push(`第 ${p1}–${p2} 节超出支持的节次范围（1–${MAX_SECTION}），已忽略：${content}`);
}

/**
 * 解析 sheet_to_json(ws, {header: 1, defval: ''}) 的结果（纯函数，不测 xls 本身）。
 * 支持两种导出形式：
 *   形式一：列 = 星期，行 = 节次（规则见 docs/拓展功能-开发计划.md §4.6）；
 *   形式二：行 = 星期，列 = 节次（「1－2」「3－4」… 横排表头），格子里没有教师、周次写成「1-16周(32学时)」，底部带校历。
 * 课次保存原始节次范围（start–end，1–12）：跨两节的连排课（如 1–4、9–12）不再被压扁，
 * 11–12 节晚课照常解析；解析不了/越界的行给明确 warning，不静默丢弃。
 */
export function parseTimetable(rows: string[][]): ParsedTimetable {
  // 形式二的表头行：第 1 列之外有 ≥2 个节次标签（「1－2」「第3,4节」…）。
  // 不算第 1 列：形式一数据行的行首也是节次标签，但它只在第 1 列出现；
  // 形式一格子里的课程名不会整格都长得像个节次标签。
  const periodHeaderIdx = rows.findIndex(
    (r) => r.slice(1).filter((c) => parseSectionLabel(String(c))).length >= 2,
  );
  if (periodHeaderIdx >= 0) return parseTransposed(rows, periodHeaderIdx);
  return parseByWeekdayColumns(rows);
}

/** 形式一：列 = 星期，行 = 节次 */
function parseByWeekdayColumns(rows: string[][]): ParsedTimetable {
  const warnings: string[] = [];
  const courses: CourseDTO[] = [];

  // 1) 表头行：同一行里 ≥3 个星期表头（兼容只有周一~周五的表、周日缺列的表）；
  //    列序按表头文字定位（星期日可能在第一列，也可以不出现）
  const headerIdx = rows.findIndex(
    (r) => r.filter((c) => weekdayOfCell(c) !== undefined).length >= 3,
  );
  if (headerIdx < 0) {
    return { courses, warnings: ['没找到表头行（应至少包含 3 个「星期一/周一」…「星期日/周日」列表头）'] };
  }
  const header = rows[headerIdx]!;
  // weekday 1..7 → 列下标
  const colOf = new Map<number, number>();
  header.forEach((cell, i) => {
    const wd = weekdayOfCell(cell);
    if (wd !== undefined && !colOf.has(wd)) colOf.set(wd, i);
  });

  // 2) 表头之后：第一列是节次标签的行才是课；「备注」开头跳过；
  //    有课程内容但行首认不出节次 → 明确警告（不静默丢）
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r]!;
    const first = String(row?.[0] ?? '').trim();
    if (first === '' || first.startsWith('备注')) continue;
    const sec = parseSectionLabel(first);
    if (!sec) {
      const content = row
        .slice(1)
        .map((c) => String(c).trim())
        .find((c) => c !== '');
      if (content !== undefined) {
        warnings.push(`第 ${r + 1} 行的节次标记「${first}」不认识，本行已忽略：${content.split('\n')[0]}`);
      }
      continue;
    }
    if (sec.start < 1 || sec.end < sec.start || sec.end > MAX_SECTION) {
      const content = row
        .slice(1)
        .map((c) => String(c).trim())
        .find((c) => c !== '');
      if (content !== undefined) outOfRangeWarning(warnings, sec.start, sec.end, content.split('\n')[0]!);
      continue;
    }
    for (const [weekday, col] of colOf) {
      const cell = String(row[col] ?? '');
      if (cell.trim() === '') continue;
      parseCell(cell, weekday as CourseDTO['weekday'], sec.start, sec.end, courses, warnings);
    }
  }
  return { courses, warnings };
}

/** 形式二：行 = 星期，列 = 节次。headerIdx 是「1－2 … 11－12 … 备注」那一行。 */
function parseTransposed(rows: string[][], headerIdx: number): ParsedTimetable {
  const warnings: string[] = [];
  const courses: CourseDTO[] = [];
  const header = rows[headerIdx]!;

  // 列 → 节次范围：表头只写在每组合并单元格的第一列，后面的空列沿用左边最近的表头；「备注」及之后不算
  const periodOfCol: Array<{ start: number; end: number } | null> = [];
  let cur: { start: number; end: number } | null = null;
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i]).trim();
    if (h.startsWith('备注')) {
      cur = null;
    } else {
      const sec = parseSectionLabel(h);
      if (sec) cur = sec;
    }
    periodOfCol[i] = cur;
  }

  // 第一列是「星期X/周X」的行才是课；校历 / 作息时间 / 说明等行第一列不是星期，自然跳过
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r]!;
    const weekday = weekdayOfCell(row[0]);
    if (weekday === undefined) continue;
    for (let c = 1; c < row.length; c++) {
      const period = periodOfCol[c];
      const cell = String(row[c] ?? '');
      if (!period || cell.trim() === '') continue;
      const { start, end } = period;
      if (start < 1 || end < start || end > MAX_SECTION) {
        const first = cell.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
        outOfRangeWarning(warnings, start, end, first);
        continue;
      }
      parseCellNoTeacher(cell, weekday as CourseDTO['weekday'], start, end, courses, warnings);
    }
  }

  const semesterStart = semesterStartFromCalendar(rows);
  return semesterStart ? { courses, warnings, semesterStart } : { courses, warnings };
}

/** 形式二的周次行：「1-16周(32学时)」「8,12周(8学时)」「1-15单周」 */
const WEEKS_SUFFIX_RE = /^\d[\d,，\-－\s单双]*周/;

/** 节次区间的展示文本（警告里用） */
function secText(start: number, end: number): string {
  return start === end ? `第${start}节` : `第${start}–${end}节`;
}

/**
 * 形式二的格子：[课名] [周次行] [教室(可能为空行)] [班级]，可重复多门。
 * 空行有意义（体育没有教室时就是一个空行），所以只去掉首尾空行、保留中间空行。
 */
function parseCellNoTeacher(
  cell: string,
  weekday: CourseDTO['weekday'],
  start: number,
  end: number,
  courses: CourseDTO[],
  warnings: string[],
): void {
  const lines = cell.split('\n').map((l) => l.trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const dayText = `周${['一', '二', '三', '四', '五', '六', '日'][weekday - 1]}`;
  const anchors = lines.map((l, i) => (WEEKS_SUFFIX_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (anchors.length === 0) {
    warnings.push(`${dayText} ${secText(start, end)}有内容但没有周次信息，已忽略：${lines.find((l) => l !== '') ?? ''}`);
    return;
  }

  let prevAnchor = -1;
  for (const a of anchors) {
    // 课名 = 本锚点之前、上一门的「教室+班级」之后最近的非空行
    let name = '';
    for (let i = a - 1; i > prevAnchor + (prevAnchor >= 0 ? 2 : 0); i--) {
      if (lines[i] !== '') {
        name = lines[i]!;
        break;
      }
    }
    // 上一门没有班级行时，课名紧贴在本锚点前一行
    if (name === '' && a - 1 > prevAnchor && lines[a - 1] !== '') name = lines[a - 1]!;
    prevAnchor = a;
    if (name === '') {
      warnings.push(`${dayText} ${secText(start, end)}有一门课没解析出课名，已忽略`);
      continue;
    }
    const weeks = parseWeeks(lines[a]!);
    if (weeks === null) {
      warnings.push(`「${name}」的周次「${lines[a]!}」没解析出来，已跳过这门课`);
      continue;
    }
    const next = lines[a + 1] ?? '';
    const location = WEEKS_SUFFIX_RE.test(next) ? '' : next;
    courses.push({ name, teacher: '', location, weekday, start, end, weeks });
  }
}

/**
 * 从形式二底部的校历推第 1 周周一：
 *   「周次」行里值为 1 的那一列 → 同列「星期日」行的日期 + 左侧最近的「N月」+ 学年学期的年份 → 该周日 +1 天。
 * 校历的周是「周日…周六」，所以第 1 周的周一 = 那个周日的后一天。任何一步对不上就返回 undefined。
 */
function semesterStartFromCalendar(rows: string[][]): string | undefined {
  const cellText = (r: string[] | undefined, i: number) => String(r?.[i] ?? '').trim();
  // 只在「月份」行及之后找，避免撞上课表主体里第一列的「星期日」
  const monthIdx = rows.findIndex((r) => r.slice(0, 3).some((c) => String(c).trim() === '月份'));
  if (monthIdx < 0) return undefined;
  const calendar = rows.slice(monthIdx);
  const labelled = (label: string) => calendar.find((r) => r.slice(0, 3).some((c) => String(c).trim() === label));
  const weekRow = labelled('周次');
  const sunRow = labelled('星期日');
  const monthRow = calendar[0]!;
  if (!weekRow || !sunRow) return undefined;
  const col = weekRow.findIndex((c, i) => i >= 1 && String(c).trim() === '1');
  if (col < 0) return undefined;
  const day = Number(cellText(sunRow, col));
  let month = NaN;
  for (let i = col; i >= 1; i--) {
    const m = /^(\d{1,2})月$/.exec(cellText(monthRow, i));
    if (m) {
      month = Number(m[1]);
      break;
    }
  }
  const termM = rows
    .flat()
    .map((c) => /学年学期[：:]\s*(\d{4})-(\d{4})/.exec(String(c)))
    .find((m) => m !== null);
  if (!termM || !(day >= 1 && day <= 31) || !(month >= 1 && month <= 12)) return undefined;
  // 秋季学期 8–12 月在前一年，其余月份在后一年
  const year = month >= 8 ? Number(termM[1]) : Number(termM[2]);
  const sunday = Date.UTC(year, month - 1, day);
  const d = new Date(sunday);
  if (d.getUTCDate() !== day || d.getUTCDay() !== 0) return undefined;
  return new Date(sunday + DAY).toISOString().slice(0, 10);
}

const WEEKS_RE = /\[周\]/;

/** 一个格子可能有多门课：以「周次行」（含 [周] 的行）为锚点切段 */
function parseCell(
  cell: string,
  weekday: CourseDTO['weekday'],
  start: number,
  end: number,
  courses: CourseDTO[],
  warnings: string[],
): void {
  const lines = cell
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const anchors = lines.map((l, i) => (WEEKS_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  const dayText = `周${['一', '二', '三', '四', '五', '六', '日'][weekday - 1]}`;
  if (anchors.length === 0) {
    warnings.push(`${dayText} ${secText(start, end)}有内容但没有周次信息，已忽略：${lines[0] ?? ''}`);
    return;
  }

  let prevAnchor = -1;
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k]!;
    const nextA = anchors[k + 1];

    // 本门课的「课名+教师」行区间。
    // 上一锚点与本锚点之间的行 = [上一门教室?] + [本门课名, 本门教师]：
    // 课名/教师至少要占两行，所以中间行 ≥3 时第一行才算上一门的教室，否则当它没有教室。
    const headerStart =
      k === 0 ? 0 : prevAnchor + 1 + (a - prevAnchor - 1 >= 3 ? 1 : 0);
    const headers = lines.slice(headerStart, a);
    const name = headers[0] ?? '';
    const teacher = headers.slice(1).join(' ');

    if (name === '') {
      warnings.push(`${dayText} ${secText(start, end)}有一门课没解析出课名，已忽略`);
      prevAnchor = a;
      continue;
    }

    const weeks = parseWeeks(lines[a]!);
    if (weeks === null) {
      warnings.push(`「${name}」的周次「${lines[a]!}」没解析出来，已跳过这门课`);
      prevAnchor = a;
      continue;
    }

    // 教室 = 本锚点之后、下一锚点之前的首行；但如果本锚点是最后一个，则直接取下一行
    let location = '';
    const after = lines.slice(a + 1, nextA ?? lines.length);
    if (nextA === undefined) {
      // 最后一门：之后第一行是教室（没有就是空，如体育）
      location = after[0] ?? '';
      if (after.length > 1) {
        warnings.push(`${dayText} ${secText(start, end)}「${name}」之后还有内容没有周次信息，已忽略：${after[1]}`);
      }
    } else {
      // 非最后一门：「之后到下一锚点」至少要有课名+教师 2 行，多出的第一行才是教室
      location = after.length >= 3 ? after[0]! : '';
    }

    courses.push({ name, teacher, location, weekday, start, end, weeks });
    prevAnchor = a;
  }
}

/** 「3-16」「8,12」「1-15单」「1-16双」（可带「[周]」或「周(32学时)」后缀）→ 周次数组；解析不了返回 null */
export function parseWeeks(text: string): number[] | null {
  const body = text
    .replace('[周]', '')
    .replace(/周\s*([(（][^)）]*[)）])?$/, '')
    .replace(/\s/g, '')
    .replace(/，/g, ',')
    .replace(/－/g, '-');
  if (body === '') return null;
  const weeks = new Set<number>();
  for (const part of body.split(',')) {
    const rangeM = /^(\d+)-(\d+)(单|双)?$/.exec(part);
    const singleM = /^(\d+)(单|双)?$/.exec(part);
    if (rangeM) {
      const a = Number(rangeM[1]);
      const b = Number(rangeM[2]);
      if (b < a) return null;
      for (let w = a; w <= b; w++) {
        if (rangeM[3] === '单' && w % 2 === 0) continue;
        if (rangeM[3] === '双' && w % 2 === 1) continue;
        if (w >= 1 && w <= 30) weeks.add(w);
      }
    } else if (singleM) {
      const w = Number(singleM[1]);
      if (singleM[2] === '单' && w % 2 === 0) continue;
      if (singleM[2] === '双' && w % 2 === 1) continue;
      if (w >= 1 && w <= 30) weeks.add(w);
    } else {
      return null;
    }
  }
  return weeks.size === 0 ? null : [...weeks].sort((x, y) => x - y);
}
