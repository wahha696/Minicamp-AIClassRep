// 局域网（手机）只读访问开关（修复计划 S1）。存在 data/lan.json：{ enabled, token }。
// 默认关闭：服务只监听 127.0.0.1。打开后改监听 0.0.0.0，手机需用带 token 的链接访问。
// 切换监听地址需要重启后端（index.ts 启动时读一次），接口会告诉前端 restart_required。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

interface Saved {
  enabled: boolean;
  token: string;
}

let dir = DATA_DIR;
let cache: Saved | undefined;

/** 测试用 */
export function setLanSettingsDir(d: string): void {
  dir = d;
  cache = undefined;
}

function file(): string {
  return join(dir, 'lan.json');
}

function newToken(): string {
  return randomBytes(18).toString('base64url');
}

function read(): Saved {
  if (cache) return cache;
  cache = { enabled: false, token: '' };
  try {
    if (existsSync(file())) {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Saved>;
      cache = {
        enabled: raw.enabled === true,
        token: typeof raw.token === 'string' && raw.token.length >= 16 ? raw.token : '',
      };
    }
  } catch {
    // 坏文件按关闭处理
  }
  return cache;
}

function write(s: Saved): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(), `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  cache = s;
}

/** 启动时读：是否监听局域网 */
export function lanEnabledAtBoot(): boolean {
  return read().enabled && read().token !== '';
}

/** 中间件用：开关打开时返回 token，否则 null */
export function currentLanToken(): string | null {
  const s = read();
  return s.enabled && s.token !== '' ? s.token : null;
}

export function setLanEnabled(enabled: boolean): Saved {
  const s = read();
  const next: Saved = { enabled, token: s.token || newToken() };
  write(next);
  return next;
}

/** 换 token：旧链接立刻失效 */
export function rotateLanToken(): Saved {
  const next: Saved = { enabled: read().enabled, token: newToken() };
  write(next);
  return next;
}
