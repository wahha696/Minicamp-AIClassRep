import * as cheerio from 'cheerio';
import { parseTimetable, type ParsedTimetable, type MergeRange } from '../../../shared/timetable-import.js';

/** 只展开每张表自己的行；嵌套的校历/布局表不能混入课程行。 */
export function parseTimetableHtml(html: string): ParsedTimetable | null {
  const $ = cheerio.load(html);
  const results: ParsedTimetable[] = [];
  for (const [tableIndex, table] of $('table').toArray().entries()) {
    const rows: string[][] = [];
    const merges: MergeRange[] = [];
    const occupied = new Set<string>();
    $(table).find('tr').filter((_, tr) => $(tr).closest('table')[0] === table).each((r, tr) => {
      const row: string[] = [];
      let c = 0;
      $(tr).children('td,th').each((_, cell) => {
        while (occupied.has(`${r}:${c}`)) row[c++] = '';
        const colspan = Math.min(100, Math.max(1, Number($(cell).attr('colspan')) || 1));
        const rowspan = Math.min(100, Math.max(1, Number($(cell).attr('rowspan')) || 1));
        const copy = $(cell).clone();
        copy.find('table,script,style').remove();
        copy.find('br').replaceWith('\n');
        copy.find('div,p').append('\n');
        row[c] = copy.text().replace(/\u00a0/g, ' ').trim();
        if (rowspan>1 || colspan>1) merges.push({s:{r,c},e:{r:r+rowspan-1,c:c+colspan-1}});
        for (let dr = 0; dr < rowspan; dr++) {
          for (let dc = 0; dc < colspan; dc++) {
            occupied.add(`${r + dr}:${c + dc}`);
            if (dc) row[c + dc] = '';
          }
        }
        c += colspan;
      });
      rows.push(row);
    });
    const normalized = rows.map(row => row.map(value => {
      const period = /^(?:第)?(\d{1,2})\s*[,，、－\-–—~至]\s*(\d{1,2})(?:节)?$/.exec(value);
      return period ? `${period[1]}-${period[2]}` : value;
    }));
    // 必须有完整星期表头或横排节次表头；不能仅凭 id=kbtable 接受校历。
    const transposed = normalized.findIndex(row => row.filter(c => /^\d{1,2}-\d{1,2}$/.test(c)).length >= 2);
    const weekdays = normalized.findIndex(row => row.filter(c => /^(星期|周)[一二三四五六日天]$/.test(c)).length>=2);
    if (transposed < 0 && weekdays < 0) continue;
    results.push(parseTimetable(normalized, {sheet:`网页表 ${tableIndex+1}`,merges}));
  }
  if (!results.length) return null;
  return { courses:results.flatMap(r=>r.courses), warnings:results.flatMap(r=>r.warnings), items:results.flatMap(r=>r.items??[]), semesterStart:results.find(r=>r.semesterStart)?.semesterStart };
}
