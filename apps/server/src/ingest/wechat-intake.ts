import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { db, dbGeneration } from '../db/index.js';
import { WechatMessageChannel, type WechatMessageStatus, type WechatMessagePlan } from './wechat-message-channel.js';
import { WechatSelectionStore } from './wechat-selection-store.js';
import { wechatIdentityRuntime } from './wechat-python.js';
import { bindWechatDestination } from './wechat.js';
import type { WechatReadContext, WechatSelectedScope } from './wechat-group-selection.js';
import type { WechatIntakeDTO } from '../../../../shared/wechat.js';

type Scope = WechatSelectedScope & { readonly dataRoot?: string };
type Channel = Pick<WechatMessageChannel, 'start' | 'tick' | 'status' | 'history' | 'historyNext' | 'issues' | 'retryIssues' | 'close'>;
type ChannelOptions = ConstructorParameters<typeof WechatMessageChannel>[0];
interface Options {
  root: string;
  current(): WechatReadContext | null;
  selected(): Scope | null;
  destination(): string | null;
  revalidate(context: WechatReadContext): Promise<boolean>;
  createChannel?(options: ChannelOptions): Channel;
  receiptRoot?(): string;
  runtime?(): { executable: string; entry: string };
}
interface Job {
  id: string; context: WechatReadContext; scope: Scope; destination: string;
  generation: number; plans: WechatMessagePlan[]; abort: AbortController; channel: Channel;
  counts: WechatMessageStatus; timer?: ReturnType<typeof setTimeout>;
  phase: 'opening' | 'collecting';
  history?: { group: string; days: 1 | 7 | 30 };
  lastReceivedAt?: number;
}
const known = new Set(['WECHAT_MESSAGE_NOT_CURRENT', 'WECHAT_MESSAGE_TIMEOUT', 'WECHAT_MESSAGE_WORKER_CLOSED',
  'WECHAT_MESSAGE_LOCAL_RECEIPT_NOT_INITIALIZED', 'WECHAT_MESSAGE_LOCAL_RECEIPT_ACTIVATION_MISMATCH',
  'WECHAT_MESSAGE_MESSAGE_SOURCE_UNAVAILABLE', 'WECHAT_MESSAGE_SELECTED_GROUP_NOT_FOUND',
  'WECHAT_MESSAGE_ZSTD_PACKAGE_UNAVAILABLE', 'WECHAT_MESSAGE_ZSTD_PACKAGE_VERSION_UNSUPPORTED',
  'WECHAT_MESSAGE_KEY_SCAN_BYTE_BUDGET_EXCEEDED', 'WECHAT_MESSAGE_KEY_SCAN_TIME_EXCEEDED']);

/** Selected-message collector only. Identity monitoring has a separate owner and
 * survives pause/failure. Construction/status never opens the source or receipts.
 */
export class WechatIntake {
  private job: Job | null = null;
  private closing: Promise<void> = Promise.resolve();
  private error: string | null = null;
  private historyRunning = false;
  private starting = false;
  private version = 0;
  constructor(private readonly options: Options) {}
  /** An already approved live session may follow a same-space epoch change. */
  wasCollecting(): boolean { return this.job?.phase === 'collecting'; }
  private same(a: WechatReadContext | null, b: WechatReadContext): boolean {
    return !!a && a.account === b.account && a.connectionId === b.connectionId && a.epoch === b.epoch;
  }
  private owns(job: Job): boolean {
    const selected = this.options.selected();
    return this.job === job && !job.abort.signal.aborted && dbGeneration() === job.generation
      && this.same(this.options.current(), job.context) && this.options.destination() === job.destination
      && !!selected && this.same(selected, job.context) && selected.dataRoot === job.scope.dataRoot
      && selected.groups.length === job.plans.length
      && job.plans.every((plan) => selected.groups.some((group) => group.group_id === plan.group_id));
  }
  private async proof(job: Job): Promise<WechatReadContext | null> {
    return this.owns(job) && await this.options.revalidate(job.context) && this.owns(job) ? job.context : null;
  }
  status(): WechatIntakeDTO {
    const job = this.job;
    if (job && !this.owns(job)) this.invalidate();
    const current = this.job;
    return { state: current?.phase ?? (this.error ? 'error' : 'idle'), error: this.error,
      collecting: current?.phase === 'collecting', intake_id: current?.id ?? null,
      last_received_at: current?.lastReceivedAt ?? null,
      scope: current ? { connection_id: current.context.connectionId, account_epoch: current.context.epoch } : null,
      groups: current ? Object.entries(current.counts).map(([group_id, counts]) => ({ group_id, ...counts })) : [] };
  }
  async start(expectedEpoch: string, approveKeyRead: boolean, approveMessageRead: boolean, approveSelectedStorage: boolean): Promise<void> {
    if (approveKeyRead !== true || approveMessageRead !== true || approveSelectedStorage !== true) throw new Error('WECHAT_MESSAGE_CONSENT_REQUIRED');
    if (this.job || this.starting) throw new Error('WECHAT_MESSAGE_ALREADY_STARTED');
    this.starting = true;
    const version = ++this.version;
    try { await this.open(expectedEpoch, version); }
    finally { this.starting = false; }
  }
  private async open(expectedEpoch: string, version: number): Promise<void> {
    const scope = this.options.selected(), context = this.options.current(), destination = this.options.destination();
    if (!scope?.dataRoot || !scope.groups.length || !destination || !context || context.epoch !== expectedEpoch
        || !this.same(scope, context)) throw new Error('WECHAT_MESSAGE_SELECTION_REQUIRED');
    await this.closing;
    if (this.job) throw new Error('WECHAT_MESSAGE_ALREADY_STARTED');
    if (!this.same(this.options.current(), context) || this.options.selected() !== scope
        || !await this.options.revalidate(context) || !this.same(this.options.current(), context)) throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
    if (this.version !== version || this.options.selected() !== scope || this.options.destination() !== destination) throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
    const store = new WechatSelectionStore(destination, context.account, () => this.options.current());
    const stored = store.list();
    const folder = this.receiptRoot();
    const plans = scope.groups.map((group) => {
      const row = stored.find((item) => item.group_id === group.group_id);
      if (!row?.enabled) throw new Error('WECHAT_MESSAGE_SELECTION_REQUIRED');
      const name = createHash('sha256').update(JSON.stringify([destination, context.account, group.group_id])).digest('hex');
      return { group_id: row.group_id, name: row.name ?? '', receipt_path: join(folder, name + '.wechat-receipts.sqlite3'),
        activation_id: row.activation_id, activation_pending: row.pending !== null, require_existing_progress: row.activated };
    });
    const runtime = this.options.runtime?.() ?? wechatIdentityRuntime(this.options.root);
    const receive = bindWechatDestination(destination, context.account, plans.map((plan) => plan.group_id));
    const job = { id: randomUUID(), context, scope, destination, generation: dbGeneration(), plans,
      abort: new AbortController(), counts: {}, phase: 'opening' } as Job;
    job.channel = (this.options.createChannel ?? ((settings) => new WechatMessageChannel(settings)))({ ...runtime,
      entry: join(dirname(runtime.entry), 'message_worker.py'), context, dataRoot: scope.dataRoot, destination, groups: plans,
      approveKeyRead: true, approveMessageRead: true, approveSelectedStorage: true, signal: job.abort.signal,
      proof: () => this.proof(job), activated: (group, activation) => {
        if (!this.owns(job)) throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
        store.activated(context, group, activation);
      }, receive: (batch) => {
        if (!this.owns(job)) throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
        const acknowledgement = receive(batch);
        if (acknowledgement.inserted > 0) job.lastReceivedAt = Date.now();
        return acknowledgement;
      } });
    this.job = job; this.error = null;
    try {
      job.counts = await job.channel.start();
      if (!this.owns(job)) throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
      job.phase = 'collecting'; this.schedule(job, 0);
    } catch (error) { this.failed(job, error); await this.closing; throw new Error(this.error ?? 'WECHAT_MESSAGE_NOT_CURRENT'); }
  }
  private receiptRoot(): string {
    let folder = this.options.receiptRoot?.();
    if (!folder) {
      const file = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main')?.file;
      if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('WECHAT_MESSAGE_STORAGE_UNAVAILABLE');
      folder = join(dirname(file), 'wechat-receipts');
    }
    if (!isAbsolute(folder) || folder.startsWith('\\\\') || (existsSync(folder) && (lstatSync(folder).isSymbolicLink() || !lstatSync(folder).isDirectory()))) {
      throw new Error('WECHAT_MESSAGE_STORAGE_UNAVAILABLE');
    }
    mkdirSync(folder, { recursive: true }); return folder;
  }
  private schedule(job: Job, delay = 3000): void {
    if (!this.owns(job)) { if (this.job === job) this.invalidate(); return; }
    job.timer = setTimeout(() => void this.tick(job), delay); job.timer.unref();
  }
  private async tick(job: Job): Promise<void> {
    if (!this.owns(job)) { if (this.job === job) this.invalidate(); return; }
    if (this.historyRunning) { this.schedule(job); return; }
    try { const result = await job.channel.tick(); if (this.owns(job)) job.counts = result.status; }
    catch (error) { this.failed(job, error); return; }
    this.schedule(job);
  }
  private failed(job: Job, error: unknown): void {
    if (this.job !== job) return;
    const code = error instanceof Error ? error.message : '';
    this.invalidate(); this.error = known.has(code) ? code : 'WECHAT_MESSAGE_FAILED';
  }
  invalidate(): void {
    ++this.version;
    const job = this.job; this.job = null; this.error = null; this.historyRunning = false;
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    job.abort.abort();
    const closing = job.channel.close();
    // A later start waits for every previous owned worker to release its receipt.
    this.closing = Promise.all([this.closing, closing]).then(() => undefined);
    void this.closing.catch(() => { this.error = 'WECHAT_MESSAGE_FAILED'; });
  }
  async stop(expectedEpoch?: string, intakeId?: string): Promise<void> {
    if (expectedEpoch !== undefined && (this.options.current()?.epoch !== expectedEpoch || this.job?.id !== intakeId)) throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
    this.invalidate(); await this.closing;
  }
  private active(expectedEpoch: string, intakeId: string): Job {
    const job = this.job;
    if (!job || job.phase !== 'collecting' || job.id !== intakeId || job.context.epoch !== expectedEpoch || !this.owns(job)) {
      throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
    }
    return job;
  }
  /** A failed group read closes the worker (receipts stay fail-closed). The
   * collector is then reopened from saved progress so batch refresh can skip
   * that group; if reopening fails the failure is global and is reported. */
  async history(expectedEpoch: string, intakeId: string, group: string, days: 1 | 7 | 30, approved: boolean, continueExisting = false)
    : Promise<{ inserted: number; has_more: boolean; skipped?: string; intake_id?: string }> {
    const job = this.active(expectedEpoch, intakeId);
    if (approved !== true || ![1, 7, 30].includes(days) || !job.plans.some((plan) => plan.group_id === group)
        || this.historyRunning || (continueExisting && (job.history?.group !== group || job.history.days !== days))) throw new Error('WECHAT_HISTORY_REQUEST_INVALID');
    this.historyRunning = true;
    let skipped: string;
    try {
      const page = continueExisting ? await job.channel.historyNext() : await job.channel.history(group, days, true);
      if (!this.owns(job)) throw new Error('WECHAT_MESSAGE_NOT_CURRENT');
      job.history = page.has_more ? { group, days } : undefined;
      return page;
    } catch (error) {
      // A stopped/replaced session has no authority to restart collection.
      // Its late failure must not overwrite the replacement session either.
      if (!this.owns(job)) {
        if (this.job === job) this.invalidate();
        throw new Error('WECHAT_HISTORY_FAILED');
      }
      this.failed(job, error); skipped = this.error ?? 'WECHAT_MESSAGE_FAILED';
    } finally { if (this.job === job) this.historyRunning = false; }
    if (skipped === 'WECHAT_MESSAGE_NOT_CURRENT') throw new Error('WECHAT_HISTORY_FAILED');
    try { await this.start(expectedEpoch, true, true, true); }
    catch { throw new Error('WECHAT_HISTORY_FAILED'); }
    return { inserted: 0, has_more: false, skipped, intake_id: this.job!.id };
  }
  async issues(expectedEpoch: string, intakeId: string, group: string) {
    const job = this.active(expectedEpoch, intakeId);
    try { return await job.channel.issues(group); }
    catch (error) { this.failed(job, error); throw new Error('WECHAT_MESSAGE_FAILED'); }
  }
  async retryIssues(expectedEpoch: string, intakeId: string, group: string, events: string[]) {
    const job = this.active(expectedEpoch, intakeId);
    try { job.counts = await job.channel.retryIssues(group, events); }
    catch (error) { this.failed(job, error); throw new Error('WECHAT_MESSAGE_FAILED'); }
  }
}
