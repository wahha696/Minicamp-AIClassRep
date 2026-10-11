// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupProcessingFailureDTO } from '../api/types';
import GroupFailureNotice from './GroupFailureNotice';

afterEach(cleanup);
const failure: GroupProcessingFailureDTO = {
  pending_count: 20, failed_attempts: 3, reason: 'invalid_output', paused: true,
  next_retry_at: null, last_failed_at: Date.parse('2026-10-07T12:00+08:00'),
};

describe('失败群提示', () => {
  it('解释失败和暂停，用户可明确点击重试', () => {
    const onRetry = vi.fn();
    render(<GroupFailureNotice failure={failure} enabled readonly={false} busy={false} onRetry={onRetry} />);
    expect(screen.getByRole('status').textContent).toContain('连续失败 3 次');
    expect(screen.getByText(/还有 20 条消息待整理/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试整理' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('手机只读访问没有无法使用的重试按钮', () => {
    render(<GroupFailureNotice failure={failure} enabled readonly busy={false} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('请在电脑上重试或修改 AI 配置。')).toBeTruthy();
  });

  it('关闭监听或正在提交时不能发起重复重试', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<GroupFailureNotice failure={failure} enabled={false} readonly={false} busy={false} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onRetry).not.toHaveBeenCalled();
    rerender(<GroupFailureNotice failure={failure} enabled readonly={false} busy onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('尚未达到上限时说明重试时间和其他群继续工作', () => {
    render(<GroupFailureNotice failure={{ ...failure, failed_attempts: 1, paused: false,
      reason: 'network', next_retry_at: Date.parse('2026-10-07T12:01+08:00') }}
      enabled readonly={false} busy={false} onRetry={vi.fn()} />);
    expect(screen.getByText(/预计 12:01:00 后自动重试/)).toBeTruthy();
    expect(screen.queryByText(/已暂停自动整理/)).toBeNull();
  });

  it('后台重试已开始后不重复提交，也不继续显示上一次的失败原因', () => {
    const onRetry = vi.fn();
    render(<GroupFailureNotice failure={{ ...failure, failed_attempts: 0, paused: false, next_retry_at: null }}
      enabled readonly={false} busy={false} onRetry={onRetry} />);
    expect(screen.queryByText(/内容格式不正确/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试中…' }));
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('无法保存暂停状态时明确说明重启后的限制', () => {
    render(<GroupFailureNotice failure={{ ...failure, state_saved: false }} enabled readonly={false} busy={false} onRetry={vi.fn()} />);
    expect(screen.getByText(/重启后可能再次尝试/)).toBeTruthy();
  });
});
