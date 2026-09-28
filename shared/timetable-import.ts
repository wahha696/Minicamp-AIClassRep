// 网页课表与文件导入共用同一套行列/课程解析规则。
import { stableId, type CourseDTO, type ImportItem } from './timetable.js';
const DAY = 86_400_000;

// 表头里的「星期X」→ 周几（1=周一 … 7=周日）
const WEEKDAY_VALUE: Record<string, number> = {
  星期一: 1,
  星期二: 2,
  星期三: 3,
  星期四: 4,
  星期五: 5,
  星期六: 6,
  星期日: 7,
  星期天: 7,
  周一: 1,
  周二: 2,
  周三: 3,
  周四: 4,
  周五: 5,
  周六: 6,
  周日: 7,
  周天: 7,
};

/** 节次标签：单节、连堂与 11–12 节均保留原始起止范围。 */
const BLOCK_ROW_RE = /^(?:第)?(\d{1,2})(?:\s*[,，、－\-–—~至]\s*(\d{1,2}))?(?:节)?$/;
export interface MergeRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}
export interface ParseOptions {
  sheet?: string;
  merges?: MergeRange[];
}
function period(text: string): [number, number] | null {
  const m = BLOCK_ROW_RE.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

export interface ParsedTimetable {
  courses: CourseDTO[];
  warnings: string[];
  /** 表里自带校历时推算出的第 1 周周一（'YYYY-MM-DD'），推不出来就没有 */
  semesterStart?: string;
  items?: ImportItem[];
}

/**
 * 解析 sheet_to_json(ws, {header: 1, defval: ''}) 的结果（纯函数，不测 xls 本身）。
 * 支持两种导出形式：
 *   形式一：列 = 星期，行 = 节次（规则见 docs/拓展功能-开发计划.md §4.6）；
 *   形式二：行 = 星期，列 = 节次（「1－2」「3－4」… 横排表头），格子里没有教师、周次写成「1-16周(32学时)」，底部带校历。
 */
export function parseTimetable(rows: string[][], options: ParseOptions = {}): ParsedTimetable {
  rows = rows.map((r) =>
    r.map((c) =>
      String(c ?? '')
        .replace(/\r/g, '')
        .trim(),
    ),
  );
  // Expand only structural merged labels, never duplicate a course cell.
  for (const m of options.merges ?? []) {
    const label = rows[m.s.r]?.[m.s.c] ?? '';
    if (!period(label) && !WEEKDAY_VALUE[label]) continue;
    for (let r = m.s.r; r <= m.e.r; r++)
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (rows[r] && !rows[r]![c]) rows[r]![c] = label;
      }
  }
  const periodHeaderIdx = rows.findIndex(
    (r) => r.filter((c) => BLOCK_ROW_RE.test(String(c).trim())).length >= 2,
  );
  const weekdayHeaderIdx = rows.findIndex((r) => r.filter((c) => WEEKDAY_VALUE[c] !== undefined).length >= 2);
  const transposed = periodHeaderIdx >= 0 && (weekdayHeaderIdx < 0 || periodHeaderIdx < weekdayHeaderIdx);
  const headerIdx = transposed ? periodHeaderIdx : weekdayHeaderIdx;
  const courses: CourseDTO[] = [],
    warnings: string[] = [],
    items: ImportItem[] = [];
  const sheet = options.sheet ?? '课表';
  const header = rows[headerIdx] ?? [];
  const stop = rows.findIndex((r, i) => i > headerIdx && r.some((c) => /^(校历|月份|作息时间)$/.test(c)));
  let currentPeriod: [number, number] | null = null;
  const columns = header.map((c) => {
    if (/^备注/.test(c)) currentPeriod = null;
    else currentPeriod = period(c) ?? currentPeriod;
    return currentPeriod;
  });
  for (let r = Math.max(0, headerIdx + 1); r < (stop < 0 ? rows.length : stop); r++) {
    const row = rows[r]!;
    const weekday = row.map((c) => WEEKDAY_VALUE[c]).find((x) => x !== undefined);
    const range = row.map(period).find((x) => x !== null);
    for (let col = 0; col < row.length; col++) {
      const raw = row[col]!;
      if (
        !raw ||
        (headerIdx >= 0 && !WEEKDAY_VALUE[header[col] ?? ''] && period(raw)) ||
        WEEKDAY_VALUE[raw] ||
        /^(上午|下午|晚上|时间|节次|备注[:：]?)$/.test(raw)
      )
        continue;
      const wd = transposed ? weekday : WEEKDAY_VALUE[header[col] ?? ''];
      const p = transposed ? columns[col] : range;
      // Unknown rows/headers retain content for correction, rather than pretending a complete import.
      const id = `source-${stableId(`${sheet}:${r + 1}:${col + 1}`)}`;
      const item: ImportItem = {
        id,
        sheet,
        row: r + 1,
        column: col + 1,
        raw,
        status: 'pending',
        course_ids: [],
      };
      items.push(item);
      if (!wd || !p) {
        item.message = '无法确定星期或节次，请手动补全';
        continue;
      }
      let [p1, p2] = p;
      const merge = options.merges?.find((m) => m.s.r === r && m.s.c === col);
      if (merge) {
        if (transposed) {
          if (merge.e.r > r) {
            item.message = '课程跨多个星期合并，需手动确认';
            continue;
          }
          p2 = columns[merge.e.c]?.[1] ?? p2;
        } else {
          if (merge.e.c > col) {
            item.message = '课程跨多个星期合并，需手动确认';
            continue;
          }
          const end = rows[merge.e.r]?.map(period).find((x) => x !== null);
          p2 = end?.[1] ?? p2;
        }
      }
      if (p1 < 1 || p2 < p1 || p2 > 24) {
        item.message = `节次 ${p1}–${p2} 无效（支持 1–24 节）`;
        continue;
      }
      const parsed: CourseDTO[] = [],
        notes: string[] = [];
      (transposed ? parseCellNoTeacher : parseCell)(
        raw,
        wd as CourseDTO['weekday'],
        Math.ceil(p1 / 2),
        parsed,
        notes,
      );
      parsed.forEach((c, i) => {
        c.id = `${id}-${i + 1}`;
        c.course_id = c.id;
        c.start_period = p1;
        c.end_period = p2;
        c.source = { sheet, row: r + 1, column: col + 1, raw, item_id: id };
        courses.push(c);
        item.course_ids.push(c.id);
      });
      item.status = parsed.length && !notes.length ? 'parsed' : 'pending';
      item.message = notes.join('；') || (parsed.length ? undefined : '未识别到课程');
      warnings.push(...notes);
    }
  }
  if (headerIdx < 0) warnings.push('没找到表头行（星期/节次），原文已保留待确认');
  items
    .filter((i) => i.status === 'pending')
    .forEach((i) => warnings.push(`${i.sheet} R${i.row}C${i.column}：${i.message}`));
  return { courses, warnings: [...new Set(warnings)], items, semesterStart: semesterStartFromCalendar(rows) };
}

/** 形式二的周次行：「1-16周(32学时)」「8,12周(8学时)」「1-15单周」 */
const WEEKS_SUFFIX_RE = /^\d[\d,，\-－\s单双]*周/;

/**
 * 形式二的格子：[课名] [周次行] [教室(可能为空行)] [班级]，可重复多门。
 * 空行有意义（体育没有教室时就是一个空行），所以只去掉首尾空行、保留中间空行。
 */
function parseCellNoTeacher(
  cell: string,
  weekday: CourseDTO['weekday'],
  block: CourseDTO['block'],
  courses: CourseDTO[],
  warnings: string[],
): void {
  const lines = cell.split('\n').map((l) => l.trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const dayText = `周${['一', '二', '三', '四', '五', '六', '日'][weekday - 1]}`;
  const anchors = lines.map((l, i) => (WEEKS_SUFFIX_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (anchors.length === 0) {
    warnings.push(
      `${dayText} 第${block}块有内容但没有周次信息，待确认：${lines.find((l) => l !== '') ?? ''}`,
    );
    return;
  }

  let prevAnchor = -1;
  for (const a of anchors) {
    if ((prevAnchor < 0 && a > 1) || (prevAnchor >= 0 && a - prevAnchor > 4))
      warnings.push('课程片段有额外行，可能有未识别课程，请核对原文');
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
      warnings.push(`${dayText} 第${block}块有一门课没解析出课名，待确认`);
      continue;
    }
    const weeks = parseWeeks(lines[a]!);
    if (weeks === null) {
      warnings.push(`「${name}」的周次「${lines[a]!}」没解析出来，待确认`);
      continue;
    }
    const nextAnchor = anchors[anchors.indexOf(a) + 1];
    const next = lines[a + 1] ?? '';
    const location =
      (nextAnchor !== undefined && nextAnchor <= a + 2) || WEEKS_SUFFIX_RE.test(next) ? '' : next;
    const class_name = nextAnchor !== undefined && nextAnchor <= a + 3 ? '' : (lines[a + 2] ?? '');
    courses.push({ name, teacher: '', location, class_name, weekday, block, weeks });
  }
  if (lines.slice((anchors.at(-1) ?? 0) + 3).some(Boolean)) warnings.push('末尾仍有未识别内容，请核对原文');
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
  const labelled = (label: string) =>
    calendar.find((r) => r.slice(0, 3).some((c) => String(c).trim() === label));
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

const WEEKS_RE = /\[周\]|^(?:第)?\d[\d,，－\-–—\s单双]*周/;

/** 一个格子可能有多门课：以「周次行」（含 [周] 的行）为锚点切段 */
function parseCell(
  cell: string,
  weekday: CourseDTO['weekday'],
  block: CourseDTO['block'],
  courses: CourseDTO[],
  warnings: string[],
): void {
  const lines = cell
    .trim()
    .split('\n')
    .map((l) => l.trim());
  const anchors = lines.map((l, i) => (WEEKS_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  const dayText = `周${['一', '二', '三', '四', '五', '六', '日'][weekday - 1]}`;
  if (anchors.length === 0) {
    warnings.push(`${dayText} 第${block}块有内容但没有周次信息，待确认：${lines[0] ?? ''}`);
    return;
  }

  let prevAnchor = -1;
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k]!;
    const nextA = anchors[k + 1];

    // 本门课的「课名+教师」行区间。
    // 上一锚点与本锚点之间的行 = [上一门教室?] + [本门课名, 本门教师]：
    // 课名/教师至少要占两行，所以中间行 ≥3 时第一行才算上一门的教室，否则当它没有教室。
    const hasLocation = (between: string[]) =>
      between.length >= 3 ||
      (between.length === 2 && /楼|馆|室|校区|[A-Za-z]\d|\d{3}/.test(between[0] ?? ''));
    const between = lines.slice(prevAnchor + 1, a);
    if (k > 0 && between.length === 2 && between.every(Boolean))
      warnings.push('同格课程缺少明确的空字段分隔，请核对教师和地点');
    const headerStart = k === 0 ? 0 : prevAnchor + 1 + (hasLocation(between) ? 1 : 0);
    const headers = lines.slice(headerStart, a);
    if (headers.filter(Boolean).length > 2)
      warnings.push('课程头部有额外内容，可能包含未拆分课程，请对照原文确认');
    const name = headers[0] ?? '';
    let teacher = headers.slice(1).filter(Boolean).join(' ');

    if (name === '') {
      warnings.push(`${dayText} 第${block}块有一门课没解析出课名，待确认`);
      prevAnchor = a;
      continue;
    }

    const weeks = parseWeeks(lines[a]!);
    if (weeks === null) {
      warnings.push(`「${name}」的周次「${lines[a]!}」没解析出来，待确认`);
      prevAnchor = a;
      continue;
    }

    // 教室 = 本锚点之后、下一锚点之前的首行；但如果本锚点是最后一个，则直接取下一行
    let location = '';
    const after = lines.slice(a + 1, nextA ?? lines.length);
    if (nextA === undefined) {
      // 最后一门：之后第一行是教室（没有就是空，如体育）
      location = after[0] ?? '';
      if (after.length === 2 && !teacher && !lines[a]!.includes('[周]')) {
        teacher = after[0] ?? '';
        location = after[1] ?? '';
      } else if (after.length > 1 && after.slice(1).some(Boolean)) {
        warnings.push(`${dayText} 第${block}块「${name}」之后还有内容没有周次信息，待确认：${after[1]}`);
      }
    } else {
      // 非最后一门：「之后到下一锚点」至少要有课名+教师 2 行，多出的第一行才是教室
      location = hasLocation(after) ? after[0]! : '';
    }

    courses.push({ name, teacher, location, weekday, block, weeks });
    prevAnchor = a;
  }
}

/** 「3-16」「8,12」「1-15单」「1-16双」（可带「[周]」或「周(32学时)」后缀）→ 周次数组；解析不了返回 null */
export function parseWeeks(text: string): number[] | null {
  const body = text
    .replace(/周[（(](单|双)(?:周)?[）)]$/, '$1周')
    .replace('[周]', '')
    .replace(/周\s*([(（][^)）]*[)）])?$/, '')
    .replace(/\s/g, '')
    .replace(/，/g, ',')
    .replace(/[－–—]/g, '-');
  if (body === '') return null;
  const weeks = new Set<number>();
  for (const part of body.split(',')) {
    const rangeM = /^(\d+)-(\d+)(单|双)?$/.exec(part);
    const singleM = /^(\d+)(单|双)?$/.exec(part);
    if (rangeM) {
      const a = Number(rangeM[1]);
      const b = Number(rangeM[2]);
      if (a < 1 || b < a || b > 60) return null;
      for (let w = a; w <= b; w++) {
        if (rangeM[3] === '单' && w % 2 === 0) continue;
        if (rangeM[3] === '双' && w % 2 === 1) continue;
        if (w >= 1 && w <= 60) weeks.add(w);
      }
    } else if (singleM) {
      const w = Number(singleM[1]);
      if (w < 1 || w > 60) return null;
      if (singleM[2] === '单' && w % 2 === 0) continue;
      if (singleM[2] === '双' && w % 2 === 1) continue;
      if (w >= 1 && w <= 60) weeks.add(w);
    } else {
      return null;
    }
  }
  return weeks.size === 0 ? null : [...weeks].sort((x, y) => x - y);
}
