// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssistantReply } from '../../../../shared/assistant';
const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../api/assistant', () => ({ assistantRequest: mock.request }));
import AssistantPanel from './AssistantPanel';
const plan = { id: 'plan-one', summary: '将合成物理作业标记为完成', scope: 'current_space' as const, expiresAt: Date.now() + 600_000, actions: [{ tool: 'event.update', args: { id: 10, status: 'done' }, label: '完成合成物理作业', policy: 'confirm' as const }] };
function show(epoch = 'space-epoch-a') { return render(<MemoryRouter><AssistantPanel epoch={epoch} onClose={() => {}} /></MemoryRouter>); }
function send(text: string) { fireEvent.change(screen.getByRole('textbox', { name: '给助手的消息' }), { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: '发送' })); }
beforeEach(() => { localStorage.clear(); mock.request.mockReset().mockImplementation(async (_epoch: string, path: string) => {
  if (path.endsWith('/capabilities')) return { capabilities: [{ name: 'event.update', label: '调整事项', policy: 'confirm', description: '调整事项完成状态', parameters: {} }] };
  if (path.endsWith('/session')) return { ok: true };
  if (path.endsWith('/chat')) return { text: '请检查操作预览。', plan };
  if (path.endsWith('/confirm')) return { text: '执行完毕。', results: [{ tool: 'event.update', ok: true, message: '已标记完成' }] };
  if (path.endsWith('/cancel')) return { ok: true };
  if (path.endsWith('/memories')) return { scope: 'current_space', rules: [], recent_suppressions: [] };
  return { ok: true };
}); });
afterEach(cleanup);
it('模型计划仅预览；用户明确点确认才执行，按回执显示成功', async () => {
  show(); send('标记作业完成');
  await screen.findByRole('region', { name: '待确认操作' });
  expect(mock.request.mock.calls.some(call => String(call[1]).endsWith('/confirm'))).toBe(false);
  expect((screen.getByRole('textbox', { name: '给助手的消息' }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '确认执行这些操作' }));
  await screen.findByText('已标记完成');
  expect(mock.request).toHaveBeenCalledWith('space-epoch-a', '/api/assistant/plans/plan-one/confirm', 'POST', { confirmed: true }, expect.any(AbortSignal));
  expect(screen.queryByRole('region', { name: '待确认操作' })).toBeNull();
});
it('取消计划不会确认或执行操作', async () => {
  show(); send('调整设置'); await screen.findByText('请检查操作预览。');
  fireEvent.click(screen.getByRole('button', { name: '取消计划' }));
  await screen.findByText('已取消这次计划，没有执行其中的操作。');
  expect(mock.request.mock.calls.some(call => String(call[1]).endsWith('/confirm'))).toBe(false);
});
it('空间epoch改变立即清空对话、计划和会话', async () => {
  const view = show(); send('旧空间的合成机密'); await screen.findByText('请检查操作预览。');
  view.rerender(<MemoryRouter><AssistantPanel epoch="space-epoch-b" onClose={() => {}} /></MemoryRouter>);
  expect(screen.queryByText('旧空间的合成机密')).toBeNull(); expect(screen.queryByRole('button', { name: '确认执行这些操作' })).toBeNull();
  send('新空间'); await screen.findByText('请检查操作预览。');
  expect(mock.request).toHaveBeenCalledWith('space-epoch-b', '/api/assistant/session', 'POST', {}, expect.any(AbortSignal));
  const body = mock.request.mock.calls.filter(call => call[0] === 'space-epoch-b' && String(call[1]).endsWith('/chat'))[0]?.[3];
  expect(JSON.stringify(body)).not.toContain('旧空间');
});
it('换空间后迟到的回复不可进入新会话', async () => {
  let resolve!: (value: AssistantReply) => void;
  mock.request.mockImplementation(async (_epoch, path) => path.endsWith('/capabilities') ? { capabilities: [] } : path.endsWith('/session') ? { ok: true } : new Promise<AssistantReply>(r => { resolve = r; }));
  const view = show(); send('旧请求'); await waitFor(() => expect(resolve).toBeTypeOf('function'));
  view.rerender(<MemoryRouter><AssistantPanel epoch="new" onClose={() => {}} /></MemoryRouter>);
  resolve({ text: '旧空间迟到内容', plan });
  await waitFor(() => expect(screen.queryByText('旧空间迟到内容')).toBeNull());
});
it('错误回执如实显示未完成，任意模型URL不产生链接', async () => {
  mock.request.mockImplementation(async (_epoch, path) => path.endsWith('/capabilities') ? { capabilities: [] } : path.endsWith('/session') ? { ok: true } : { text: '不能操作', results: [{ tool: 'fake', ok: false, message: '对象已变更', href: 'https://untrusted.example/' }] });
  show(); send('操作'); await screen.findByText('对象已变更');
  expect(screen.getByText('未完成')).toBeTruthy(); expect(screen.queryByRole('link')).toBeNull(); expect(screen.queryByRole('button', { name: '前往相应页面' })).toBeNull();
});
it('长期偏好没有默认规则；指定课程和类型后才允许明确保存', async () => {
  show(); fireEvent.click(screen.getByRole('button', { name: '长期记忆' }));
  await screen.findByText('暂无长期记忆。只有你明确保存的规则才会生效。');
  expect(screen.getByText(/没有绑定课程的群不会被排除/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '新增长期偏好' }));
  fireEvent.change(screen.getByLabelText('偏好内容'), { target: { value: '合成数学作业不进日程' } });
  fireEvent.change(screen.getByLabelText('偏好作用'), { target: { value: 'exclude_calendar' } });
  expect((screen.getByRole('button', { name: '保存偏好' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('偏好课程名称'), { target: { value: '合成数学' } }); fireEvent.click(screen.getByLabelText('作业'));
  fireEvent.click(screen.getByRole('button', { name: '保存偏好' }));
  await waitFor(() => expect(mock.request).toHaveBeenCalledWith('space-epoch-a', '/api/assistant/memories', 'POST', { text: '合成数学作业不进日程', action: 'exclude_calendar', course: '合成数学', event_types: ['assignment'], enabled: true }));
});
it('浏览器桌宠设置只执行显式确认且与计划一致的回执', async () => {
  const browserAction = { kind: 'pet_settings', patch: { style: '合成语气', visible: false } };
  const localPlan = { ...plan, actions: [{ tool: 'settings.pet', args: browserAction.patch, label: '调整桌宠', policy: 'confirm' }] };
  mock.request.mockImplementation(async (_epoch, path) => path.endsWith('/capabilities') ? { capabilities: [] } : path.endsWith('/session') ? { ok: true } : path.endsWith('/chat') ? { text: '预览', plan: localPlan, results: [{ tool: 'settings.pet', ok: true, message: '未经确认的回执', browserAction }] } : { text: '已确认', results: [{ tool: 'settings.pet', ok: true, message: '确认回执', browserAction }] });
  show(); send('调整桌宠'); await screen.findByText('预览');
  expect(localStorage.getItem('classrep.pet.style')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '确认执行这些操作' }));
  await screen.findByText(/本浏览器的桌宠设置已保存并应用/);
  expect(localStorage.getItem('classrep.pet.style')).toBe('合成语气'); expect(localStorage.getItem('classrep.pet.hidden')).toBe('1');
});
it('服务器回执的浏览器操作与确认计划不符时拒绝应用', async () => {
  mock.request.mockImplementation(async (_epoch, path) => path.endsWith('/capabilities') ? { capabilities: [] } : path.endsWith('/session') ? { ok: true } : path.endsWith('/chat') ? { text: '预览', plan } : { text: '回执', results: [{ tool: 'settings.pet', ok: true, message: '设置', browserAction: { kind: 'pet_settings', patch: { style: '未授权语气' } } }] });
  show(); send('完成事项'); await screen.findByText('预览'); fireEvent.click(screen.getByRole('button', { name: '确认执行这些操作' }));
  await screen.findByText('浏览器操作与已确认计划不符，未应用本地设置。'); expect(localStorage.getItem('classrep.pet.style')).toBeNull();
});
it('查询返回数据可查看，凭证字段不出现在回执内容中', async () => {
  mock.request.mockImplementation(async (_epoch, path) => path.endsWith('/capabilities') ? { capabilities: [] } : path.endsWith('/session') ? { ok: true } : { text: '已查到事项', results: [{ tool: 'events.list', ok: true, message: '查询完成', data: [{ title: '合成阅读作业', status: 'active', api_key: 'synthetic-hidden-key' }] }] });
  show(); send('看事项'); await screen.findByText('合成阅读作业');
  expect(screen.queryByText('synthetic-hidden-key')).toBeNull(); expect(screen.getByText('进行中')).toBeTruthy();
});
it('长期记忆可修改、启停，删除需要再次确认且保留消息范围提示', async () => {
  mock.request.mockImplementation(async (_epoch, path, method) => path.endsWith('/capabilities') ? { capabilities: [] } : path.endsWith('/memories') && (method === undefined || method === 'GET') ? { scope: 'current_space', rules: [{ id: 6, text: '合成偏好', course: '', action: 'note', event_types: [], enabled: true }], recent_suppressions: [] } : { ok: true });
  show(); fireEvent.click(screen.getByRole('button', { name: '长期记忆' })); await screen.findByText('合成偏好');
  fireEvent.click(screen.getByRole('button', { name: '停用' }));
  await waitFor(() => expect(mock.request).toHaveBeenCalledWith('space-epoch-a', '/api/assistant/memories/6', 'PATCH', { enabled: false }));
  await waitFor(() => expect((screen.getByRole('button', { name: '修改' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '修改' })); fireEvent.change(screen.getByLabelText('偏好内容'), { target: { value: '修改后的合成偏好' } }); fireEvent.click(screen.getByRole('button', { name: '保存偏好' }));
  await waitFor(() => expect(mock.request).toHaveBeenCalledWith('space-epoch-a', '/api/assistant/memories/6', 'PATCH', { text: '修改后的合成偏好', course: '', action: 'note', event_types: [], enabled: true }));
  await waitFor(() => expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(mock.request.mock.calls.some(call => call[2] === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(mock.request).toHaveBeenCalledWith('space-epoch-a', '/api/assistant/memories/6', 'DELETE', undefined));
});
