// Deterministic, synthetic acceptance workbook. No student information.
// node scripts/timetable-fixtures.mjs /absolute/path/acceptance.xlsx
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const XLSX = require('xlsx');
const output = process.argv[2];
if (!output) throw new Error('Pass the output .xlsx path');
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['说明页，请选择验收课表工作表']]), '说明');
const cell = (name, weeks = '1-4', teacher = '测试教师', room = '测试楼101') =>
  `${name}\n${teacher}\n${weeks}[周]\n${room}`;
const rows = [
  ['节次', '周一', '周二', '周三', '周四', '周五'],
  ['1-4', `${cell('同格课程甲')}\n${cell('同格课程乙')}`, cell('单周课程', '1-4单'), '', '', ''],
  ['3-5', '', cell('双周课程', '1-4双'), '', '', ''],
  ['9-12', '', '', cell('九至十二节连堂'), '', ''],
  ['11-12', '', '', '', cell('十一至十二节晚课'), ''],
  ['5-6', '', '', '', '', '需要手动确认的原始片段'],
];
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '验收课表');
XLSX.writeFile(workbook, output);
console.log(output);
