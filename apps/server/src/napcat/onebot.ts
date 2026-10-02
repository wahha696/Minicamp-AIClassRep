// OneBot WS 客户端（架构.md §2/§3 第 5~6 步；NapCat接口规格.md §5/§6/§7）。主人是 A（分工 A4）。
// 默认接入 ws://127.0.0.1:3001（本机注入 NapCat）；Docker 部署时用 ONEBOT_WS_URL 指向外部
// NapCat 容器（如 ws://napcat:3001），此时不启动本机 QQ 注入（manager 的 Windows 专用逻辑不跑）。
// 事件推送与 action 调用走同一条连接（按 echo 匹配回包）。
// 铁律：任何解析/处理异常都 catch，绝不让连接断掉。
import { randomUUID } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import {
  accountDataState,
  currentAccount,
  failAccountSession,
  isValidUin,
  isAccountSwitching,
  switchAccount,
  waitForAccountTransitions,
} from '../accounts.js';
import { dbGeneration, onAccountSwitch } from '../db/index.js';
import { ingestMessages, upsertGroup } from '../ingest/index.js';
import { getUin, killTree, setUin } from './manager.js';
import { finishDesktopRecovery, takeDesktopRecovery } from './desktop-recovery.js';
import type { Message } from '../types.js';

const DEFAULT_WS = 'ws://127.0.0.1:3001';
const EXTERNAL_WS_URL = process.env.ONEBOT_WS_URL ?? '';
/** 外部 OneBot 模式（Docker 部署）：连接目标是环境变量指定的远端，而不是本机注入的 QQ */
export const EXTERNAL_ONEBOT = EXTERNAL_WS_URL !== '' && EXTERNAL_WS_URL !== DEFAULT_WS;

/** writeNapcatConfig 生成的 token 与端口（修复计划 S3/B8）；token 空串 = 不带（测试 / 旧配置） */
let wsToken = '';
let wsPort = 3001;
export function setOnebotEndpoint(token: string, port: number): void {
  wsToken = token;
  wsPort = port;
}
function wsUrl(): string {
  if (EXTERNAL_ONEBOT) return EXTERNAL_WS_URL; // Docker：连外部 NapCat，token 由部署方管
  const base = `ws://127.0.0.1:${wsPort}`;
  return wsToken ? `${base}/?access_token=${encodeURIComponent(wsToken)}` : base;
}

/**
 * B8：从 base 起找一个空闲 TCP 端口写进 NapCat 配置。
 * 3001 写死且被别的 OneBot 实例占用时，我们会连上别人的实例（S3 的 token 会拦住，
 * 但会一直重连不上）；被占就顺延，自己的 NapCat 绑到哪个连哪个。
 */
export async function pickFreePort(base: number, tries = 10): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const port = base + i;
    const free = await new Promise<boolean>((resolve) => {
      const s = netConnect({ port, host: '127.0.0.1' });
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(500);
      s.once('connect', () => finish(false));
      s.once('timeout', () => finish(true));
      s.once('error', () => finish(true));
    });
    if (free) return port;
  }
  return base; // 全被占就还用 base，让 NapCat 启动失败走状态机报错
}
const RETRY_MS = 1_000;          // 首次 online 前：1s 一次尝试
const BACKOFF_START_MS = 2_000;  // 曾 online 后断开：指数退避 2s→4s→…→30s，无限重连
const BACKOFF_MAX_MS = 30_000;
const CALL_TIMEOUT_MS = 15_000;  // callAction 默认超时

type Json = Record<string, unknown>;

// ===== 内部状态 =====

let ws: WebSocket | null = null;
let stopped = false;           // stopOnebotClient 后不再重连
let everOnline = false;        // 本次运行曾收到 lifecycle（= 曾登录成功）
let selfId: string | null = null;
let selfNickname: string | null = null; // get_login_info 拿到的昵称（右上角账号信息用）
/** 每次 lifecycle / 手动重连 +1，让同账号重连前的异步回包也能失效。 */
let lifecycleEpoch = 0;
let onlineLifecycle: { socket: WebSocket | null; uin: string; generation: number; epoch: number } | null = null;
let kicked = false;            // 收到 bot_offline：不再自动重连，等用户点「重新连接」
let reconnectTimer: NodeJS.Timeout | null = null;
let backoffMs = BACKOFF_START_MS;
const pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
/** get_group_list 的内存缓存：群消息的 group_name 优先取这里（分工 A4） */
const groupNameCache = new Map<string, string>();

export interface OnebotFacts {
  wsConnected: boolean;
  everOnline: boolean;
  selfId: string | null;
  kicked: boolean;
  /** 切库失败信息（null = 账号库正常）。挂库失败时停止写消息，防止串库 */
  accountError: string | null;
}

// ===== WS 连接循环 =====

/** startNapcat 时启动。未登录时连不上属正常，循环重试；NapCat 只在登录成功后才开 3001。 */
export function startOnebotClient(): void {
  stopped = false;
  if (reconnectTimer === null) connect();
}

/** 进程退出时调用：停掉重连并关闭连接 */
export function stopOnebotClient(): void {
  lifecycleEpoch++; // Invalidate lifecycle, group-list and forward-message tasks before any reconnect.
  stopped = true;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  rejectAllPending('QQ 连接已关闭');
  if (ws !== null) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}

function connect(): void {
  if (stopped || kicked) return;
  if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    const w = new WebSocket(wsUrl());
    ws = w;
    w.addEventListener('message', (ev: MessageEvent) => {
      if (ws !== w) return; // 已被替换/关闭的旧连接即使还有迟到帧，也不能进入当前账号
      try { handleOnebotMessage(String(ev.data)); } catch { /* 任何异常都不能断连 */ }
    });
    w.addEventListener('close', () => {
      if (ws === w) {
        ws = null;
        rejectAllPending('QQ 连接已断开');
        scheduleReconnect();
      }
    });
    w.addEventListener('error', () => { /* close 会跟着来 */ });
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (stopped || kicked || reconnectTimer !== null) return;
  const delay = everOnline ? backoffMs : RETRY_MS;
  if (everOnline) backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function rejectAllPending(reason: string): void {
  for (const [echo, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(echo);
    p.reject(new Error(reason));
  }
}

// ===== action 调用（同一条 WS，echo 匹配；接口规格 §6） =====

/** 未连接时 reject；回包 status ∈ {ok, async} 算成功，返回 data。 */
export function callAction<T = unknown>(action: string, params: object, timeoutMs: number = CALL_TIMEOUT_MS): Promise<T> {
  const socket = ws;
  if (socket === null || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('QQ 未连接'));
  }
  const echo = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`action ${action} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    pending.set(echo, { resolve: resolve as (data: unknown) => void, reject, timer });
    try {
      socket.send(JSON.stringify({ action, params, echo }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(echo);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ===== 事件分派 =====

/** WS 文本帧分派（导出给测试直接喂 JSON） */
export function handleOnebotMessage(text: string): void {
  // stopOnebotClient 后即使测试桩、旧事件队列或第三方 WebSocket 实现又投递一帧，
  // 也不能让 lifecycle 重新写 settings 或排队挂库。
  if (stopped) return;
  let obj: Json;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    obj = parsed as Json;
  } catch {
    return; // 非 JSON（心跳/垃圾数据），忽略
  }

  // 1) action 回包：echo 匹配
  const echo = str(obj.echo);
  if (echo !== '') {
    const p = pending.get(echo);
    if (p !== undefined) {
      clearTimeout(p.timer);
      pending.delete(echo);
      if (obj.status === 'ok' || obj.status === 'async') p.resolve(obj.data);
      else p.reject(new Error(`action 失败: ${str(obj.status)} ${str(obj.message)}`));
      return;
    }
  }

  // 2) lifecycle：登录成功的唯一信号（接口规格 §5）。self_id 即账号 → 写 settings.uin → online
  if (obj.post_type === 'meta_event' && obj.meta_event_type === 'lifecycle') {
    const uin = str(obj.self_id);
    if (!isValidUin(uin)) return;
    // Duplicate announcements on this authenticated socket must not cancel its backfill
    // or start another one. A new socket, account or failed DB mount still runs recovery.
    if (onlineLifecycle?.socket === ws && onlineLifecycle.uin === uin &&
        onlineLifecycle.epoch === lifecycleEpoch && onlineLifecycle.generation === dbGeneration() &&
        accountDbError === null && accountDataState() === 'ready' && currentAccount() === uin) return;
    if (selfId !== null && selfId !== uin) rejectAllPending('QQ 账号已切换');
    const epoch = ++lifecycleEpoch;
    selfId = uin;
    everOnline = true;
    backoffMs = BACKOFF_START_MS;
    try {
      setUin(uin);
    } catch (error) {
      // settings 写失败会让“真实会话 B / 磁盘仍记 A”身份分裂；继续挂 B 后再擦除可能误删 A。
      // 立即断开采集并关回兜底库，所有账号业务在 transition 期间 fail closed。
      accountDbError = `无法保存登录账号：${error instanceof Error ? error.message : String(error)}`;
      accountDbDropped = 0;
      switchBuffer.length = 0;
      stopOnebotClient();
      void failAccountSession().catch((closeError) => {
        console.error('[onebot] 保存登录账号失败，且无法关闭账号库：', closeError);
      });
      return;
    }
    // 按账号分库（修复计划第一节 + 四问题修复 #1）：登录成功的账号 = 数据归属，先切到它的库
    // 再开始收消息。切库（静默流水线）完成前，新到的群消息先攒进缓冲，切完按序入库。
    void onLifecycleOnline(uin, epoch);
    return;
  }

  // 3) 被挤下线（接口规格 §7）：立即结束进程树（killedByUs → 不会触发自动重启），不自动重连
  if (obj.post_type === 'notice' && obj.notice_type === 'bot_offline') {
    kicked = true;
    killTree();
    return;
  }

  // 4) 群消息（自己发的以 post_type = message_sent 推送，FR-1.2）
  //    @规则：@了别人（没 @全体、也没 @我）的消息直接忽略，不入库
  if ((obj.post_type === 'message' || obj.post_type === 'message_sent') && obj.message_type === 'group') {
    // OneBot 事件必须显式携带 self_id。不能用当前登录号猜归属，否则旧连接缺字段的迟到帧
    // 会在 A→B 后被误认成 B 的消息，正好绕过账号隔离。
    const eventUin = str(obj.self_id);
    if (eventUin === '') return; // 无法证明归属的帧不能写账号库
    if (mentionOf(obj.message, eventUin) === 'other') return;
    const m = toMessage(obj);
    if (m === null) return;
    const forwards = forwardResIds(obj.message);
    if (accountDataState() === 'error' || accountDbError !== null) {
      // 账号库挂载失败：写进去就是串到别的账号的库。宁可丢弃（下次 lifecycle 重试切库后历史补齐会兜回）
      accountDbDropped++;
      if (accountDbDropped === 1 || accountDbDropped % 100 === 0) {
        console.warn(
          `[onebot] 账号库挂载失败，已丢弃 ${accountDbDropped} 条消息：${accountDbError ?? '账号数据当前不可用'}`,
        );
      }
      return;
    }
    if (isAccountSwitching()) {
      // 正在切账号库：先攒着，切完按序入库（onLifecycleOnline 里 flush）
      if (switchBuffer.length >= SWITCH_BUFFER_MAX) {
        switchBuffer.shift();
        switchBufferDropped++;
      }
      switchBuffer.push({ uin: eventUin, message: m, forwards });
      scheduleSwitchBufferFlush();
      return;
    }
    // 旧连接/旧账号的迟到推送：即使当前没有处于切库窗口也必须丢弃。
    if (currentAccount() !== eventUin) return;
    ingestMessages([m], 'onebot');
    // 合并转发段：漫游窗口之外的聊天记录只能靠它补——用户「多选→合并转发」进监听群，
    // 这里异步展开成节点消息入库（去重靠 message_id / message_seen，重复转发无副作用）
    for (const resId of forwards) expandForward(resId, m.group_id);
  }
}

// ===== 合并转发展开 =====

interface AccountTaskContext {
  uin: string;
  generation: number;
  lifecycle: number;
}

function captureAccountTask(uin: string | null = currentAccount()): AccountTaskContext | null {
  return uin === null ? null : { uin, generation: dbGeneration(), lifecycle: lifecycleEpoch };
}

function accountTaskIsCurrent(ctx: AccountTaskContext): boolean {
  return (
    ctx.lifecycle === lifecycleEpoch &&
    ctx.generation === dbGeneration() &&
    ctx.uin === currentAccount() &&
    ctx.uin === selfId &&
    accountDataState() === 'ready' &&
    !isAccountSwitching()
  );
}

/** 正在展开的「数据库代次 + res_id」：不同账号相同 res_id 互不压制。 */
const expandingForwards = new Set<string>();

/** 消息段数组里的 forward res_id（data.id；个别实现叫 res_id） */
export function forwardResIds(segments: unknown): string[] {
  if (!Array.isArray(segments)) return [];
  const ids: string[] = [];
  for (const seg of segments) {
    if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) continue;
    const s = seg as Json;
    if (str(s.type) !== 'forward') continue;
    const data = (s.data !== null && typeof s.data === 'object' && !Array.isArray(s.data) ? s.data : {}) as Json;
    const id = str(data.id) || str(data.res_id);
    if (id !== '') ids.push(id);
  }
  return ids;
}

/**
 * get_forward_msg 把 res_id 展开成节点消息，按 source='forward' 入库。
 * 节点优先用原 message_id（和实时流/历史拉到的同一条能对上去重）；
 * 没有的给稳定合成 id，同一条转发重复展开不会重复入库。
 * 嵌套转发（转发里套转发）不再递归，渲染为 [转发]。
 */
export function expandForward(
  resId: string,
  groupId: string,
  context: AccountTaskContext | null = captureAccountTask(),
): void {
  if (context === null || !accountTaskIsCurrent(context)) return;
  const key = `${context.generation}:${resId}`;
  if (expandingForwards.has(key)) return;
  expandingForwards.add(key);
  void (async () => {
    try {
      const data = await callAction<unknown>('get_forward_msg', { id: resId });
      if (!accountTaskIsCurrent(context)) return;
      const nodes = Array.isArray(data)
        ? data
        : Array.isArray((data as Json)?.messages)
          ? ((data as Json).messages as unknown[])
          : [];
      const msgs: Message[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
        const n = node as Json;
        const segs = n.content ?? n.message;
        const text = typeof segs === 'string' ? segs : segmentsToText(segs);
        if (text === '') continue;
        const sender = (n.sender !== null && typeof n.sender === 'object' && !Array.isArray(n.sender) ? n.sender : {}) as Json;
        const timeSec = typeof n.time === 'number' ? n.time : Number(str(n.time)) || 0;
        const nid = str(n.message_id);
        msgs.push({
          message_id: nid !== '' ? nid : `fwd-${resId}-${i}`,
          group_id: groupId,
          group_name: getGroupNameCached(groupId),
          sender_name: str(sender.card) || str(sender.nickname) || '未知',
          text,
          sent_at: timeSec * 1000,
        });
      }
      if (msgs.length > 0) {
        if (!accountTaskIsCurrent(context)) return;
        const { inserted } = ingestMessages(msgs, 'forward');
        console.log(`[onebot] 合并转发已展开：res_id=${resId} 节点=${msgs.length} 新入库=${inserted}`);
      }
    } catch (e) {
      console.warn(`[onebot] 合并转发展开失败（res_id=${resId}）：`, e);
    } finally {
      expandingForwards.delete(key);
    }
  })();
}

/** 切库期间攒下的消息上限：满了丢最旧的（登录刚完成的窗口期极短，历史补齐会兜回来） */
const SWITCH_BUFFER_MAX = 500;
let switchBufferDropped = 0;
const switchBuffer: Array<{ uin: string; message: Message; forwards: string[] }> = [];

/**
 * 账号库挂载失败状态（成熟度评估 S04 残留）：非 null 时所有群消息直接丢弃、
 * 历史补齐不再跑——写下去就是串到别的账号库/兜底库。连接状态机会把「账号库挂载失败」
 * 报给用户；下次 lifecycle（重连/重启）会重试 switchAccount。
 */
let accountDbError: string | null = null;
let accountDbDropped = 0;

let switchBufferFlushScheduled = false;

/**
 * 任意账号 transition 都可能短暂关闸（不只 lifecycle 换号，删除另一个账号也会）。
 * transition 全部结束后，把最终当前账号的消息冲进它自己的库；不再属于当前账号的缓冲直接丢弃。
 */
function flushSwitchBuffer(): void {
  if (isAccountSwitching()) {
    scheduleSwitchBufferFlush();
    return;
  }
  const uin = currentAccount();
  if (uin === null || selfId !== uin || accountDbError !== null || accountDataState() !== 'ready') {
    switchBuffer.length = 0;
    return;
  }
  const context = captureAccountTask(uin);
  if (context === null || !accountTaskIsCurrent(context)) return;
  const buffered = switchBuffer.splice(0).filter((item) => item.uin === uin);
  if (buffered.length > 0) ingestMessages(buffered.map((item) => item.message), 'onebot');
  for (const item of buffered) {
    for (const resId of item.forwards) expandForward(resId, item.message.group_id, context);
  }
}

function scheduleSwitchBufferFlush(): void {
  if (switchBufferFlushScheduled) return;
  switchBufferFlushScheduled = true;
  void waitForAccountTransitions().then(
    () => {
      switchBufferFlushScheduled = false;
      flushSwitchBuffer();
    },
    () => {
      switchBufferFlushScheduled = false;
      switchBuffer.length = 0;
    },
  );
}

/** lifecycle 后：切到该账号的库 → 攒下的消息按序入库 → 刷群名 + 历史补齐（FR-2）。 */
async function onLifecycleOnline(uin: string, epoch: number): Promise<void> {
  try {
    await switchAccount(uin);
    // switchAccount 后面可能还排着账号数据删除等操作；等闸门真正重开再冲刷消息。
    await waitForAccountTransitions();
  } catch (e) {
    // 切库失败（磁盘满/权限/文件锁）：绝不能沿用当前库继续写——那会把 A 号的消息写进 B 号。
    // 断流 + 报错；缓冲丢弃，等切库重试成功后历史补齐兜回。
    if (epoch === lifecycleEpoch && selfId === uin) {
      accountDbError = e instanceof Error ? e.message : String(e);
      accountDbDropped = 0;
      console.error('[onebot] 切换账号库失败，暂停写入直到重连重试：', e);
      switchBuffer.length = 0;
    }
    return;
  }
  // 更晚的 lifecycle 已排队或完成：这个旧任务不能冲刷缓冲、刷新缓存或启动历史同步。
  if (epoch !== lifecycleEpoch || selfId !== uin || currentAccount() !== uin || isAccountSwitching()) return;
  accountDbError = null;
  accountDbDropped = 0;
  if (switchBufferDropped > 0) {
    console.warn(`[onebot] 切库期间缓冲溢出，丢弃了 ${switchBufferDropped} 条早期消息（历史补齐会补回）`);
    switchBufferDropped = 0;
  }
  flushSwitchBuffer();
  const context = captureAccountTask(uin);
  if (context === null || !accountTaskIsCurrent(context)) return;
  onlineLifecycle = { socket: ws, uin, generation: context.generation, epoch };
  // 刷群名 + 历史补齐（FR-2：每次进入 online 自动跑一次），失败不影响连接
  const desktopGapSince = takeDesktopRecovery(uin);
  void afterOnline(context, desktopGapSince);
}

// ===== @ 规则 =====

/**
 * 一条消息的 @ 指向：
 * - 'none'  没有 @ 任何人 → 视为全体须知，照常处理
 * - 'all'   @全体成员 → 照常处理
 * - 'me'    @了我自己 → 照常处理
 * - 'other' 只 @了别人 → 与我无关，忽略
 * selfId 不知道（还没登录过）时无法判断是不是 @我，按 'me' 放行，宁可多收不漏收。
 */
export type Mention = 'none' | 'all' | 'me' | 'other';

export function mentionOf(segments: unknown, selfId: string | null | undefined): Mention {
  try {
    if (!Array.isArray(segments)) return 'none';
    let sawAt = false;
    for (const seg of segments) {
      if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) continue;
      const s = seg as Json;
      if (str(s.type) !== 'at') continue;
      sawAt = true;
      const data = (s.data !== null && typeof s.data === 'object' && !Array.isArray(s.data) ? s.data : {}) as Json;
      const qq = str(data.qq);
      if (qq === 'all') return 'all';
      if (!selfId || qq === selfId) return 'me';
    }
    return sawAt ? 'other' : 'none';
  } catch {
    return 'none'; // 解析出错不能丢消息
  }
}

/** 当前登录的 QQ 号：本次运行的 lifecycle 优先，其次 settings.json 里记住的 */
function currentSelfId(): string | null {
  if (selfId !== null) return selfId;
  try {
    return getUin() ?? null;
  } catch {
    return null;
  }
}

/** 历史补齐用：这条历史消息是否只 @了别人（是则跳过） */
export function isMentionOther(item: unknown): boolean {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
  return mentionOf((item as Json).message, currentSelfId()) === 'other';
}

/** 上次历史补齐成功的时间（B7：重连后只补断线那段，不再每次全量拉 7 天） */
let lastSyncAt = 0;

/** lifecycle 后异步执行：refreshGroups → syncHistory。动态 import 避免 onebot ⇄ history 加载环。 */
async function afterOnline(context: AccountTaskContext, desktopGapSince: number | null = null): Promise<void> {
  try { await refreshAfterOnline(context, desktopGapSince); }
  finally {
    if (desktopGapSince !== null) finishDesktopRecovery(context.uin, desktopGapSince);
  }
}

async function refreshAfterOnline(context: AccountTaskContext, desktopGapSince: number | null): Promise<void> {
  try {
    const info = await callAction<Json>('get_login_info', {});
    if (!accountTaskIsCurrent(context)) return;
    const nick = str(info?.nickname).trim();
    if (nick !== '') selfNickname = nick;
  } catch {
    // 昵称拿不到不致命，页面显示 QQ 号
  }
  if (!accountTaskIsCurrent(context)) return;
  try {
    await refreshGroups(context);
  } catch {
    // 群名刷不出来不致命，下次 online 再试
  }
  if (!accountTaskIsCurrent(context)) return;
  try {
    const { syncHistory } = await import('../ingest/history.js');
    if (!accountTaskIsCurrent(context)) return;
    // 常规重连按天补读；从电脑版 QQ 返回只补离开区间，并留 1 分钟重叠去重。
    const DAY = 86_400_000;
    const days = desktopGapSince !== null
      ? Math.min(30, Math.max(1 / DAY, (Date.now() - desktopGapSince + 60_000) / DAY))
      : lastSyncAt === 0 ? 7 : Math.min(30, Math.max(1, Math.ceil((Date.now() - lastSyncAt) / DAY)));
    await syncHistory(days);
    if (!accountTaskIsCurrent(context)) return;
    lastSyncAt = Date.now();
  } catch {
    // 历史补齐失败不致命（还有手动兜底 POST /api/sync）
  }
}

// 换号：旧号的群名缓存、昵称、补齐时间点都清掉（selfId 由 lifecycle 负责，不动）
onAccountSwitch(() => {
  groupNameCache.clear();
  selfNickname = null;
  lastSyncAt = 0;
});

/** get_group_list → 内存缓存 + 逐群 upsertGroup 刷新群名（B 的 ingest） */
export async function refreshGroups(
  context: AccountTaskContext | null = captureAccountTask(),
): Promise<void> {
  if (context === null || !accountTaskIsCurrent(context)) return;
  const groups = await callAction<Array<Json>>('get_group_list', {});
  if (!accountTaskIsCurrent(context) || !Array.isArray(groups)) return;
  for (const g of groups) {
    if (g === null || typeof g !== 'object') continue;
    const id = str(g.group_id);
    if (id === '') continue;
    const name = str(g.group_name);
    if (name !== '') groupNameCache.set(id, name);
    upsertGroup(id, name === '' ? id : name, 'onebot');
  }
}

// ===== 事件 → 统一 Message =====

/**
 * OneBot group 消息事件 → Message。post_type 为 message 或 message_sent、
 * message_type 为 group 才转换，否则返回 null。任何异常都 catch 返回 null。
 */
export function toMessage(ev: unknown, groupNameOf?: (groupId: string) => string): Message | null {
  try {
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return null;
    const e = ev as Json;
    const postType = str(e.post_type);
    if (postType !== 'message' && postType !== 'message_sent') return null;
    if (str(e.message_type) !== 'group') return null;
    const groupId = str(e.group_id);
    if (groupId === '') return null;
    const sender = (e.sender !== null && typeof e.sender === 'object' && !Array.isArray(e.sender) ? e.sender : {}) as Json;
    const senderName = str(sender.card) || str(sender.nickname) || '未知';
    const timeSec = typeof e.time === 'number' ? e.time : Number(str(e.time)) || 0;
    const messageId = str(e.message_id);
    // B4：缺 message_id 的消息不入库——用 '' 当主键会把之后所有缺 id 的消息都当重复丢掉
    if (messageId === '') return null;
    return {
      message_id: messageId,
      group_id: groupId,
      group_name: groupNameOf !== undefined ? groupNameOf(groupId) : getGroupNameCached(groupId),
      sender_name: senderName,
      text: segmentsToText(e.message),
      sent_at: timeSec * 1000, // OneBot 的 time 是秒；内部一律毫秒（00-总约定 §4）
    };
  } catch {
    return null;
  }
}

/**
 * 消息段数组 → 纯文本（FR-1.3）：text→原文；at（含 @全体成员）→[at]；image→[图片]；
 * face/mface→[表情]；reply→空；json→[卡片]；forward→[转发]；file→[文件]；
 * record→[语音]；video→[视频]；其他→[消息]。任何异常都 catch，不让连接断掉。
 */
export function segmentsToText(segments: unknown): string {
  try {
    if (typeof segments === 'string') return segments; // 容错：字符串格式的 message
    if (!Array.isArray(segments)) return '[消息]';
    const parts: string[] = [];
    for (const seg of segments) {
      if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) {
        parts.push('[消息]');
        continue;
      }
      const s = seg as Json;
      const type = str(s.type);
      const data = (s.data !== null && typeof s.data === 'object' && !Array.isArray(s.data) ? s.data : {}) as Json;
      switch (type) {
        case 'text': {
          const text = str(data.text);
          if (text !== '') parts.push(text);
          break;
        }
        case 'at': parts.push('[at]'); break; // qq === 'all'（@全体成员）也是 [at]
        case 'reply': break;                  // 引用回复不占文本
        case 'image': parts.push('[图片]'); break;
        case 'face':
        case 'mface': parts.push('[表情]'); break;
        case 'json': parts.push('[卡片]'); break;
        case 'forward': parts.push('[转发]'); break;
        case 'file': parts.push('[文件]'); break;
        case 'record': parts.push('[语音]'); break;
        case 'video': parts.push('[视频]'); break;
        default: parts.push('[消息]'); break;
      }
    }
    return parts.join('');
  } catch {
    return '[消息]';
  }
}

/** 群名：优先 get_group_list 内存缓存，没有就用 String(group_id)（分工 A4） */
export function getGroupNameCached(groupId: string): string {
  const name = groupNameCache.get(groupId);
  return name === undefined || name === '' ? groupId : name;
}

/** 供 state.ts（A5）推导连接状态用 */
export function getOnebotFacts(): OnebotFacts {
  return {
    wsConnected: ws !== null && ws.readyState === WebSocket.OPEN,
    everOnline,
    selfId,
    kicked,
    accountError: accountDbError,
  };
}

/** 当前登录者的 QQ 昵称（还没拿到返回 null） */
export function getSelfNickname(): string | null {
  return selfNickname;
}

/** WS 已连上且已收到 lifecycle self_id（= online，POST /api/sync 用） */
export function isOnline(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN && selfId !== null;
}

/**
 * 用户点了「重新连接 / 关闭电脑版 QQ 并继续 / 重启采集端」后调用：
 * 清掉 kicked 标志（否则 WS 循环永远不再连）、重置退避与 online 记忆，并立即恢复连接尝试。
 * 由 napcat/index.ts 的 restartNapcat() 在 manager.restart()（新进程已 spawn）之后调用。
 */
export function resetAfterRestart(): void {
  lifecycleEpoch++;
  // 旧连接可能还 OPEN（进程刚被杀的窗口期），不关掉的话 connect() 会直接 return，
  // 旧连接推来的消息会在 selfId=null 时按 'me' 全部放行
  if (ws !== null) {
    const old = ws;
    ws = null;
    try { old.close(); } catch { /* ignore */ }
  }
  rejectAllPending('QQ 连接已重置');
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  kicked = false;
  everOnline = false;
  selfId = null;
  selfNickname = null;
  groupNameCache.clear();
  switchBuffer.length = 0;
  switchBufferDropped = 0;
  backoffMs = BACKOFF_START_MS;
  stopped = false;
  accountDbError = null; // 重连会重新走 lifecycle → switchAccount 重试
  accountDbDropped = 0;
  connect();
}

// ===== 工具 =====

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}
