import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { z } from 'zod';
import { validWechatDataRoot } from './wechat-catalog-channel.js';
import { wechatPythonArgs, wechatPythonEnv } from './wechat-python.js';
import type { WechatReadContext } from './wechat-group-selection.js';
import type { WechatAcknowledgement } from './wechat.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const groupId = z.string().regex(/^[A-Za-z0-9_-]+@chatroom$/);
const eventId = z.string().regex(/^[a-f0-9]{64}$/);
const statusSchema = z.record(groupId, z.object({ pending: count, deferred: count }).strict());
export type WechatMessageStatus = z.infer<typeof statusSchema>;
const planSchema = z.object({ group_id: groupId,
  name: z.string().refine((v) => Buffer.byteLength(v) <= 4096 && Buffer.from(v).toString('utf8') === v),
  receipt_path: z.string().min(1).max(4096), activation_id: z.uuidv4(),
  activation_pending: z.boolean(), require_existing_progress: z.boolean() }).strict();
export type WechatMessagePlan = z.infer<typeof planSchema>;
export const wechatIssueReasons = [
  'DELIVERY_MESSAGE_TYPE_UNSUPPORTED', 'DELIVERY_COMPRESSED_FIELD_UNSUPPORTED', 'DELIVERY_TEXT_NOT_DECODED',
  'DELIVERY_TEXT_CONFLICT', 'DELIVERY_TEXT_INVALID', 'DELIVERY_TEXT_LIMIT',
  'DELIVERY_MESSAGE_METADATA_INVALID', 'DELIVERY_NAMES_UNAVAILABLE',
] as const;
const issuesSchema = z.array(z.object({ event_id: eventId, group_id: groupId,
  reason: z.enum(wechatIssueReasons) }).strict()).max(100);
export type WechatMessageIssue = z.infer<typeof issuesSchema>[number];
const tickSchema = z.object({
  saved: z.record(groupId, z.object({ saved: count, may_have_more: z.boolean() }).strict()),
  delivered: z.record(groupId, z.object({ delivered: count, inserted: count, replayed: z.boolean(),
    has_more: z.boolean(), deferred: count }).strict()), status: statusSchema,
}).strict();
const historySchema = z.object({ inserted: count, has_more: z.boolean() }).strict();
const knownFailures = z.enum(['MESSAGE_SOURCE_UNAVAILABLE', 'MESSAGE_SOURCE_METADATA_TIMEOUT', 'MESSAGE_SOURCE_REDIRECTED',
  'LOCAL_RECEIPT_ACTIVATION_MISMATCH', 'LOCAL_RECEIPT_NOT_INITIALIZED', 'LOCAL_RECEIPT_BINDING_MISMATCH',
  'LOCAL_RECEIPT_OPEN_FAILED', 'LOCAL_RECEIPT_FORMAT_MISMATCH', 'LOCAL_RECEIPT_SCHEMA_MISMATCH',
  'LOCAL_RECEIPT_INTEGRITY_FAILED', 'KEY_SCAN_BYTE_BUDGET_EXCEEDED', 'KEY_SCAN_TIME_EXCEEDED',
  'SNAPSHOT_LOCK_BUSY', 'SNAPSHOT_SOURCE_CHANGED', 'SELECTED_GROUP_NOT_FOUND', 'SHARD_GENERATION_CHANGED',
  'IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT', 'JOINT_ACCOUNT_CHANGED', 'JOINT_WINDOW_STATE_CHANGED',
  'JOINT_PROCESS_OR_MODULE_CHANGED', 'DELIVERY_ACK_MISMATCH', 'DELIVERY_NOT_ACKNOWLEDGED', 'MESSAGE_WORKER_FAILED',
  'ZSTD_PACKAGE_UNAVAILABLE', 'ZSTD_PACKAGE_VERSION_UNSUPPORTED']);
const LIMIT = 8388608;
interface Options {
  executable: string; entry: string;
  context: WechatReadContext; dataRoot: string; destination: string;
  groups: readonly WechatMessagePlan[];
  approveMessageRead: boolean; approveKeyRead: boolean; approveSelectedStorage: boolean;
  signal: AbortSignal;
  proof(): Promise<WechatReadContext | null>;
  activated(group: string, activation: string): void;
  receive(batch: unknown): WechatAcknowledgement;
  launch?: (executable: string, args: string[]) => ChildProcessWithoutNullStreams;
}
interface Pending {
  seq: number; kind: 'ready' | 'result'; mid: number;
  command: string;
  resolve(value: Record<string, unknown>): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Inert until start(). All source data travels through owned pipes. No listener,
 * public account/path input, automatic AI or implicit consent. Every business
 * commit is preceded by fresh proof and the supplied DB-bound synchronous sink.
 */
export class WechatMessageChannel {
  private readonly token = randomBytes(32).toString('hex');
  private child?: ChildProcessWithoutNullStreams;
  private reaped: Promise<void> = Promise.resolve();
  private pending?: Pending;
  private seq = 0;
  private buffer = Buffer.alloc(0);
  private frames: Promise<void> = Promise.resolve();
  private frameBytes = 0;
  private readonly acknowledgedGroups = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private state: 'new' | 'opening' | 'open' | 'closed' = 'new';
  private error = 'WECHAT_MESSAGE_CLOSED';
  private readonly abort = () => this.fail('WECHAT_MESSAGE_NOT_CURRENT');
  constructor(private readonly options: Options) {}
  private isClosed(): boolean { return this.state === 'closed'; }

  private async proof(): Promise<void> {
    const current = await this.options.proof();
    const expected = this.options.context;
    if (this.options.signal.aborted || this.state === 'closed' || !current || current.account !== expected.account
        || current.connectionId !== expected.connectionId || current.epoch !== expected.epoch) {
      throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
    }
  }
  private fail(code: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed'; this.error = code;
    this.buffer = Buffer.alloc(0);
    if (this.pending) {
      clearTimeout(this.pending.timer); this.pending.reject(new Error(code)); this.pending = undefined;
    }
    this.child?.stdin.destroy(); this.child?.kill(); // Only our child, never WeChat.
  }
  private write(value: unknown): void {
    const line = Buffer.from(JSON.stringify(value) + '\n');
    if (!this.child || this.state === 'closed') throw new Error(this.error);
    if (line.length > LIMIT) throw new Error('WECHAT_MESSAGE_LIMIT');
    this.child.stdin.write(line);
  }
  private async frame(raw: Buffer): Promise<void> {
    if (this.state === 'closed') return;
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      const base = z.object({ v: z.literal(1), token: z.literal(this.token), seq: z.literal(this.pending?.seq),
        kind: z.string() }).passthrough().parse(value);
      const pending = this.pending;
      if (!pending) throw new Error();
      const schema = <T extends z.ZodRawShape>(shape: T) => z.object({
        v: z.literal(1), token: z.literal(this.token), seq: z.literal(pending.seq), ...shape,
      }).strict();
      if (base.kind === 'error') {
        const error = schema({ kind: z.literal('error'), reason: z.string().max(256),
          sink_phase: z.enum(['identity_recheck', 'receipt_commit', 'unknown']).optional(),
          sink_reason: z.string().max(256).optional() }).parse(value);
        const known = knownFailures.safeParse(error.reason);
        this.fail(known.success ? `WECHAT_MESSAGE_${known.data}` : 'WECHAT_MESSAGE_WORKER_FAILED'); return;
      }
      if (base.kind === 'activation' || base.kind === 'delivery') {
        const item = schema({ kind: z.enum(['activation', 'delivery']),
          mid: z.literal(pending.mid + 1), payload: z.unknown() }).parse(value);
        let payload: unknown;
        if (item.kind === 'activation') {
          if (pending.kind !== 'ready') throw new Error();
          const activation = z.object({ group_id: groupId, activation_id: z.uuidv4() }).strict().parse(item.payload);
          if (!this.options.groups.some((g) => g.group_id === activation.group_id && g.activation_id === activation.activation_id)) throw new Error();
          if (this.acknowledgedGroups.has(activation.group_id)) throw new Error();
          await this.proof();
          this.options.activated(activation.group_id, activation.activation_id);
          this.acknowledgedGroups.add(activation.group_id);
          payload = { accepted: true };
        } else {
          if (!['tick', 'history_start', 'history_next'].includes(pending.command)) throw new Error();
          await this.proof();
          payload = this.options.receive(item.payload);
        }
        if (this.isClosed() || this.pending !== pending) return;
        pending.mid = item.mid;
        this.write({ v: 1, token: this.token, seq: pending.seq, command: `${item.kind}_ack`, mid: item.mid, payload });
        return;
      }
      const result = pending.kind === 'ready'
        ? schema({ kind: z.literal('ready'), status: statusSchema }).parse(value)
        : schema({ kind: z.literal('result'), result: z.unknown() }).parse(value);
      if (pending.kind === 'ready' && this.acknowledgedGroups.size !== this.options.groups.length) throw new Error();
      await this.proof();
      if (this.isClosed() || this.pending !== pending) return;
      clearTimeout(pending.timer); this.pending = undefined;
      pending.resolve(result);
    } catch { this.fail('WECHAT_MESSAGE_RESPONSE_OR_COMMIT_FAILED'); }
  }
  private data(chunk: Buffer): void {
    if (this.state === 'closed') return;
    if (!Buffer.isBuffer(chunk) || this.buffer.length + chunk.length > LIMIT * 2) { this.fail('WECHAT_MESSAGE_LIMIT'); return; }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      if (newline + 1 > LIMIT) { this.fail('WECHAT_MESSAGE_LIMIT'); return; }
      const raw = Buffer.from(this.buffer.subarray(0, newline));
      this.buffer = this.buffer.subarray(newline + 1);
      this.frameBytes += raw.length;
      if (this.frameBytes > LIMIT * 2) { this.fail('WECHAT_MESSAGE_LIMIT'); return; }
      this.frames = this.frames.then(() => this.frame(raw)).finally(() => { this.frameBytes -= raw.length; });
    }
    if (this.buffer.length >= LIMIT) this.fail('WECHAT_MESSAGE_LIMIT');
  }
  private exchange(kind: Pending['kind'], command: string, request: unknown, timeout: number): Promise<Record<string, unknown>> {
    if (this.pending || this.state === 'closed') return Promise.reject(new Error(this.error));
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('WECHAT_MESSAGE_TIMEOUT'), timeout); timer.unref();
      this.pending = { seq, kind, command, mid: 0, timer, resolve, reject };
      try { this.write({ v: 1, token: this.token, seq, command, [kind === 'ready' ? 'config' : 'request']: request }); }
      catch { this.fail('WECHAT_MESSAGE_REQUEST_FAILED'); }
    });
  }
  async start(): Promise<WechatMessageStatus> {
    if (this.state !== 'new') throw new Error('WECHAT_MESSAGE_ALREADY_STARTED');
    const opts = this.options;
    if (opts.approveMessageRead !== true || opts.approveKeyRead !== true || opts.approveSelectedStorage !== true) throw new Error('WECHAT_MESSAGE_CONSENT_REQUIRED');
    if (!validWechatDataRoot(opts.dataRoot) || !/^wxid_[A-Za-z0-9_-]{1,120}$/.test(opts.context.account)
        || !opts.destination.trim() || Buffer.byteLength(opts.destination) > 256
        || !z.array(planSchema).min(1).max(10000).safeParse(opts.groups).success
        || new Set(opts.groups.map((g) => g.group_id)).size !== opts.groups.length
        || new Set(opts.groups.map((g) => g.receipt_path.toLowerCase().replaceAll('/', '\\'))).size !== opts.groups.length) {
      throw new Error('WECHAT_MESSAGE_CONFIG_INVALID');
    }
    this.state = 'opening';
    try {
      await this.proof();
      const args = wechatPythonArgs(opts.entry, ['--approve-identity-read', '--approve-key-read',
        '--approve-message-read', '--approve-selected-storage']);
      this.child = (opts.launch ?? ((exe, argv) => spawn(exe, argv, { windowsHide: true, shell: false,
        env: wechatPythonEnv(), stdio: ['pipe', 'pipe', 'pipe'] })))(opts.executable, args);
      // History refresh decrypts whole snapshots; keep WeChat's UI and the identity check responsive.
      try { if (this.child.pid) setPriority(this.child.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
      this.reaped = new Promise((resolve) => this.child!.once('close', () => {
        this.fail('WECHAT_MESSAGE_WORKER_CLOSED'); resolve();
      }));
      this.child.on('error', () => this.fail('WECHAT_MESSAGE_WORKER_FAILED'));
      for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
        stream.on('error', () => this.fail('WECHAT_MESSAGE_WORKER_FAILED'));
      }
      this.child.stdout.on('data', (chunk: Buffer) => this.data(chunk)); this.child.stderr.resume();
      opts.signal.addEventListener('abort', this.abort, { once: true });
      if (opts.signal.aborted) this.abort();
      const result = await this.exchange('ready', 'initialize', { account: opts.context.account, data_root: opts.dataRoot,
        destination: opts.destination, groups: opts.groups }, 150000);
      if (this.isClosed()) throw new Error(this.error);
      const status = this.checkStatus(result.status);
      this.state = 'open'; return status;
    } catch (error) {
      await this.close(); throw error;
    }
  }
  private checkStatus(input: unknown): WechatMessageStatus {
    const status = statusSchema.parse(input);
    if (Object.keys(status).length !== this.options.groups.length
        || this.options.groups.some((g) => !Object.hasOwn(status, g.group_id))) throw new Error('WECHAT_MESSAGE_SCOPE_INVALID');
    return status;
  }
  private command<T>(name: string, request: unknown, parse: (input: unknown) => T, timeout = 45000): Promise<T> {
    const job = this.queue.then(async () => {
      if (this.state !== 'open') throw new Error(this.error);
      try {
        await this.proof();
        const result = await this.exchange('result', name, request, timeout);
        return parse(result.result);
      } catch (error) { await this.close(); throw error; }
    });
    this.queue = job.catch(() => undefined); return job;
  }
  tick() { return this.command('tick', {}, (input) => {
    const result = tickSchema.parse(input); this.checkStatus(result.status);
    const expected = this.options.groups.map((g) => g.group_id);
    for (const rows of [result.saved, result.delivered]) {
      if (Object.keys(rows).length !== expected.length || expected.some((id) => !Object.hasOwn(rows, id))) throw new Error('WECHAT_MESSAGE_SCOPE_INVALID');
    }
    return result;
  }, 120000); } // Delivery may first read contact names (bounded ~50s in the worker).
  status() { return this.command('status', {}, (value) => this.checkStatus(value)); }
  history(group: string, days: 1 | 7 | 30, approveHistoryRead: boolean) {
    if (approveHistoryRead !== true || ![1, 7, 30].includes(days) || !this.options.groups.some((g) => g.group_id === group)) {
      return Promise.reject(new Error('WECHAT_HISTORY_CONSENT_OR_SCOPE_REQUIRED'));
    }
    // History captures/decrypts the source and delivers the saved page before
    // replying. It needs the full work budget, not the 45s status-query budget.
    return this.command('history_start', { group_id: group, days, approve_history_read: true }, (v) => historySchema.parse(v), 180000);
  }
  historyNext() { return this.command('history_next', {}, (v) => historySchema.parse(v), 180000); }
  issues(group: string) {
    if (!this.options.groups.some((g) => g.group_id === group)) return Promise.reject(new Error('WECHAT_MESSAGE_SCOPE_INVALID'));
    return this.command('issues', { group_id: group }, (v) => {
      const rows = issuesSchema.parse(v);
      if (rows.some((row) => row.group_id !== group)) throw new Error('WECHAT_MESSAGE_SCOPE_INVALID');
      return rows;
    });
  }
  retryIssues(group: string, events: string[]) {
    if (!this.options.groups.some((g) => g.group_id === group) || !z.array(eventId).min(1).max(100).safeParse(events).success
        || new Set(events).size !== events.length) return Promise.reject(new Error('WECHAT_MESSAGE_SCOPE_INVALID'));
    return this.command('retry_issues', { group_id: group, event_ids: events }, (v) => this.checkStatus(v));
  }
  async close(): Promise<void> {
    this.fail('WECHAT_MESSAGE_CLOSED');
    this.options.signal.removeEventListener('abort', this.abort);
    await this.reaped;
    this.child?.stdout.destroy(); this.child?.stderr.destroy();
  }
}
