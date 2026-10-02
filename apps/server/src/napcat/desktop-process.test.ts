import { describe, expect, it, vi } from 'vitest';
import { createQQHandle, type QQProcess } from './desktop-process.js';

const process = (pid: number, visible = true): QQProcess => ({ pid, started: `time-${pid}`, started_ms: 1000, visible });
describe('desktop QQ process ownership', () => {
  it('tracks the actual QQ process after the bootstrap exits', async () => {
    let processes = [process(1), process(2)];
    const terminate = vi.fn(async (pid: number) => { processes = processes.filter((p) => p.pid !== pid); });
    const handle = createQQHandle(async () => processes, terminate, 1000);
    expect(await handle.poll()).toBe('open');
    processes = [process(2)];
    expect(await handle.poll()).toBe('open');
    await handle.close();
    expect(terminate).toHaveBeenCalledExactlyOnceWith(2);
  });
  it('detects closing to tray after two checks; a minimized window remains open', async () => {
    let processes = [process(1)];
    const handle = createQQHandle(async () => processes, vi.fn(), 1000);
    expect(await handle.poll()).toBe('open');
    expect(await handle.poll()).toBe('open');
    processes = [process(1, false)];
    expect(await handle.poll()).toBe('open');
    expect(await handle.poll()).toBe('closed');
  });
  it('does not kill pre-existing processes or a reused PID', async () => {
    let processes = [process(1), { ...process(3), started_ms: -5000 }];
    const terminate = vi.fn();
    const handle = createQQHandle(async () => processes, terminate, 1000);
    expect(await handle.poll()).toBe('open');
    processes = [{ ...process(1), started: 'new-process' }, { ...process(3), started_ms: -5000 }];
    await handle.close();
    expect(terminate).not.toHaveBeenCalled();
  });
});
