// 密钥的操作系统级保护（成熟度评估 S06）：Windows 用 DPAPI（ProtectedData，CurrentUser 作用域）
// 加密后落盘——密文只有本机当前 Windows 用户能解开；其他平台/失败时返回 null，
// 调用方退回明文存储（README 有声明）。通过 powershell 子进程调 .NET API，不带任何原生依赖。
import { spawnSync } from 'node:child_process';

let available: boolean | undefined; // undefined = 还没探测过

const PS_PROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$d=[System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());' +
  '[Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($d,$null,\'CurrentUser\')))';

const PS_UNPROTECT =
  'Add-Type -AssemblyName System.Security;' +
  '$d=[Convert]::FromBase64String([Console]::In.ReadToEnd());' +
  '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($d,$null,\'CurrentUser\')))';

function runPs(script: string, stdin: string): string | null {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: stdin,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    if (r.status !== 0 || r.error) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/** DPAPI 是否可用：Windows + powershell + 一次往返自检（只探测一次并缓存结果） */
export function dpapiAvailable(): boolean {
  if (available !== undefined) return available;
  available = false;
  if (process.platform !== 'win32') return false;
  const probe = 'classrep-dpapi-probe';
  const enc = runPs(PS_PROTECT, probe);
  available = enc !== null && runPs(PS_UNPROTECT, enc) === probe;
  return available;
}

/** UTF-8 字符串 → DPAPI(CurrentUser) 密文 base64；不可用返回 null */
export function protectString(plain: string): string | null {
  if (!dpapiAvailable()) return null;
  return runPs(PS_PROTECT, plain);
}

/** DPAPI 密文 base64 → 原文；解密失败（换了 Windows 用户/机器/文件损坏）返回 null */
export function unprotectString(b64: string): string | null {
  if (!dpapiAvailable()) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  return runPs(PS_UNPROTECT, b64);
}
