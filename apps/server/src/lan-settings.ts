// 局域网（手机）只读访问开关（修复计划 S1）。
// 链接同时绑定签发时的账号与账号数据代次：换号/切库后旧链接立即失效，不能自动跟到新账号。
// 默认关闭：服务只监听 127.0.0.1。打开后改监听 0.0.0.0，手机需用带 token 的链接访问。
// 切换监听地址需要重启后端（index.ts 启动时读一次），接口会告诉前端 restart_required。
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountDataState, accountEpoch, currentAccount } from './accounts.js';
import { DATA_DIR } from './paths.js';

interface Saved {
  enabled: boolean;
  token: string;
  /** null 表示签发给未登录兜底库；undefined 只可能来自升级前的旧配置，按未绑定拒绝。 */
  account_uin?: string | null;
  account_epoch?: string;
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
        account_uin:
          raw.account_uin === null || (typeof raw.account_uin === 'string' && /^\d{5,12}$/.test(raw.account_uin))
            ? raw.account_uin
            : undefined,
        account_epoch:
          typeof raw.account_epoch === 'string' && raw.account_epoch.length > 0 ? raw.account_epoch : undefined,
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

function bindingIsCurrent(s: Saved): boolean {
  return (
    accountDataState() === 'ready' &&
    s.account_uin !== undefined &&
    s.account_uin === currentAccount() &&
    s.account_epoch === accountEpoch()
  );
}

export interface LanBinding {
  token: string;
  accountEpoch: string;
}

/** 当前可签发到手机链接的凭据；epoch 也必须出现在 URL 中，不能只靠可长期保存的 token。 */
export function currentLanBinding(): LanBinding | null {
  const s = read();
  if (!s.enabled || s.token === '' || !bindingIsCurrent(s) || s.account_epoch === undefined) return null;
  return { token: s.token, accountEpoch: s.account_epoch };
}

/** 中间件用：仅当开关、账号和数据代次都仍与签发时一致时返回 token。 */
export function currentLanToken(): string | null {
  return currentLanBinding()?.token ?? null;
}

/** 设置页用：配置开关本身是否开启（即使刚换号、旧链接已因绑定失效）。 */
export function lanConfiguredEnabled(): boolean {
  const s = read();
  return s.enabled && s.token !== '';
}

export function setLanEnabled(enabled: boolean): Saved {
  const s = read();
  const sameBinding = bindingIsCurrent(s);
  const next: Saved = enabled
    ? {
        enabled: true,
        // 换号后重新开启时必须同时换 token，避免旧链接持有人借新绑定进入另一个账号。
        token: s.token !== '' && sameBinding ? s.token : newToken(),
        account_uin: currentAccount(),
        account_epoch: accountEpoch(),
      }
    : { ...s, enabled: false };
  write(next);
  return next;
}

/** 换 token：旧链接立刻失效 */
export function rotateLanToken(): Saved {
  const next: Saved = {
    enabled: read().enabled,
    token: newToken(),
    account_uin: currentAccount(),
    account_epoch: accountEpoch(),
  };
  write(next);
  return next;
}
