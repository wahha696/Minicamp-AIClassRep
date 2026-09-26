// NapCat 相关路径与 QQ.exe 定位。主人是 A（分工 A2）。
// 逻辑与 A1 已实测跑通的 scripts/probe-napcat.mjs 一致（需求文档.md §8 §10-1/§10-5）。
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { NAPCAT_DIR, ROOT } from '../paths.js';

export { NAPCAT_DIR, ROOT };

/** NapCat 的 OneBot 配置目录 */
export const NAPCAT_CONFIG_DIR: string = join(NAPCAT_DIR, 'config');

/** 二维码落在这里，前端经 GET /api/connect/qrcode 取 */
export const QRCODE_PATH: string = join(NAPCAT_DIR, 'cache', 'qrcode.png');

/**
 * 从 `reg query ... /v UninstallString` 的输出里取值并去掉两端引号。
 * 纯函数，单独导出便于测试。取不到返回 null。
 */
export function parseUninstallString(regOutput: string): string | null {
  const m = regOutput.match(/UninstallString\s+REG_SZ\s+(.*)/);
  if (!m || m[1] === undefined) return null;
  const value = m[1].trim().replace(/^"|"$/g, '');
  return value === '' ? null : value;
}

/**
 * QQ.exe 定位（架构.md §1、NapCat接口规格.md §1）：
 * 注册表 HKLM\SOFTWARE\WOW6432Node\...\Uninstall\QQ 的 UninstallString 所在目录 + QQ.exe
 * → 取不到再试 C:\Program Files\Tencent\QQNT\QQ.exe → 都没有返回 null。
 */
export function findQQExe(): string | null {
  try {
    const out = spawnSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ', '/v', 'UninstallString'],
      { encoding: 'utf8' },
    );
    const value = out.stdout ? parseUninstallString(out.stdout) : null;
    if (value) {
      const p = join(dirname(value), 'QQ.exe');
      if (existsSync(p)) return p;
    }
  } catch {
    // 注册表读不到就走默认路径
  }
  const fallback = 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe';
  return existsSync(fallback) ? fallback : null;
}
