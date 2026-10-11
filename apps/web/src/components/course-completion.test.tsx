// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CourseCard } from './WeekGrid';
import { dateStamp, expandTimetable } from '../../../../shared/timetable';
const monday = dateStamp('2026-09-07');
const table = { semester_start: '2026-09-07', courses: [{ id: 'synthetic-physics', name: '合成物理', teacher: '', location: '', weekday: 1 as const, block: 1, weeks: [1, 2] }] };
const occurrences = expandTimetable(table, monday, monday + 14 * 86_400_000);
afterEach(cleanup);
function openCard(name = '合成物理') { fireEvent.click(screen.getAllByText(name)[0]!.closest('summary')!); }
it('真实课次显示明确日期、时段和仅本次范围，点击完成使用调用方指定的课次', () => {
  const toggle = vi.fn(); render(<CourseCard occurrence={occurrences[0]!} completion={{ done: false, onToggle: toggle }} />); openCard();
  expect(screen.getByText(/仅记录 2026-09-07 08:00–09:40/)).toBeTruthy();
  expect(screen.getByText(/不改变整学期或未来课程/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '完成这节课：合成物理 2026-09-07 08:00' })); expect(toggle).toHaveBeenCalledOnce();
});
it('完成态保留课程且可撤销，同名下周课不被标记', () => {
  const undo = vi.fn(); const { container } = render(<><CourseCard occurrence={occurrences[0]!} completion={{ done: true, onToggle: undo }} /><CourseCard occurrence={occurrences[1]!} completion={{ done: false, onToggle: vi.fn() }} /></>);
  expect(screen.getAllByText('本次已完成')).toHaveLength(1);
  container.querySelectorAll('details').forEach(item => { item.open = true; });
  fireEvent.click(screen.getByRole('button', { name: '撤销完成：合成物理 2026-09-07 08:00' })); expect(undo).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '完成这节课：合成物理 2026-09-14 08:00' })).toBeTruthy();
});
it('预览不提供写操作，状态不可读或保存中禁用按钮', () => {
  const { rerender } = render(<CourseCard occurrence={occurrences[0]!} />); openCard(); expect(screen.queryByRole('button')).toBeNull();
  rerender(<CourseCard occurrence={occurrences[0]!} completion={{ done: false, disabled: true, onToggle: vi.fn(), error: '无法确认当前完成状态' }} />);
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true); expect(screen.getByRole('alert').textContent).toContain('无法确认');
  rerender(<CourseCard occurrence={occurrences[0]!} completion={{ done: false, busy: true, onToggle: vi.fn() }} />);
  expect(screen.getByRole('button').textContent).toBe('正在保存…'); expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});
