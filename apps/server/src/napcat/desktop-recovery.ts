// Light hook avoids a onebot -> desktop driver -> onebot import cycle.
import type { DesktopQQStatusDTO } from '../types.js';
let handler: ((uin: string) => number | null) | null = null;
let doneHandler: ((uin: string, since: number) => void) | null = null;
let statusProvider: (() => DesktopQQStatusDTO) | null = null;
export function setDesktopStatusProvider(next: () => DesktopQQStatusDTO): void { statusProvider = next; }
export function getDesktopStatus(): DesktopQQStatusDTO { return statusProvider?.() ?? { supported: false, state: 'idle' }; }
export function setDesktopRecoveryHandler(next: (uin: string) => number | null): void { handler = next; }
export function takeDesktopRecovery(uin: string): number | null { return handler?.(uin) ?? null; }
export function setDesktopRecoveryDoneHandler(next: (uin: string, since: number) => void): void { doneHandler = next; }
export function finishDesktopRecovery(uin: string, since: number): void { doneHandler?.(uin, since); }
