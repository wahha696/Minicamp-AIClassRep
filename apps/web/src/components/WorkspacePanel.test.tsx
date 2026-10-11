// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceStatus } from '../../../../shared/workspaces';
const api = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock('../api/client', () => ({ renameWorkspace: api.rename }));
import WorkspacePanel from './WorkspacePanel';

function status(name = '我的空间'): WorkspaceStatus {
  return { enabled: true, current: { space_id: 'synthetic', name, bindings: [] }, pending: [], wechat_available: false };
}
beforeEach(() => { api.rename.mockReset().mockResolvedValue({ ok: true }); });
afterEach(cleanup);
describe('唯一空间', () => {
  it('未登录也显示默认名字，不提供创建、删除、选择空间', () => {
    render(<WorkspacePanel status={{ ...status(), current: null }} epoch="A" onChanged={vi.fn()}><p>QQ 和微信</p></WorkspacePanel>);
    expect(screen.getByRole('heading', { name: '我的空间' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '课代表空间' }).contains(screen.getByText('QQ 和微信'))).toBe(true);
    expect(screen.queryByRole('button', { name: /新建|删除|进入原空间|确认选择/ })).toBeNull();
    expect(api.rename).not.toHaveBeenCalled();
  });
  it('保存名称并刷新，取消不写入', async () => {
    const changed = vi.fn();
    render(<WorkspacePanel status={status()} epoch="A" onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: '改名' }));
    fireEvent.change(screen.getByLabelText('空间名称'), { target: { value: ' 课程空间 ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(api.rename).toHaveBeenCalledWith('课程空间', 'A');
    fireEvent.click(screen.getByRole('button', { name: '改名' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(api.rename).toHaveBeenCalledOnce();
  });
  it('编辑期间冻结账号代次，失败保留草稿并显示原因', async () => {
    api.rename.mockRejectedValue(new Error('账号已变化'));
    const view = render(<WorkspacePanel status={status()} epoch="old" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '改名' }));
    view.rerender(<WorkspacePanel status={status()} epoch="new" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('alert');
    expect(api.rename).toHaveBeenCalledWith('我的空间', 'old');
    expect(screen.getByLabelText('空间名称')).toBeTruthy();
  });
});
