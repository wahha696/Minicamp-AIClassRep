// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDetailDTO } from '../api/types';
import EventDrawer from './EventDrawer';
import { ToastProvider } from './Toast';

const api = vi.hoisted(() => ({
  getEvent: vi.fn(),
  patchEvent: vi.fn(),
  resolveEventProposal: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ...api,
  eventIcsUrl: (id: number) => `/api/events/${id}/export.ics`,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OLD_START = Date.parse('2026-10-04T18:30:00+08:00');
const PROPOSED_START = Date.parse('2026-10-05T19:00:00+08:00');

function pendingDetail(): EventDetailDTO {
  return {
    id: 5,
    group_id: 'demo-club',
    group_name: '摄影社',
    type: 'activity',
    title: '摄影社招新宣讲',
    description: '面向全校新生',
    start_at: OLD_START,
    end_at: null,
    deadline_at: null,
    location: '学生活动中心 201',
    action_required: null,
    status: 'pending_confirm',
    confidence: 0.55,
    level: 1,
    level_locked: false,
    manual_locked_fields: [],
    version: 3,
    created_at: OLD_START - 86_400_000,
    updated_at: OLD_START,
    sources: [
      {
        message_id: 'm-new',
        sender_name: '社长',
        text: '招新宣讲可能改到周一晚七点，在学生活动中心 305',
        sent_at: OLD_START,
      },
    ],
    history: [],
    pending_proposals: [
      {
        id: 41,
        kind: 'update',
        reason: 'low_confidence',
        changes: {
          start_at: { from: OLD_START, to: PROPOSED_START },
          location: { from: '学生活动中心 201', to: '学生活动中心 305' },
        },
        source_message_ids: ['m-new'],
        confidence: 0.55,
        base_version: 3,
        created_at: OLD_START,
      },
    ],
  };
}

function renderDrawer(onChanged = vi.fn()) {
  render(
    <ToastProvider>
      <EventDrawer id={5} onClose={() => {}} onChanged={onChanged} />
    </ToastProvider>,
  );
  return onChanged;
}

beforeEach(() => {
  const detail = pendingDetail();
  api.getEvent.mockResolvedValue(detail);
  api.patchEvent.mockResolvedValue(detail);
  api.resolveEventProposal.mockResolvedValue({
    ...detail,
    status: 'active',
    start_at: PROPOSED_START,
    location: '学生活动中心 305',
    version: 4,
    pending_proposals: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EventDrawer 待确认提案', () => {
  it('同时显示原值、新值、识别原因和对应来源，并带版本接受', async () => {
    const onChanged = renderDrawer();
    expect(await screen.findByRole('heading', { name: '待确认修改' })).toBeTruthy();
    const proposal = screen.getByRole('article', { name: '修改安排提案' });
    expect(within(proposal).getByText('AI 对这条通知的识别把握为 55%，因此保留了原安排等待确认。')).toBeTruthy();
    expect(within(proposal).getByText('学生活动中心 201')).toBeTruthy();
    expect(within(proposal).getByText('学生活动中心 305')).toBeTruthy();
    expect(within(proposal).getByText(/招新宣讲可能改到周一晚七点/)).toBeTruthy();

    fireEvent.click(within(proposal).getByRole('button', { name: '接受修改' }));
    await waitFor(() => expect(api.resolveEventProposal).toHaveBeenCalledWith(
      5, 41, 'accept', 3, pendingDetail().updated_at,
    ));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('可以明确保留原安排', async () => {
    renderDrawer();
    const proposal = await screen.findByRole('article', { name: '修改安排提案' });
    fireEvent.click(within(proposal).getByRole('button', { name: '保留原安排' }));
    await waitFor(() => expect(api.resolveEventProposal).toHaveBeenCalledWith(
      5, 41, 'reject', 3, pendingDetail().updated_at,
    ));
  });

  it('人工修改时间地点时只提交实际改动，并带当前版本', async () => {
    const onChanged = renderDrawer();
    const proposal = await screen.findByRole('article', { name: '修改安排提案' });
    fireEvent.click(within(proposal).getByRole('button', { name: '人工修改' }));
    expect(screen.getByRole('heading', { name: '人工修正事件' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-10-05T20:15' } });
    fireEvent.change(screen.getByLabelText('地点'), { target: { value: '艺术楼 102' } });
    const corrected = {
      ...pendingDetail(),
      start_at: Date.parse('2026-10-05T20:15:00+08:00'),
      location: '艺术楼 102',
      status: 'active' as const,
      version: 4,
      manual_locked_fields: ['start_at', 'location'] as const,
      pending_proposals: [],
    };
    api.patchEvent.mockResolvedValue(corrected);

    fireEvent.click(screen.getByRole('button', { name: '保存人工修正' }));
    await waitFor(() =>
      expect(api.patchEvent).toHaveBeenCalledWith(5, {
        start_at: Date.parse('2026-10-05T20:15:00+08:00'),
        location: '艺术楼 102',
        expected_version: 3,
        expected_updated_at: pendingDetail().updated_at,
      }),
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('结束时间早于开始时间时留在表单并给出错误', async () => {
    renderDrawer();
    const proposal = await screen.findByRole('article', { name: '修改安排提案' });
    fireEvent.click(within(proposal).getByRole('button', { name: '人工修改' }));
    fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-10-04T18:00' } });
    fireEvent.click(screen.getByRole('button', { name: '保存人工修正' }));
    expect(screen.getByRole('alert').textContent).toContain('结束时间必须晚于开始时间');
    expect(api.patchEvent).not.toHaveBeenCalled();
  });

  it('待确认期间不提供完成或取消旁路，必须先处理提案', async () => {
    renderDrawer();
    expect(await screen.findByText('请先处理待确认修改，再标记完成或取消')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '标记完成' })).toBeNull();
    expect(screen.queryByRole('button', { name: '标记取消' })).toBeNull();
  });

  it('确认旧版待确认记录失败后刷新详情和并发令牌', async () => {
    const initial = { ...pendingDetail(), pending_proposals: [] };
    const refreshed = { ...initial, updated_at: initial.updated_at + 1 };
    api.getEvent.mockReset();
    api.getEvent.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    api.patchEvent.mockRejectedValueOnce(new Error('事件已发生变化，请刷新后重新编辑'));

    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: '确认当前安排' }));

    await waitFor(() => expect(api.getEvent).toHaveBeenCalledTimes(2));
    expect(api.patchEvent).toHaveBeenCalledWith(5, {
      status: 'active',
      expected_version: initial.version,
      expected_updated_at: initial.updated_at,
    });
  });

  it('调级失败后刷新详情和并发令牌', async () => {
    const initial = pendingDetail();
    const refreshed = { ...initial, level: 2 as const, updated_at: initial.updated_at + 1 };
    api.getEvent.mockReset();
    api.getEvent.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    api.patchEvent.mockRejectedValueOnce(new Error('事件已发生变化，请刷新后重新编辑'));

    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: '高' }));

    await waitFor(() => expect(api.getEvent).toHaveBeenCalledTimes(2));
    expect(api.patchEvent).toHaveBeenCalledWith(5, {
      level: 3,
      expected_version: initial.version,
      expected_updated_at: initial.updated_at,
    });
  });

  it('解除人工保护失败后刷新详情和并发令牌', async () => {
    const initial = { ...pendingDetail(), manual_locked_fields: ['location'] as const };
    const refreshed = { ...initial, updated_at: initial.updated_at + 1 };
    api.getEvent.mockReset();
    api.getEvent.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);
    api.patchEvent.mockRejectedValueOnce(new Error('事件已发生变化，请刷新后重新编辑'));

    renderDrawer();
    fireEvent.click(await screen.findByRole('button', { name: '允许 AI 按后续通知更新' }));

    await waitFor(() => expect(api.getEvent).toHaveBeenCalledTimes(2));
    expect(api.patchEvent).toHaveBeenCalledWith(5, {
      unlock_fields: ['location'],
      expected_version: initial.version,
      expected_updated_at: initial.updated_at,
    });
  });
});
