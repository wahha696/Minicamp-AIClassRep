// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectStatusDTO } from '../api/types';
import ReturnQQ from './ReturnQQ';
import { ToastProvider } from './Toast';

const mocked = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn(), refresh: vi.fn(), connection: {} as ConnectStatusDTO }));
vi.mock('../api/client', () => ({ startDesktopQQ: mocked.start, returnFromDesktopQQ: mocked.resume, qrcodeUrl: () => '/qr.png' }));
vi.mock('./ConnectStatus', () => ({ useConnectStatus: () => ({ data: mocked.connection, refresh: mocked.refresh }) }));
beforeEach(() => {
  mocked.connection = { state: 'online', account_epoch: 'epoch-a', uin: '10001', since: 0, first_run: false,
    desktop_qq: { supported: true, state: 'idle' } };
  mocked.refresh.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ReturnQQ', () => {
  it('starts a switch using the current account snapshot', async () => {
    render(<ToastProvider><ReturnQQ /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: '返回QQ' }));
    await waitFor(() => expect(mocked.start).toHaveBeenCalledWith({ accountEpoch: 'epoch-a', uin: '10001' }));
  });
  it('restores the covering dialog after refresh and sends the frozen session on return', async () => {
    mocked.connection.desktop_qq = { supported: true, state: 'qq', session_id: 'session-a', uin: '10001' };
    render(<ToastProvider><ReturnQQ /></ToastProvider>);
    expect(screen.getByRole('alertdialog', { name: '已返回QQ' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回ClassRep' }));
    await waitFor(() => expect(mocked.resume).toHaveBeenCalledWith({ accountEpoch: 'epoch-a', uin: '10001' }, 'session-a'));
  });
  it('keeps the dialog covering the page while recovering and clears it on automatic return', () => {
    mocked.connection.desktop_qq = { supported: true, state: 'resuming', session_id: 'session-a' };
    const view = render(<ToastProvider><ReturnQQ /></ToastProvider>);
    expect((screen.getByRole('button', { name: '返回ClassRep' }) as HTMLButtonElement).disabled).toBe(true);
    mocked.connection = { ...mocked.connection, desktop_qq: { supported: true, state: 'idle' } };
    view.rerender(<ToastProvider><ReturnQQ /></ToastProvider>);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('间断期间');
  });
});
