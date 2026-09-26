// OneBot WS 客户端（架构.md §2/§3 第 5~6 步；NapCat接口规格.md §5/§6/§7）。主人是 A（分工 A4）。
// 唯一接入：ws://127.0.0.1:3001，事件推送与 action 调用走同一条连接（按 echo 匹配回包）。
// 铁律：任何解析/处理异常都 catch，绝不让连接断掉。
import { randomUUID } from 'node:crypto';
import { ingestMessages, upsertGroup } from '../ingest/index.js';
import { killTree, setUin } from './manager.js';
import type { Message } from '../types.js';

const WS_URL = 'ws://127.0.0.1:3001';
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
}

// ===== WS 连接循环 =====

/** startNapcat 时启动。未登录时连不上属正常，循环重试；NapCat 只在登录成功后才开 3001。 */
export function startOnebotClient(): void {
  stopped = false;
  if (reconnectTimer === null) connect();
}

/** 进程退出时调用：停掉重连并关闭连接 */
export function stopOnebotClient(): void {
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
    const w = new WebSocket(WS_URL);
    ws = w;
    w.addEventListener('message', (ev: MessageEvent) => {
      try { handleMessage(String(ev.data)); } catch { /* 任何异常都不能断连 */ }
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

function handleMessage(text: string): void {
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
    if (uin === '') return;
    selfId = uin;
    everOnline = true;
    backoffMs = BACKOFF_START_MS;
    try { setUin(uin); } catch { /* settings 写失败不致命 */ }
    // 异步刷群名 + 历史补齐（FR-2：每次进入 online 自动跑一次），失败不影响连接
    void afterOnline();
    return;
  }

  // 3) 被挤下线（接口规格 §7）：立即结束进程树（killedByUs → 不会触发自动重启），不自动重连
  if (obj.post_type === 'notice' && obj.notice_type === 'bot_offline') {
    kicked = true;
    killTree();
    return;
  }

  // 4) 群消息（自己发的以 post_type = message_sent 推送，FR-1.2）
  if ((obj.post_type === 'message' || obj.post_type === 'message_sent') && obj.message_type === 'group') {
    const m = toMessage(obj);
    if (m !== null) ingestMessages([m], 'onebot');
  }
}

/** lifecycle 后异步执行：refreshGroups → syncHistory。动态 import 避免 onebot ⇄ history 加载环。 */
async function afterOnline(): Promise<void> {
  try {
    await refreshGroups();
  } catch {
    // 群名刷不出来不致命，下次 online 再试
  }
  try {
    const { syncHistory } = await import('../ingest/history.js');
    await syncHistory();
  } catch {
    // 历史补齐失败不致命（还有手动兜底 POST /api/sync）
  }
}

/** get_group_list → 内存缓存 + 逐群 upsertGroup 刷新群名（B 的 ingest） */
export async function refreshGroups(): Promise<void> {
  const groups = await callAction<Array<Json>>('get_group_list', {});
  if (!Array.isArray(groups)) return;
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
    return {
      message_id: str(e.message_id),
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
  };
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
  kicked = false;
  everOnline = false;
  selfId = null;
  backoffMs = BACKOFF_START_MS;
  connect();
}

// ===== 工具 =====

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}
