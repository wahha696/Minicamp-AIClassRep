// Reproducible visual fixture. Not an entry of the production Vite build.
import React from 'react';
import { createRoot } from 'react-dom/client';
import WeekGrid from '../src/components/WeekGrid';
import { parseTimetable } from '../../../shared/timetable-import';
import { dateStamp, DAY } from '../../../shared/timetable';
import '../src/index.css';
const cell = (name: string, weeks = '1-4') => `${name}\n验收教师\n${weeks}[周]\n验收楼101`;
const parsed = parseTimetable([
  ['节次', '周一', '周二', '周三', '周四', '周五'],
  ['1-4', `${cell('同格课程甲（完整名称）')}\n${cell('同格课程乙（全部可见）')}`, cell('单周课程', '1-4单')],
  ['3-5', '', cell('双周课程', '1-4双')],
  ['9-12', '', '', cell('九至十二节连堂')],
  ['11-12', '', '', '', cell('十一至十二节晚课')],
]);
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main className="min-w-0 p-3">
      <h1 className="mb-4 text-lg font-semibold">6 条规则 · 第 1 周应为 5 课次 / 1 冲突</h1>
      <WeekGrid
        days={Array.from({ length: 7 }, (_, i) => ({
          from: dateStamp('2026-09-07') + i * DAY,
          isToday: false,
        }))}
        courses={parsed.courses}
        timetable={{ semester_start: '2026-09-07', courses: parsed.courses }}
        itemsByDay={[]}
        onPick={() => {}}
      />
    </main>
  </React.StrictMode>,
);
