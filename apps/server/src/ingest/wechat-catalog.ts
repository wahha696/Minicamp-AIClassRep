import { WechatGroupSelection, type WechatGroup, type WechatReadContext, type WechatSelectedScope } from './wechat-group-selection.js';
import { validWechatDataRoot, wechatCatalogFailureCode } from './wechat-catalog-channel.js';

export interface WechatCatalogOffer { catalog_id: string; groups: readonly WechatGroup[] }
interface Options {
  // Admitted source ownership + active space epoch, cleared on revocation.
  // Do not use a transient operation ticket here: status polling during a
  // routine sample should not itself abort a healthy catalog job.
  current(): WechatReadContext | null;
  revalidate(context: WechatReadContext): Promise<boolean>;
  // The caller supplies an owned connection/file scope. No HTTP account, PID or path.
  read(context: WechatReadContext, signal: AbortSignal, dataRoot?: string): Promise<WechatGroup[]>;
  remembered?(context: WechatReadContext): readonly string[];
  saveSelection?(scope: WechatSelectedScope, availableGroupIds: readonly string[]): void;
}
interface Job { context: WechatReadContext; cancellation: AbortController; done: Promise<void>; finish(): void }

/** Inactive until an explicit local refresh with both read consents.
 * A successful catalog/selection does not start message intake.
 */
export class WechatCatalog {
  private selection: WechatGroupSelection;
  private job: Job | null = null;
  private offer: { context: WechatReadContext; value: WechatCatalogOffer; dataRoot?: string } | null = null;
  private failure: string | null = null;
  private chosen: (WechatSelectedScope & { readonly dataRoot?: string }) | null = null;

  constructor(private readonly options: Options) { this.selection = new WechatGroupSelection(options.current); }

  private matches(expected: WechatReadContext): boolean {
    const now = this.options.current();
    return now !== null && now.account === expected.account && now.connectionId === expected.connectionId && now.epoch === expected.epoch;
  }

  private prune(): void {
    if ((this.job && !this.matches(this.job.context)) || (this.offer && !this.matches(this.offer.context))) this.invalidate();
  }

  status(): { state: 'idle' | 'reading' | 'stopping' | 'ready' | 'error'; error: string | null; collecting: false } {
    this.prune();
    return { state: this.job ? this.job.cancellation.signal.aborted ? 'stopping' : 'reading' : this.failure ? 'error' : this.offer ? 'ready' : 'idle',
      error: this.failure, collecting: false };
  }

  catalog(): WechatCatalogOffer | null {
    this.prune();
    return this.offer ? { catalog_id: this.offer.value.catalog_id,
      groups: this.offer.value.groups.map((row) => ({ ...row })) } : null;
  }

  /** Public correlation fields, never a read credential. */
  scope(): { connection_id: string; account_epoch: string } | null {
    this.prune();
    const current = this.options.current();
    return current ? { connection_id: current.connectionId, account_epoch: current.epoch } : null;
  }

  selectedGroupIds(): string[] {
    this.prune();
    return this.chosen && this.matches(this.chosen) ? this.chosen.groups.map((group) => group.group_id) : [];
  }

  /** Internal immutable selected file scope, not an HTTP read credential. */
  selectedScope(): (WechatSelectedScope & { readonly dataRoot?: string }) | null {
    this.prune();
    return this.chosen && this.matches(this.chosen) ? this.chosen : null;
  }

  async refresh(expectedEpoch: string, approvedKeyRead: boolean, approvedContactRead: boolean, dataRoot?: string): Promise<WechatCatalogOffer> {
    if (approvedKeyRead !== true || approvedContactRead !== true) throw new Error('WECHAT_CATALOG_CONSENT_REQUIRED');
    if (dataRoot !== undefined && !validWechatDataRoot(dataRoot)) throw new Error('WECHAT_CATALOG_METADATA_INVALID');
    this.prune();
    const context = this.options.current();
    if (!context || context.epoch !== expectedEpoch) throw new Error('WECHAT_CATALOG_NOT_CURRENT');
    if (this.job) throw new Error('WECHAT_CATALOG_BUSY');
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const job: Job = { context: { ...context }, cancellation: new AbortController(), done, finish };
    this.job = job;
    // Refreshing contacts does not withdraw an already approved message scope.
    // Keep the last good offer during same-root reads, including reader failure;
    // a root change must immediately revoke the old read scope.
    if (this.offer?.dataRoot !== dataRoot) {
      this.offer = null; this.selection.clear(); this.chosen = null;
    }
    this.failure = null;
    try {
      if (!await this.options.revalidate(job.context) || !this.owns(job)) throw new Error('WECHAT_CATALOG_NOT_CURRENT');
      const groups = await this.options.read(job.context, job.cancellation.signal, dataRoot);
      if (!this.owns(job) || !await this.options.revalidate(job.context) || !this.owns(job)) throw new Error('WECHAT_CATALOG_NOT_CURRENT');
      const remembered = new Set(this.options.remembered?.(job.context)
        ?? this.chosen?.groups.map(group => group.group_id) ?? []);
      // Validate the replacement separately: a malformed response must not
      // corrupt the still-valid selection behind the previous offer.
      const selection = new WechatGroupSelection(this.options.current);
      const value = selection.publish(job.context, groups);
      const restored = selection.select(value.catalog_id, expectedEpoch,
        value.groups.filter((group) => remembered.has(group.group_id)).map((group) => group.group_id));
      if (!this.chosen || this.chosen.dataRoot !== dataRoot || this.chosen.groups.length !== restored.groups.length
          || !restored.groups.every(group => this.chosen!.groups.some(old => old.group_id === group.group_id && old.name === group.name))) {
        this.chosen = Object.freeze({ ...restored, ...(dataRoot !== undefined ? { dataRoot } : {}) });
      }
      this.selection = selection;
      this.offer = { context: job.context, value, dataRoot };
      return { catalog_id: value.catalog_id, groups: value.groups.map((row) => ({ ...row })) };
    } catch (error) {
      if (this.job === job && !job.cancellation.signal.aborted) {
        const code = wechatCatalogFailureCode(error);
        if (!this.matches(job.context) || code === 'WECHAT_CATALOG_NOT_CURRENT') {
          this.offer = null; this.selection.clear(); this.chosen = null;
        }
        this.failure = code;
      }
      throw new Error(wechatCatalogFailureCode(error));
    } finally {
      if (this.job === job) this.job = null;
      job.finish();
    }
  }

  private owns(job: Job): boolean {
    return this.job === job && !job.cancellation.signal.aborted && this.matches(job.context);
  }

  async select(catalogId: string, expectedEpoch: string, groupIds: readonly string[]): Promise<WechatSelectedScope> {
    this.prune();
    if (this.job) throw new Error('WECHAT_CATALOG_BUSY');
    const offer = this.offer;
    if (!offer || offer.context.epoch !== expectedEpoch) throw new Error('WECHAT_CATALOG_NOT_CURRENT');
    if (!await this.options.revalidate(offer.context) || this.offer !== offer || !this.matches(offer.context)) {
      if (this.offer === offer) this.invalidate();
      throw new Error('WECHAT_CATALOG_NOT_CURRENT');
    }
    if (this.job) throw new Error('WECHAT_CATALOG_BUSY');
    const selected = this.selection.select(catalogId, expectedEpoch, groupIds);
    // Confirming an unchanged selection must not stop its live collector or
    // replace the immutable scope. Identity has still been revalidated above.
    if (this.chosen && this.chosen.groups.length === selected.groups.length
        && selected.groups.every(group => this.chosen!.groups.some(old => old.group_id === group.group_id))) {
      return this.chosen;
    }
    // Synchronous persistence under the already-rechecked identity/space. Only
    // publish a new in-memory choice after the desired-state transaction commits.
    this.options.saveSelection?.(selected, offer.value.groups.map((group) => group.group_id));
    this.chosen = Object.freeze({ ...selected, ...(offer.dataRoot !== undefined ? { dataRoot: offer.dataRoot } : {}) });
    return this.chosen;
  }

  /** Internal same-space platform membership change only. Caller also checks
   * the unchanged DB generation and workspace. A new offer rejects old pages;
   * activation tokens/progress are not changed and no contact read is repeated.
   */
  async rebase(context: WechatReadContext): Promise<boolean> {
    const offer = this.offer, chosen = this.chosen;
    if (!offer || !chosen || this.job || offer.context.account !== context.account
        || offer.context.connectionId !== context.connectionId || !this.matches(context)) return false;
    const value = this.selection.publish(context, offer.value.groups);
    const selected = this.selection.select(value.catalog_id, context.epoch, chosen.groups.map((group) => group.group_id));
    this.chosen = Object.freeze({ ...selected, ...(offer.dataRoot !== undefined ? { dataRoot: offer.dataRoot } : {}) });
    const rebased = { context, value, dataRoot: offer.dataRoot };
    this.offer = rebased; this.failure = null;
    // Publish the same already-owned catalog under the new epoch before the
    // await, so a status poll cannot prune it while identity is being checked.
    const valid = await this.options.revalidate(context);
    if (!valid || this.offer !== rebased || !this.matches(context)) {
      if (this.offer === rebased) this.invalidate();
      return false;
    }
    return true;
  }

  /** Call on disconnect/revocation/space switch. The private reader must await
   * worker close before settling. Late jobs may not mutate newer state.
   */
  invalidate(): void {
    const job = this.job;
    // Keep the cancelled job as busy until its reader has reaped the child.
    // Clearing it immediately would permit a second scan during old cleanup.
    this.offer = null; this.failure = null; this.selection.clear(); this.chosen = null;
    job?.cancellation.abort();
  }

  /** Shutdown/disconnect must wait for the owned reader's cleanup. */
  async stop(): Promise<void> {
    const job = this.job;
    this.invalidate();
    if (job) await job.done;
  }
}
