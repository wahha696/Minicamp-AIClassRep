import { describe, expect, it } from 'vitest';
import standard from '../../web/src/lib/__fixtures__/timetable-rows.json';
import transposed from '../../web/src/lib/__fixtures__/timetable-rows-2.json';
import { parseTimetable } from '../../../shared/timetable-import.js';
import { parseKbtable, parseSectionLabel, toCourseDTOs } from './csujwc.js';
import { parseTimetableHtml } from './timetable-html.js';
import { parseWeeks } from '../../../shared/timetable-import.js';

const escape = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
function table(rows: unknown[][]): string {
  return '<table id="kbtable">' + rows.map(row => '<tr>' + row.map(cell => `<td>${escape(cell)}</td>`).join('') + '</tr>').join('') + '</table>';
}
describe('网页课表真实导出布局回归', () => {
  it.each(['3-16(周)', '3-16（周）', '3-16[周]'])('识别网页周次 %s', text => {
    expect(parseWeeks(text)).toEqual(Array.from({ length: 14 }, (_, i) => i + 3));
  });
  it('配对简版与隐藏详情只导入一次，保留教师及同名不同天排课', () => {
    const course = (id: string, location: string) =>
      `<div id="${id}-1" class="kbcontent1">课程甲<br><font title="周次(节次)">3-16(周)</font><br>${location}<br></div>` +
      `<div id="${id}-2" class="kbcontent" style="display: none;">课程甲<br><font title="老师">教师甲</font><br><font title="周次(节次)">3-16(周)</font><br>${location}<br></div>`;
    const p = parseTimetableHtml('<table id="kbtable"><tr><th></th><th>星期日</th><th>星期一</th><th>星期二</th></tr>' +
      `<tr><td>5－6</td><td></td><td>${course('one', 'A101')}</td><td>${course('two', '')}</td></tr></table>`)!;
    expect(p.courses).toHaveLength(2);
    expect(p.courses).toMatchObject([
      { name: '课程甲', teacher: '教师甲', location: 'A101', weekday: 1, start_period: 5, end_period: 6 },
      { name: '课程甲', teacher: '教师甲', location: '', weekday: 2, start_period: 5, end_period: 6 },
    ]);
    expect(p.items?.every(i => i.status === 'parsed')).toBe(true);
    expect(p.warnings).toEqual([]);
  });
  it('只有简版时保留课程，不凭空填教师', () => {
    const p = parseTimetableHtml('<table><tr><th></th><th>星期日</th><th>星期一</th></tr><tr><td>1-2</td><td></td><td><div class="kbcontent1" id="solo-1">课程甲<br>1-2(周)<br>A101<br></div></td></tr></table>')!;
    expect(p.courses).toMatchObject([{ name: '课程甲', teacher: '', location: 'A101', weeks: [1, 2] }]);
  });
  it.each([['星期横排', standard], ['节次横排及校历', transposed]] as const)('%s 与文件导入结果一致', (_, rows) => {
    const parsed = parseKbtable(table(rows));
    expect(toCourseDTOs(parsed.raw, parsed.warnings)).toMatchObject(parseTimetable(rows as string[][],{sheet:'网页表 1'}).courses);
    expect(parsed.raw).toHaveLength(13);
    expect(parsed.warnings).toEqual(parseTimetable(rows as string[][],{sheet:'网页表 1'}).warnings);
  });
  it('处理嵌套布局表及 colspan 节次表头', () => {
    const html = '<table><tr><td><table id="kbtable"><tr><td></td><td colspan="2">1－2</td><td colspan="2">3－4</td></tr>' +
      '<tr><td>星期二</td><td colspan="2">课程甲<br>1-16周(32学时)<br>A101<br>某班</td><td colspan="2">课程乙<br>3-18周(32学时)<br>B202<br>某班</td></tr>' +
      '<tr><td>校历</td><td>2026-9</td><td>第1周</td></tr></table></td></tr></table>';
    const p = parseKbtable(html);
    expect(toCourseDTOs(p.raw)).toMatchObject([{ name: '课程甲', weekday: 2, start_period: 1, end_period: 2 }, { name: '课程乙', weekday: 2, start_period: 3, end_period: 4 }]);
  });
  it('网页第一列是周日时按表头映射，不整体右移', () => {
    const html = '<table id="kbtable"><tr><td>节次/星期</td><td>星期日</td><td>星期一</td><td>星期二</td><td>星期三</td></tr>' +
      '<tr><td>第5-6节</td><td></td><td>创新创业导论<br>1-16周<br>王老师<br>B座508</td><td></td><td></td></tr></table>';
    const p = parseKbtable(html);
    expect(toCourseDTOs(p.raw)).toMatchObject([{ name: '创新创业导论', weekday: 1, start_period: 5, end_period: 6 }]);
  });
  it.each(['2026-9', '2026-09-07', '2027-1', '1-16周', 'A座1-2'])('不把 %s 当成节次', text => {
    expect(parseSectionLabel(text)).toBeNull();
  });
});
