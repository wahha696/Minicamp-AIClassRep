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
});

describe('TodoBox 待确认事件', () => {
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
