// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodosDTO } from '../api/types';
import TodoBox from './TodoBox';
import { ToastProvider } from './Toast';

const api = vi.hoisted(() => ({
  createTodo: vi.fn(),
  patchEvent: vi.fn(),
  patchTodo: vi.fn(),
}));
const access = vi.hoisted(() => ({ readonly: false }));
vi.mock('./ConnectStatus', () => ({ useAccess: () => access }));

vi.mock('../api/client', () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pendingTodos: TodosDTO = {
  events: [
    {
      id: 17,
      group_id: 'g1',
      group_name: '高数群',
      type: 'assignment',
      title: '实验报告要求待确认',
      description: '',
      start_at: null,
      end_at: null,
      deadline_at: null,
      location: null,
      action_required: null,
      status: 'pending_confirm',
      confidence: 0.4,
      level: 2,
      level_locked: false,
      manual_locked_fields: [],
      version: 3,
      created_at: 1,
      updated_at: 2,
    },
  ],
  manual: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  access.readonly = false;
});

describe('TodoBox 待确认事件', () => {
  it('手机只读时隐藏添加，禁止勾选；仍能打开群事项详情', () => {
    access.readonly = true;
    const onOpenEvent = vi.fn();
    render(<ToastProvider><TodoBox data={pendingTodos} loading={false} onChanged={() => {}} onOpenEvent={onOpenEvent} /></ToastProvider>);
    expect(screen.queryByRole('button', { name: '添加手动待办' })).toBeNull();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '实验报告要求待确认' }));
    expect(onOpenEvent).toHaveBeenCalledWith(17);
    expect(api.patchEvent).not.toHaveBeenCalled();
  });

  it('初次读取失败不显示没有待办；缓存读取失败保留内容并提示', () => {
    const { rerender } = render(<ToastProvider><TodoBox data={undefined} loading={false} error={new Error('网络断开')} onChanged={() => {}} onOpenEvent={() => {}} /></ToastProvider>);
    expect(screen.queryByText('没有待办')).toBeNull();
    expect(screen.getByText('暂时无法读取，不能确定是否有安排')).toBeTruthy();
    rerender(<ToastProvider><TodoBox data={pendingTodos} loading={false} error={new Error('网络断开')} onChanged={() => {}} onOpenEvent={() => {}} /></ToastProvider>);
    expect(screen.getByText('更新失败，以下为上次成功数据')).toBeTruthy();
    expect(screen.getByText('实验报告要求待确认')).toBeTruthy();
  });
  it('勾选时打开详情核对，不直接完成或弹完成确认', () => {
    const onOpenEvent = vi.fn();
    render(
      <ToastProvider>
        <TodoBox
          data={pendingTodos}
          loading={false}
          onChanged={() => {}}
          onOpenEvent={onOpenEvent}
        />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: '核对「实验报告要求待确认」的待确认修改' }));

    expect(onOpenEvent).toHaveBeenCalledWith(17);
    expect(api.patchEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '是否确认完成？' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('请先核对通知');
  });
});
