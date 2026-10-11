// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultReminderRules } from '../../../../shared/reminders';
const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('../api/client', () => ({ getReminderSettings: api.get, saveReminderTimes: api.save }));
import ReminderSection from './ReminderSection';
beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ ...defaultReminderRules(), delivery_ready: false });
  api.save.mockReset().mockImplementation(async (before_minutes: number[], daily_limit: number) => {
    const settings = { ...defaultReminderRules(), before_minutes, daily_limit, delivery_ready: false };
    api.get.mockResolvedValue(settings); return settings;
  });
});
afterEach(cleanup);
it('服务端非默认值首次显示即能编辑，不被初始回填覆盖', async () => {
  api.get.mockResolvedValue({ ...defaultReminderRules(), before_minutes: [180], daily_limit: 4, delivery_ready: false });
  render(<ReminderSection />);
  const hours = await screen.findByDisplayValue('3');
  fireEvent.change(hours, { target: { value: '0.5' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith([30], 4));
});
it('仅加载不启用或保存，保存自定义时间和每日上限仍关闭发送', async () => {
  render(<ReminderSection />);
  await waitFor(() => expect((screen.getByLabelText('截止前多少小时提醒') as HTMLInputElement).disabled).toBe(false));
  const toggle = screen.getByRole('switch', { name: '消息提醒' });
  expect(toggle.getAttribute('aria-checked')).toBe('false'); expect((toggle as HTMLButtonElement).disabled).toBe(true);
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('截止前多少小时提醒'), { target: { value: '12, 0.5' } });
  fireEvent.change(screen.getByLabelText('每天提醒上限（条）'), { target: { value: '6' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith([720, 30], 6));
  expect(toggle.getAttribute('aria-checked')).toBe('false');
});
it('读取失败禁止覆盖，重试恢复；未保存输入不被轮询覆盖', async () => {
  api.get.mockRejectedValueOnce(new Error('synthetic read error'));
  render(<ReminderSection />); await screen.findByText(/synthetic read error/);
  expect((screen.getByLabelText('截止前多少小时提醒') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect((screen.getByLabelText('截止前多少小时提醒') as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('截止前多少小时提醒'), { target: { value: '8, 1' } });
  fireEvent(window, new Event('classrep:resumed'));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
  expect((screen.getByLabelText('截止前多少小时提醒') as HTMLInputElement).value).toBe('8, 1');
});
