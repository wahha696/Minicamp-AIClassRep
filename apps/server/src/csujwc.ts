// 中南大学强智教务系统(csujwc.its.csu.edu.cn)直连导入:
// 模拟登录(动态密钥置换 + 人工验证码)→ 拉课表页 → 解析成 CourseDTO。
//
// 边界约定:
// - 学号/密码只在本进程内存里存活到「本次导入完成」,不落库、不写盘、不进日志;
// - 验证码由用户人工识别(前端内联展示图片),不做任何绕过;
// - 返回的课次交给前端预览,确认后走既有 PUT /api/timetable 落库,本模块不碰 DB;
// - 教务网只在校园网可达;连不上时错误文案指向「确认接入校园网」。
import { createCipheriv, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import iconv from 'iconv-lite';
import { accountDataState, accountEpoch } from './accounts.js';
import { dbGeneration, onAccountSwitch } from './db/index.js';
import type { CourseDTO } from './types.js';
import type { ParsedTimetable } from '../../../shared/timetable-import.js';
import { normalizeCourses, type SourceRef } from '../../../shared/timetable.js';
import { parseTimetableHtml } from './timetable-html.js';

const BASE = 'http://csujwc.its.csu.edu.cn';
const TIMEOUT_MS = 15_000;
const SESSION_TTL = 10 * 60_000; // 验证码与会话绑定,超时重来
const MAX_PENDING = 8;

/** 带用户文案的失败:routes 层直接把 message 返回给前端 */
export class CsuError extends Error {}

// ===== 最小 HTTP 会话:手动跟随跳转 + cookie 收发 + GBK 解码 =====

interface RawResponse {
  status: number;
  contentType: string;
  body: Buffer;
  /** 跳转链走完后的最终地址(教务网登录后可能落到分节点 IP,课表要从那里拉) */
  finalUrl: string;
}

class Session {
  /** 按域存 cookie:CAS(ca.csu.edu.cn)与教务网都会发 JSESSIONID,混在一起会互相覆盖 */
  private readonly cookies: { domain: string; name: string; value: string }[] = [];

  private cookieHeader(url: string): string {
    const host = new URL(url).hostname.toLowerCase();
    const hit = this.cookies.filter(
      (c) => host === c.domain || host.endsWith(`.${c.domain}`),
    );
    return hit.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  private remember(url: string, setCookies: string[]): void {
    const host = new URL(url).hostname.toLowerCase();
    for (const sc of setCookies) {
      const pair = sc.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const domainAttr = /domain=([^;]+)/i.exec(sc)?.[1]?.replace(/^\./, '').toLowerCase();
      const domain = domainAttr ?? host;
      const idx = this.cookies.findIndex((c) => c.domain === domain && c.name === name);
      if (idx >= 0) this.cookies[idx] = { domain, name, value: value };
      else this.cookies.push({ domain, name, value: value });
    }
  }

  private async req(url: string, init: RequestInit, hops: number, referer?: string): Promise<RawResponse> {
    if (hops > 8) throw new CsuError('统一身份认证重定向次数过多,请稍后再试');
    const headers: Record<string, string> = {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
    };
    const cookie = this.cookieHeader(url);
    if (cookie) headers['cookie'] = cookie;
    if (init.body || init.method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['origin'] = new URL(url).origin; // 浏览器对表单 POST 必带 Origin
    }
    if (referer) headers['referer'] = referer; // 跳转/提交的来源页,缺失可能触发教务网 NPE
    if (init.headers) Object.assign(headers, init.headers);

    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new CsuError('连不上教务系统/统一身份认证(ca.csu.edu.cn),请确认电脑已接入校园网');
    }
    this.remember(url, res.headers.getSetCookie());
    // 逐跳诊断日志(host+路径,不带 query,避免把一次性 ticket 写进日志)
    const hopUrl = new URL(url);
    console.log(`[csujwc] → ${init.method ?? 'GET'} ${hopUrl.host}${hopUrl.pathname} [${res.status}]`);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) {
        // 浏览器语义:301/302/303 对 POST 一律降级为 GET(不带 body);
        // 307/308 保持原方法与 body。之前把 POST 原样重发到跳转目标,
        // 导致登录成功后又用已消费的验证码再登录一次,必然被弹回登录页。
        const next: RequestInit = res.status === 307 || res.status === 308 ? { ...init } : {};
        // 浏览器导航语义:跳转后的 Referer = 跳转前页面
        return this.req(new URL(loc, url).toString(), next, hops + 1, url);
      }
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: Buffer.from(await res.arrayBuffer()),
      finalUrl: url,
    };
  }

  get(url: string, referer?: string): Promise<RawResponse> {
    return this.req(url, {}, 0, referer);
  }

  post(url: string, form: Record<string, string>, referer?: string): Promise<RawResponse> {
    return this.req(url, { method: 'POST', body: new URLSearchParams(form).toString() }, 0, referer);
  }

  /** 按响应头/页面 meta 推断编码并解码(强智页面基本是 GBK) */
  static decode(res: RawResponse): string {
    let charset = /charset=([\w-]+)/i.exec(res.contentType)?.[1] ?? '';
    if (!charset) {
      const head = res.body.subarray(0, 2048).toString('latin1');
      charset = /charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? '';
    }
    charset = charset.toLowerCase();
    return charset.includes('utf') ? res.body.toString('utf8') : iconv.decode(res.body, 'gbk');
  }
}

/**
 * 与教务登录页 submitForm1() 完全一致的 encoded 计算:
 * POST ?flag=sess 得到 "scode#sxh",把「学号%%%密码」的每个字符后面
 * 按 sxh 第 i 位数字从 scode 头部取出同长度的片段插入。密钥每次登录都变。
 */
export function encodeLogin(account: string, password: string, scode: string, sxh: string): string {
  const code = `${account}%%%${password}`;
  let s = scode;
  let out = '';
  for (let i = 0; i < code.length; i++) {
    if (i < 50) {
      const take = Number.parseInt(sxh.substring(i, i + 1), 10) || 0;
      out += code.substring(i, i + 1) + s.substring(0, take);
      s = s.substring(take);
    } else {
      out += code.substring(i); // 与原 JS 一致:50 位以后原样拼接
      break;
    }
  }
  return out;
}

// ===== 统一身份认证(CAS)登录 =====
// 中南学生账号走「切换到统一身份认证登录入口」:/sso.jsp → 302 → ca.csu.edu.cn/authserver。
// 本地表单(/jsxsd/xk/LoginToXk)对学号账号一律报错——学生密码在统一身份认证侧。
// CAS 流程:登录页取 execution + pwdEncryptSalt → checkNeedCaptcha 判断要不要验证码
//   → 密码 AES-CBC 加密(随机64字符前缀+密码, 盐=页面下发) → POST → 带 ticket 回教务网。

interface PendingLogin {
  session: Session;
  account: string;
  password: string;
  execution: string;
  salt: string;
  captchaRequired: boolean;
  /** CAS 登录页地址(含 service 参数),登录 POST 的 Referer 用 */
  loginPageUrl: string;
  createdAt: number;
  /** 两步导入只属于创建它的账号与数据库代次。 */
  accountEpoch: string;
  dbGeneration: number;
  expiryTimer: NodeJS.Timeout | null;
}

/** 验证码与会话绑定:第一步到第二步之间放在内存里,不落盘 */
const pending = new Map<string, PendingLogin>();

function discardPending(id: string, expected?: PendingLogin): void {
  const entry = pending.get(id);
  if (entry === undefined || (expected !== undefined && entry !== expected)) return;
  pending.delete(id);
  if (entry.expiryTimer !== null) clearTimeout(entry.expiryTimer);
  entry.expiryTimer = null;
  entry.password = ''; // 移除 map 强引用前尽早抹掉明文密码
}

function clearPending(): void {
  for (const [id, entry] of pending) discardPending(id, entry);
}

function pendingBelongsToCurrentAccount(entry: PendingLogin): boolean {
  return accountDataState() === 'ready' &&
    entry.accountEpoch === accountEpoch() &&
    entry.dbGeneration === dbGeneration();
}

// 换号/登出一旦成功挂载新库，旧验证码、cookie、学号与密码立即作废。
onAccountSwitch(() => clearPending());

export interface CsuBeginDTO {
  session_id: string;
  /** 验证码图片 data URL,前端直接 <img>;空字符串 = 本次登录不需要验证码 */
  captcha: string;
}

const CAS_BASE = 'https://ca.csu.edu.cn';

/**
 * 诊断页只保留 DOM/表格结构。文本、脚本和非结构属性都可能含姓名、学号、ticket 或课程内容，
 * 所以绝不把教务网原页直接写盘。
 */
export function sanitizeDiagnosticHtml(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  $('*').each((_index, element) => {
    if (!('attribs' in element)) return;
    for (const name of Object.keys(element.attribs)) {
      if (name !== 'rowspan' && name !== 'colspan') $(element).removeAttr(name);
    }
  });
  $.root().find('*').contents().each((_index, node) => {
    if (node.type === 'comment') {
      $(node).remove();
    } else if (node.type === 'text') {
      const length = node.data.trim().length;
      if (length > 0) $(node).replaceWith(`[TEXT length=${length}]`);
    }
  });
  return $.html();
}

/** 诊断用:把脱敏后的页面结构存到 data/logs/<name>,返回不含标题正文的描述 */
function dumpPage(name: string, html: string): string {
  const titleLength = (/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim().length;
  try {
    const dir = join(process.cwd(), 'data', 'logs');
    mkdirSync(dir, { recursive: true });
    const sanitized = sanitizeDiagnosticHtml(html);
    writeFileSync(join(dir, name), Buffer.from(sanitized, 'utf8'));
    console.warn(`[csujwc] 脱敏页面结构已保存到 data/logs/${name}(原始长度 ${html.length})`);
  } catch {
    console.warn('[csujwc] 诊断页面保存失败(不阻断主流程)');
  }
  return titleLength === 0 ? '无标题' : `标题长度 ${titleLength}`;
}

/** 与 ca.csu.edu.cn 的 encrypt.js 语义一致:AES-CBC(盐=密钥, 随机16字符=iv, PKCS7) → base64,
 *  明文前拼 64 位随机字符(服务端解密后按前缀长度丢弃,盐每次会话都变) */
const CAS_RANDOM_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

function casRandomString(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += CAS_RANDOM_CHARS[randomInt(CAS_RANDOM_CHARS.length)];
  return out;
}

function casEncryptPassword(password: string, salt: string): string {
  if (!salt) return password; // 与 encrypt.js 的 encryptAES 行为一致
  const key = Buffer.from(salt.trim(), 'utf8');
  const iv = Buffer.from(casRandomString(16), 'utf8');
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([cipher.update(Buffer.from(casRandomString(64) + password, 'utf8')), cipher.final()]).toString(
    'base64',
  );
}

/** 从 HTML 里抓 <input id="x"> 的 value(单双引号、属性顺序都兼容) */
function inputById(html: string, id: string): string {
  const tag = new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`, 'i').exec(html)?.[0];
  if (!tag) return '';
  return /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
}

/** 第一步:打开 SSO 链路拿到 CAS 登录上下文;需要验证码时返回图片 data URL */
export async function csuBeginImport(account: string, password: string): Promise<CsuBeginDTO> {
  if (accountDataState() !== 'ready') throw new CsuError('账号数据正在切换或不可用,请稍后重试');
  const ownerEpoch = accountEpoch();
  const ownerGeneration = dbGeneration();
  const session = new Session();
  const casRes = await session.get(`${BASE}/sso.jsp`); // 302 → ca.csu.edu.cn/authserver/login
  const html = Session.decode(casRes);
  if (!/authserver\/login/.test(html)) {
    console.warn(`[csujwc] CAS 登录页异常:HTTP ${casRes.status},长度 ${casRes.body.length}`);
    throw new CsuError('统一身份认证页面打开失败(请确认已接入校园网,或系统维护中)');
  }
  const execution = inputById(html, 'execution');
  const salt = inputById(html, 'pwdEncryptSalt');
  if (!execution || !salt) {
    console.warn('[csujwc] CAS 页面缺 execution/pwdEncryptSalt,页面可能改版了');
    throw new CsuError('统一身份认证页面参数缺失(可能改版),请把这一步的提示反馈给开发者');
  }

  // 是否需要图片验证码(连续失败后 CAS 会要求)
  let captchaRequired = false;
  try {
    const needRes = await session.get(
      `${CAS_BASE}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(account)}`,
    );
    if (needRes.status !== 200) throw new Error('captcha status');
    const need: unknown = JSON.parse(Session.decode(needRes));
    if (!need || typeof need !== 'object' || !('isNeed' in need) || typeof need.isNeed !== 'boolean') {
      throw new Error('captcha response');
    }
    captchaRequired = need.isNeed;
  } catch {
    throw new CsuError('无法确认统一身份认证的验证码要求,请重新点击「下一步」;本次未提交登录');
  }

  let captcha = '';
  if (captchaRequired) {
    const img = await session.get(`${CAS_BASE}/authserver/getCaptcha.htl?${Date.now()}`);
    if (!img.contentType.includes('image')) {
      console.warn(`[csujwc] CAS 验证码响应不是图片(Content-Type: ${img.contentType})`);
      throw new CsuError('统一身份认证验证码获取异常,请稍后再试');
    }
    captcha = `data:${img.contentType.split(';')[0]};base64,${img.body.toString('base64')}`;
  }

  // 第一步访问教务网期间可能已换号；不能把 A 的凭据挂到 B 的上下文。
  if (accountDataState() !== 'ready' || accountEpoch() !== ownerEpoch || dbGeneration() !== ownerGeneration) {
    throw new CsuError('账号已切换,本次教务登录已作废,请重新开始导入');
  }

  const id = randomUUID();
  const entry: PendingLogin = {
    session,
    account,
    password,
    execution,
    salt,
    captchaRequired,
    loginPageUrl: casRes.finalUrl,
    createdAt: Date.now(),
    accountEpoch: ownerEpoch,
    dbGeneration: ownerGeneration,
    expiryTimer: null,
  };
  pending.set(id, entry);
  entry.expiryTimer = setTimeout(() => discardPending(id, entry), SESSION_TTL);
  entry.expiryTimer.unref();
  // 顺手清掉过期/过多的挂起会话(验证码本来就该是短命的)
  const now = Date.now();
  for (const [pid, p] of pending) {
    if (now - p.createdAt > SESSION_TTL) discardPending(pid, p);
  }
  while (pending.size > MAX_PENDING) {
    const oldest = [...pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (!oldest) break;
    discardPending(oldest[0], oldest[1]);
  }
  return { session_id: id, captcha };
}

/**
 * 第二步:验证码(如需)+ 完成 CAS 登录 + 拉课表解析。
 * 返回的课次不落库——前端进「预览 → 填第一周周一 → 保存」流程(与 xls 导入一致)。
 */
export async function csuFetchCourses(
  sessionId: string,
  captcha: string,
): Promise<ParsedTimetable> {
  const st = pending.get(sessionId);
  if (!st) throw new CsuError('登录会话不存在或已超时,请重新获取验证码');
  pending.delete(sessionId); // 一次性:验证码是一次性的,成败都不复用
  if (st.expiryTimer !== null) clearTimeout(st.expiryTimer);
  st.expiryTimer = null;
  try {
    if (!pendingBelongsToCurrentAccount(st)) {
      throw new CsuError('账号已切换,旧教务登录会话已作废,请重新开始导入');
    }
    if (Date.now() - st.createdAt > SESSION_TTL) {
      throw new CsuError('登录会话已超时,请重新点击「下一步」');
    }
    if (st.captchaRequired && !captcha) {
      throw new CsuError('本次登录需要验证码,请先获取验证码并输入图片里的字符');
    }
    const fields: Record<string, string> = {
      username: st.account,
      password: casEncryptPassword(st.password, st.salt), // 只传密文,明文不出本函数
      _eventId: 'submit',
      cllt: 'userNameLogin',
      dllt: 'generalLogin',
      lt: '',
      execution: st.execution,
      captcha: st.captchaRequired ? captcha : '',
    };

    // 成功:302 带 ticket 回 /sso.jsp → 教务网建立会话;失败:CAS 返回 200 登录页
    const casBack = await st.session.post(st.loginPageUrl, fields, st.loginPageUrl);
    const backHtml = Session.decode(casBack);
    const serverError = (status: number, html: string): boolean =>
      status >= 500 || (!/<html/i.test(html.slice(0, 400)) && /"status":\s*5\d\d/.test(html));
    if (new URL(casBack.finalUrl).origin === CAS_BASE && serverError(casBack.status, backHtml)) {
      console.warn(`[csujwc] CAS 响应异常:HTTP ${casBack.status},未自动重试`);
      throw new CsuError(
        `统一身份认证接口返回服务器错误(HTTP ${casBack.status}),尚未完成教务回跳。无法据此判断是否限流,请将 [csujwc] 日志反馈给开发者`,
      );
    }
    if (/id="pwdEncryptSalt"|name="passwordText"/.test(backHtml)) {
      const casErr = (/class="[^"]*error[^"]*"[^>]*>([^<]{2,80})</i.exec(backHtml)?.[1] ?? '').trim();
      console.warn(`[csujwc] CAS 登录未通过:HTTP ${casBack.status}(不记录任何凭据)`);
      throw new CsuError(
        `统一身份认证登录失败:请核对学号与密码${st.captchaRequired ? ',验证码(点「换一张」重试)' : ''}${casErr ? `。系统提示:${casErr}` : ''}`,
      );
    }

    // CAS 成功后 302 带 ticket 回 /sso.jsp。教务网校验 ticket 后渲染 frmloginZndx
    // 自动提交页,页面 JS 提交 /Logon.do 完成登录(身份在服务端会话里)。
    // 桥接偶发 500 时轻量自愈:重走 /sso.jsp(CAS 已有会话,直接换新 ticket)。
    let landUrl = casBack.finalUrl;
    let landHtml = backHtml;
    let landStatus = casBack.status;
    const landingFailed = (): boolean => serverError(landStatus, landHtml);
    if (landingFailed()) {
      // 回跳页直接 500:换新 ticket 再试一次(CAS 会话还在,直接静默重定向)
      console.warn('[csujwc] ticket 回跳 500,重走 /sso.jsp 换新 ticket(1/1)');
      const again = await st.session.get(`${BASE}/sso.jsp`);
      landUrl = again.finalUrl;
      landHtml = Session.decode(again);
      landStatus = again.status;
    }
    if (!landingFailed() && /id=["']frmloginZndx["']/.test(landHtml)) {
      // 自动提交页:页面 JS(submitZNDX)提交 frmloginZndx 到 /Logon.do。
      // 页面注入值优先(实测可行),取不到再照抄静态页 JS 的 'null' 占位。
      const action =
        /id=["']frmloginZndx["'][\s\S]{0,600}?action=["']([^"']+)["']/i.exec(landHtml)?.[1] ??
        '/Logon.do?method=logon';
      const acct = inputById(landHtml, 'userAccount1');
      const pwd = inputById(landHtml, 'userPassword1');
      const useInjected = !!(
        acct &&
        pwd &&
        acct.toLowerCase() !== 'null' &&
        pwd.toLowerCase() !== 'null'
      );
      const logonBack = await st.session.post(
        new URL(action, landUrl).toString(),
        {
          userAccount1: useInjected ? acct : 'null',
          userPassword1: useInjected ? pwd : 'null',
          ticket: 'jsxsdLogin',
        },
        landUrl,
      );
      landUrl = logonBack.finalUrl;
      landHtml = Session.decode(logonBack);
      landStatus = logonBack.status;
      console.log(
        `[csujwc] SSO 补登录 HTTP ${logonBack.status},落点 ${new URL(landUrl).host},页面 ${landHtml.length}B,注入值:${useInjected ? '用页面值' : '用占位'}`,
      );
    } else if (!landingFailed()) {
      // 没有自动提交页:可能直接落在主框架(部分部署免补登录)
      console.log(
        `[csujwc] ticket 回跳无自动提交页,直接在落点找课表:落点 ${new URL(landUrl).host},长度 ${landHtml.length}`,
      );
    }
    if (landingFailed()) {
      throw new CsuError(
        `登录回跳或教务补登录发生服务器错误(HTTP ${landStatus})。请把黑窗口里 [csujwc] 开头的日志发给开发者`,
      );
    }

    // 找课表页:强智的课表链接带菜单生成的 gnmkdm/会话 token,裸路径会 404。
    // 像浏览器一样走:落点页 → (iframe/frame 菜单页) → 收集课表链接 → 逐个试到出 #kbtable。
    const tried = new Set<string>();
    const candidates: string[] = [];
    const collectKbLinks = (pageHtml: string, pageUrl: string): void => {
      for (const m of pageHtml.matchAll(
        /(?:href|src)=["']([^"']*(?:xskb|xskbcx|kbcx)[^"']*)["']/gi,
      )) {
        const u = m[1];
        if (!u || /^javascript/i.test(u)) continue;
        candidates.push(new URL(u, pageUrl).toString());
      }
    };
    const queue = [landUrl];
    const seen = new Set<string>([landUrl]);
    for (let i = 0; i < queue.length && candidates.length < 12; i++) {
      const pageUrl = queue[i]!;
      const pageHtml = pageUrl === landUrl ? landHtml : Session.decode(await st.session.get(pageUrl));
      collectKbLinks(pageHtml, pageUrl);
      // 框架页(frame/iframe)里的才是菜单,课表链接通常在菜单页里
      for (const f of pageHtml.matchAll(/<(?:i?frame)[^>]*src=["']([^"']+)["']/gi)) {
        const u = new URL(f[1]!, pageUrl).toString();
        if (!seen.has(u)) {
          seen.add(u);
          queue.push(u);
        }
      }
    }
    // 兜底:裸路径(部分部署支持)
    candidates.push(`${new URL(landUrl).origin}/jsxsd/xskb/xskb_list.do`, `${BASE}/jsxsd/xskb/xskb_list.do`);

    let parsedResult: ParsedTimetable | null = null;
    let foundTable = false;
    let lastKbHtml = ''; // 最后一个 #kbtable 页面原文,解析失败时留诊断快照
    for (const url of [...new Set(candidates)]) {
      if (tried.has(url)) continue;
      tried.add(url);
      try {
        const res = await st.session.get(url);
        const h = Session.decode(res);
        if (!isLoginPage(h) && /id=["']kbtable["']/.test(h)) {
          foundTable = true;
          lastKbHtml = h;
          const structured = parseTimetableHtml(h);
          if (structured && (structured.courses.length || structured.items?.length)) {
            if (!structured.courses.length) {
              // 找到课表页但 0 门课：留存页面供离线诊断(与 dumpPage 同目录,含课表内容)
              dumpPage('csu-kb-parsed-empty.html', h);
              console.warn(
                `[csujwc] 课表页解析出 ${structured.items?.length ?? 0} 个片段、0 门课,页面已存 data/logs/csu-kb-parsed-empty.html`,
              );
            }
            if (structured.courses.length) {
              parsedResult = structured;
              break;
            }
            // 保留待确认内容，但不要让第一个零课程页面阻止其他候选。
            parsedResult ??= structured;
            continue;
          }
          const parsed = parseKbtable(h);
          const courses = toCourseDTOs(parsed.raw, parsed.warnings);
          console.log(`[csujwc] 课表解析:有效排课 ${courses.length} 项,提示 ${parsed.warnings.length} 条`);
          if (courses.length) {
            parsedResult = { courses, warnings: parsed.warnings,
              items: [{id:'legacy-web',sheet:'网页',row:1,column:1,raw:h.replace(/<[^>]*>/g,' '),status:'pending',course_ids:courses.map(c=>c.id!),message:'兼容解析无法逐格对账；请核对整张原表后确认'}] };
            break;
          }
        }
      } catch {
        // 单个候选失败不影响其余
      }
    }
    if (!parsedResult && foundTable) {
      dumpPage('csu-kb-unparsed.html', lastKbHtml);
      throw new CsuError('已进入教务课表页面,但未识别到有效课程。可能是页面布局不兼容或当前学期没有排课;页面已存 data/logs/csu-kb-unparsed.html;本次未导入,不会覆盖已有课表');
    }
    if (!parsedResult) {
      const title = dumpPage('csu-kb-dump.html', landHtml);
      console.warn(`[csujwc] 没找到课表链接:落点 ${new URL(landUrl).host},标题"${title}",候选 ${tried.size} 个`);
      throw new CsuError(
        `没在教务系统页面里找到课表入口(页面标题:「${title || '未知'}」)。页面已保存到 data/logs/csu-kb-dump.html,请把此提示反馈给开发者`,
      );
    }
    if (!pendingBelongsToCurrentAccount(st)) {
      throw new CsuError('账号已切换,本次教务导入结果已丢弃,请重新开始');
    }
    return parsedResult;
  } catch (e) {
    if (e instanceof CsuError) throw e;
    throw new CsuError('教务系统导入失败,请稍后重试;若持续失败请改用「文件导入」');
  } finally {
    st.password = ''; // 用完即弃,不留在内存里等人翻
  }
}

// ===== 课表 HTML 解析(强智 #kbtable) =====

export interface RawCourse {
  id?: string; source?: SourceRef; class_name?: string;
  name: string;
  teacher: string;
  location: string;
  dayOfWeek: number; // 1=周一 … 7=周日
  startSection: number;
  endSection: number;
  weeks: number[];
}

/** "第1,2节" / "第1-2节" / "第3节" → [起,止];不匹配返回 null */
export function parseSectionLabel(text: string): [number, number] | null {
  const t = text.replace(/\s+/g, '');
  const pair = t.match(/^(?:上午|下午|晚上)?第?(\d{1,2})[,，、－\-–—~至](\d{1,2})节?$/);
  if (pair) return [Number(pair[1]), Number(pair[2])];
  const single = t.match(/^(?:上午|下午|晚上)?第(\d{1,2})节$/);
  if (single) return [Number(single[1]), Number(single[1])];
  return null;
}

/** "1-16周" / "1-16周(单周)" / "1,3,5-7周(双)" → 周次数组;非周次行返回 null */
export function parseWeeksLine(text: string): number[] | null {
  if (!/\d/.test(text) || !/周/.test(text)) return null;
  const weeks: number[] = [];
  for (const seg of text.replace(/周/g, '').split(/[,，、]/)) {
    const m = seg.trim().match(/^(?:第)?(\d+)(?:\s*[-–—~至]\s*(\d+))?/);
    if (!m) continue;
    const parity = /单/.test(seg) ? 1 : /双/.test(seg) ? 0 : /单/.test(text) ? 1 : /双/.test(text) ? 0 : null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let w = a; w <= b; w++) {
      if (parity === null || w % 2 === parity) weeks.push(w);
    }
  }
  return weeks.length ? weeks : null;
}

/** 单元格 innerHTML → 文本行(<br> 分行、去标签、解实体) */
function cellLines(innerHtml: string): string[] {
  return innerHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function looksLikeLocation(text: string): boolean {
  return /楼|馆|室|厅|场|房|栋|区|号楼|基地|中心|实验|机房|\d{3,}/.test(text);
}

/** 拿到的是登录页(未登录/会话失效) */
export function isLoginPage(html: string): boolean {
  return /id="userAccount"|verifycode\.servlet/.test(html);
}

/** 处理一个课程格子:提取课程名/教师/地点/周次(第 0 列是节次标签,不在这里) */
function processCell(
  $: CheerioAPI,
  el: Element,
  row: number,
  col: number,
  sectionByRow: Map<number, [number, number]>,
  out: RawCourse[],
): void {
  const lines = ($(el).html() ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return;

  const sec = sectionByRow.get(row);
  if (!sec) return; // 表头行等没有节次上下文

  let weeks: number[] | null = null;
  let sections: [number, number] | null = null;
  const rest: string[] = [];
  for (const line of lines) {
    const wk = parseWeeksLine(line);
    if (wk && !weeks) {
      weeks = wk;
      continue;
    }
    if (!sections && line.replace(/\s+/g, '').length <= 12) {
      const s2 = parseSectionLabel(line);
      if (s2) {
        sections = s2;
        continue;
      }
    }
    rest.push(line);
  }
  if (!weeks) return; // 没有周次信息的格子不是排课

  const name = rest.shift() ?? '未命名课程';
  let teacher = '';
  let location = '';
  if (rest.length >= 2) {
    // 常见顺序:课程名 / … / 地点(地点通常最后一行)
    location = rest[rest.length - 1]!;
    teacher = rest.slice(0, -1).join(' ');
    if (!looksLikeLocation(location) && looksLikeLocation(teacher)) {
      [teacher, location] = [location, teacher];
    }
  } else if (rest.length === 1) {
    location = rest[0]!;
  }

  out.push({
    name,
    teacher,
    location,
    dayOfWeek: col,
    startSection: sections ? sections[0] : sec[0],
    endSection: sections ? sections[1] : sec[1],
    weeks,
  });
}

/**
 * 强智课表页(/jsxsd/xskb/xskb_list.do)HTML → 未归块的课次。
 * #kbtable:第 0 列是节次标签("第1,2节"),第 1~7 列 = 周一~周日;
 * 占位表处理 rowspan/colspan(如「上午」大格、跨节课)。
 */
export function parseKbtable(html: string): { raw: RawCourse[]; warnings: string[] } {
  if (isLoginPage(html)) {
    throw new CsuError('教务系统把页面重定向回了登录:请重新导入(会话超时)');
  }
  const structured = parseTimetableHtml(html);
  if (structured) {
    return {
      raw: structured.courses.map(c => ({
        name: c.name, teacher: c.teacher, location: c.location, dayOfWeek: c.weekday,
        startSection: c.start_period ?? c.block * 2 - 1, endSection: c.end_period ?? c.block * 2, weeks: c.weeks,
        id:c.id, source:c.source, class_name:c.class_name,
      })),
      warnings: structured.warnings,
    };
  }
  const $ = cheerio.load(html);
  const kb = $('#kbtable');
  const table = kb.length ? kb : $('table').filter((_, t) => /节次|星期/.test($(t).text())).first();
  if (!table.length) {
    throw new CsuError('没在课表页面里找到课程表格(#kbtable),教务系统页面可能改版了');
  }

  const raw: RawCourse[] = [];
  const warnings: string[] = [];
  // 强智当前页面常把周日放在第一列；不能把数据列序号直接当星期。
  const weekdayByCol = new Map<number, number>();
  for (const tr of table.find('tr').toArray() as Element[]) {
    const cells = $(tr).children('td,th').toArray() as Element[];
    const found = cells.map((cell, i) => {
      const m = /^星期([一二三四五六日天])$/.exec($(cell).text().replace(/\s+/g, ''));
      const day = m ? { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }[m[1]!] : undefined;
      return day === undefined ? null : [i, day] as const;
    }).filter((v): v is readonly [number, number] => v !== null);
    if (found.length >= 3) {
      for (const [col, day] of found) weekdayByCol.set(col, day);
      break;
    }
  }
  const sectionByRow = new Map<number, [number, number]>();
  // rowspan 占位:行 → 列 → {el, colspan}
  const pendingCells = new Map<number, Map<number, { el: Element; colspan: number }>>();

  (table.find('tr').toArray() as Element[]).forEach((tr, r) => {
    let c = 0;
    const flush = () => {
      const row = pendingCells.get(r);
      while (row?.has(c)) {
        const cell = row.get(c)!;
        row.delete(c);
        if (c === 0) {
          const label = parseSectionLabel($(cell.el).text());
          if (label) sectionByRow.set(r, label);
        } else {
          processCell($, cell.el, r, c, sectionByRow, raw);
        }
        c += cell.colspan;
      }
    };
    for (const node of $(tr).children('td,th').toArray() as Element[]) {
      flush();
      const colspan = Math.max(1, Number.parseInt($(node).attr('colspan') ?? '1', 10) || 1);
      const rowspan = Math.max(1, Number.parseInt($(node).attr('rowspan') ?? '1', 10) || 1);
      if (c === 0) {
        // 第 0 列:节次标签(如 "第1,2节");rowspan 时对后续行同样生效
        const label = parseSectionLabel($(node).text());
        if (label) {
          for (let dr = 0; dr < rowspan; dr++) sectionByRow.set(r + dr, label);
        }
      } else {
        processCell($, node, r, c, sectionByRow, raw);
      }
      if (rowspan > 1) {
        for (let dr = 1; dr < rowspan; dr++) {
          const rr = r + dr;
          if (!pendingCells.has(rr)) pendingCells.set(rr, new Map());
          pendingCells.get(rr)!.set(c, { el: node, colspan });
        }
      }
      c += colspan;
    }
    flush(); // 行尾剩余占位(理论上没有)
  });
  if (weekdayByCol.size) {
    for (const course of raw) course.dayOfWeek = weekdayByCol.get(course.dayOfWeek) ?? course.dayOfWeek;
  }
  return { raw, warnings };
}

/** Legacy HTML fallback: preserve each rule and its full range, never merge by name. */
export function toCourseDTOs(raw: RawCourse[], warnings: string[] = []): CourseDTO[] {
  return normalizeCourses(raw.flatMap(c => {
    if (c.startSection < 1 || c.endSection < c.startSection || c.endSection > 24 || c.dayOfWeek<1 || c.dayOfWeek>7 || !c.weeks.length || c.weeks.some(w=>w<1 || w>60)) {
      warnings.push(`「${c.name}」节次或周次无效，需手动确认：${JSON.stringify(c)}`);
      return [];
    }
    return [{id:c.id, source:c.source, class_name:c.class_name, name:c.name, teacher:c.teacher, location:c.location,
      weekday:c.dayOfWeek as CourseDTO['weekday'], block:Math.ceil(c.startSection/2),
      start_period:c.startSection, end_period:c.endSection, weeks:c.weeks}];
  }));
}
