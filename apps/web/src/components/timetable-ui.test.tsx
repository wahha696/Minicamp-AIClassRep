// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WeekGrid from './WeekGrid';
import TimetableEditor from './TimetableEditor';
import { dateStamp, type CourseDTO } from '../../../../shared/timetable';
import { parseTimetable } from '../../../../shared/timetable-import';
const save = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('../api/client', () => ({ saveTimetable: save }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const course: CourseDTO = {
  id: 'a',
  name: '完整的连堂课程名称不能仅靠悬停显示',
  teacher: '张老师',
  location: '新校区一教101',
  weekday: 1,
  block: 1,
  start_period: 1,
  end_period: 4,
  weeks: [1],
};
const monday = dateStamp('2026-09-07');
const days = Array.from({ length: 7 }, (_, i) => ({ from: monday + i * 86400000, isToday: false }));
describe('课程可以访问，而不只是数组返回成功', () => {
  it('集中展示待处理事项，定位展开原文，补课自动展开编辑，忽略后更新计数', () => {
    const parsed = parseTimetable([['', '周一', '周二'], ['1-2', '课程A\n张老师\n1[周]\nA101', '待补课程原文']]);
    render(<TimetableEditor parsed={parsed} saved={null} onSaved={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('region', { name: '待处理事项' })).toBeTruthy();
    expect(screen.getByText('还有 1 项需要手动处理')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去处理第 1 项' }));
    const source = document.activeElement!.closest('details')!;
    expect(source.open).toBe(true);
    expect(source.parentElement!.closest('details')!.open).toBe(true);
    expect(source.textContent).toContain('待补课程原文');
    fireEvent.click(source.querySelector('button')!);
    const form = document.activeElement!.closest('details')!;
    expect(form.open).toBe(true);
    expect(form.querySelector('input')?.value).toBe('待补课程原文');
    fireEvent.click(screen.getByRole('button', { name: '去处理第 1 项' }));
    fireEvent.click(Array.from(source.querySelectorAll('button')).find(b => b.textContent?.includes('明确忽略'))!);
    expect(screen.queryByRole('region', { name: '待处理事项' })).toBeNull();
    expect(screen.getByText('待处理事项已清空，核对课表后即可保存。')).toBeTruthy();
  });
  it('同格两门均可见，连堂完整跨行，全天列表不重复计数，可点击展开教师和地点', () => {
    const courses = [course, { ...course, id: 'b', name: '同格另一门' }];
    const { container } = render(
      <WeekGrid
        days={days}
        courses={courses}
        timetable={{ semester_start: '2026-09-07', courses }}
        itemsByDay={[]}
        onPick={() => {}}
      />,
    );
    expect(screen.getByText('本周 2 个实际课次 · 1 处时间冲突')).toBeTruthy();
    expect(screen.getAllByText(course.name)).toHaveLength(4);
    expect(screen.getAllByText('同格另一门')).toHaveLength(4);
    expect(container.querySelectorAll('summary[title]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '展开全天列表' }));
    expect(screen.getAllByText(course.name)).toHaveLength(1);
    expect(screen.getAllByText('同格另一门')).toHaveLength(1);
    const details = screen.getByText(course.name).closest('details')!;
    fireEvent.click(details.querySelector('summary')!);
    expect(details.textContent).toContain('张老师');
    expect(details.textContent).toContain('新校区一教101');
    expect(details.textContent).toContain('08:00–11:40');
  });
  it('单双周按实际周过滤，11–12 节两行可见，开学前无课', () => {
    const courses = [
      { ...course, start_period: 11, end_period: 12 },
      { ...course, id: 'b', name: '双周课', weeks: [2] },
    ];
    const { rerender } = render(
      <WeekGrid
        days={days}
        courses={courses}
        timetable={{ semester_start: '2026-09-07', courses }}
        itemsByDay={[]}
        onPick={() => {}}
      />,
    );
    expect(screen.getAllByText(course.name)).toHaveLength(2);
    expect(screen.queryByText('双周课')).toBeNull();
    expect(screen.getByText('本周 1 个实际课次 · 0 处时间冲突')).toBeTruthy();
    rerender(
      <WeekGrid
        days={days}
        courses={courses}
        timetable={{ semester_start: '2026-09-14', courses }}
        itemsByDay={[]}
        onPick={() => {}}
      />,
    );
    expect(screen.getByText('本周 0 个实际课次 · 0 处时间冲突')).toBeTruthy();
  });
  it('导入有待确认项时禁存；明确忽略有理由，保存请求保留逐项对账和版本', async () => {
    const parsed = parseTimetable([
      ['', '周一', '周二'],
      ['1-4', '课程A\n张老师\n1[周]\nA101', '未知原文'],
    ]);
    render(
      <TimetableEditor
        parsed={parsed}
        saved={{ semester_start: '2026-09-07', courses: [], revision: 7 }}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('我已核对第一周、学期长度、实际作息和全部课程原文。'));
    expect((screen.getByRole('button', { name: '保存课表' }) as HTMLButtonElement).disabled).toBe(true);
    const pending = screen.getByText('未知原文').closest('details')!;
    fireEvent.change(pending.querySelector('input')!, { target: { value: '这是备注，不是课程' } });
    fireEvent.click(
      [...pending.querySelectorAll('button')].find((b) => b.textContent === '明确忽略此片段及关联课程')!,
    );
    fireEvent.click(screen.getByRole('button', { name: '保存课表' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      expected_revision: 7,
      mode: 'merge',
      courses: [{ name: '课程A', start_period: 1, end_period: 4 }],
      import_items: [{ status: 'parsed' }, { status: 'ignored', message: '这是备注，不是课程' }],
    });
  });
  it('重复导入预览显式保护人工修改；替换时要求额外确认', () => {
    render(
      <TimetableEditor
        parsed={{ courses: [course], warnings: [] }}
        saved={{
          semester_start: '2026-09-07',
          revision: 1,
          courses: [{ ...course, location: '人工修改教室', user_modified: true }],
        }}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/保护人工修改 1/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('重复导入方式'), { target: { value: 'replace' } });
    expect(screen.getByLabelText(/我已核对大量减少/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '保存课表' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
