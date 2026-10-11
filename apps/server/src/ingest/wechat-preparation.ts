import { dirname, join } from 'node:path';
import type { WorkspaceController } from '../workspaces/controller.js';
import { WechatConnection } from './wechat-connection.js';
import { WechatCatalog } from './wechat-catalog.js';
import { readWechatCatalog } from './wechat-catalog-channel.js';
import type { WechatReadContext, WechatGroup } from './wechat-group-selection.js';
import { wechatIdentityRuntime } from './wechat-python.js';
import { WechatSelectionStore } from './wechat-selection-store.js';
import { WechatIntake } from './wechat-intake.js';
import { dbGeneration } from '../db/index.js';
import { wechatGroupId } from './wechat.js';

interface Options {
  root: string;
  epoch(): string;
  workspace(): WorkspaceController | undefined;
  stopWechatIntake(): void;
  settled?(): Promise<void>;
  createSession?: ConstructorParameters<typeof WechatConnection>[0]['createSession'];
  readCatalog?: (context: WechatReadContext, signal: AbortSignal, dataRoot: string) => Promise<WechatGroup[]>;
  selectionStore?: (context: WechatReadContext) => Pick<WechatSelectionStore, 'list' | 'apply'>;
}

/** Inert composition behind explicit local connection and catalog operations.
 * Login discovery and a bound active space are separate requirements. A
 * remembered binding alone cannot authorize contact/message access.
 */
export class WechatPreparation {
  readonly connection: WechatConnection;
  readonly catalog: WechatCatalog;
  readonly intake: WechatIntake;
  private catalogGeneration = -1;
  private catalogDestination: string | null = null;
  private rebasing = 0;
  private groupChanges: Promise<void> = Promise.resolve();

  constructor(private readonly options: Options) {
    this.connection = new WechatConnection({ ...options, stopWechatIntake: () => {
      this.catalog.invalidate();
      this.intake.invalidate();
      options.stopWechatIntake();
    } });
    this.catalog = new WechatCatalog({ current: () => this.context(),
      revalidate: (context) => this.revalidate(context),
      remembered: (context) => this.store(context).list().filter((group) => group.enabled).map((group) => group.group_id),
      saveSelection: (scope, available) => {
        this.store(scope).apply(scope, available);
        // A running collector owns an immutable group scope. A saved change
        // cannot leave that collector accepting messages from cancelled groups.
        this.intake.invalidate(); options.stopWechatIntake();
      },
      read: (context, signal, dataRoot) => {
        if (dataRoot === undefined) throw new Error('WECHAT_CATALOG_METADATA_INVALID');
        this.catalogGeneration = dbGeneration();
        this.catalogDestination = options.workspace()?.currentSpaceId() ?? null;
        if (options.readCatalog) return options.readCatalog(context, signal, dataRoot);
        const runtime = wechatIdentityRuntime(options.root);
        return readWechatCatalog({ ...runtime, entry: join(dirname(runtime.entry), 'catalog_worker.py'),
          dataRoot, context, signal, approveKeyRead: true, approveContactRead: true,
          onNickname: nickname => this.connection.setNickname(context.account, context.connectionId, nickname),
          proof: async () => await this.revalidate(context) ? this.context() : null });
      } });
    this.intake = new WechatIntake({ root: options.root,
      current: () => this.context(), selected: () => this.catalog.selectedScope(),
      destination: () => options.workspace()?.currentSpaceId() ?? null,
      revalidate: (context) => this.revalidate(context) });
  }

  private store(context: WechatReadContext): Pick<WechatSelectionStore, 'list' | 'apply'> {
    if (!this.matches(context)) throw new Error('WECHAT_SELECTION_NOT_CURRENT');
    if (this.options.selectionStore) return this.options.selectionStore(context);
    const destination = this.options.workspace()?.currentSpaceId();
    if (!destination) throw new Error('WECHAT_SELECTION_NOT_CURRENT');
    return new WechatSelectionStore(destination, context.account, () => this.context());
  }

  private context(): WechatReadContext | null {
    const source = this.connection.source();
    const workspace = this.options.workspace();
    // Pending new accounts and cross-space choices cannot read group catalogs.
    if (!source || !workspace?.currentSpaceId() || workspace.currentWechat() !== source.account) return null;
    return { ...source, epoch: this.options.epoch() };
  }

  private matches(context: WechatReadContext): boolean {
    const now = this.context();
    return now !== null && now.account === context.account && now.connectionId === context.connectionId && now.epoch === context.epoch;
  }

  private async revalidate(context: WechatReadContext): Promise<boolean> {
    return this.matches(context) && await this.connection.revalidate(context.account) && this.matches(context);
  }

  /** Space transition stops intake/catalog without freezing identity monitoring. */
  invalidate(): void {
    ++this.rebasing;
    this.catalog.invalidate();
    this.intake.invalidate();
    this.options.stopWechatIntake();
  }

  /** QQ joining/leaving this same business space changes its epoch. Preserve a
   * live WeChat session's approved scope, with fresh identity and owned-worker
   * restart, rather than silently disabling the other platform's collector.
   */
  workspaceChanged(): void {
    const ticket = ++this.rebasing, context = this.context();
    const resume = this.intake.wasCollecting();
    this.intake.invalidate();
    if (!context || this.catalogGeneration !== dbGeneration()
        || this.catalogDestination !== this.options.workspace()?.currentSpaceId()) {
      this.catalog.invalidate(); return;
    }
    void (async () => {
      await this.options.settled?.();
      if (ticket !== this.rebasing || !this.matches(context)) return;
      if (!await this.catalog.rebase(context) || ticket !== this.rebasing) return;
      if (resume && this.matches(context)) await this.intake.start(context.epoch, true, true, true);
    })().catch(() => { /* New session status reports failures; never log identifiers. */ });
  }

  async setGroupEnabled(businessId: string, enabled: boolean): Promise<void> {
    const context = this.context(), offer = this.catalog.catalog();
    if (!context || !offer) throw new Error('WECHAT_GROUP_SELECTION_REQUIRED');
    const generation = dbGeneration();
    // Batch actions send several requests concurrently. Build each incremental
    // selection only after the previous save, rather than from a stale full set.
    const work = this.groupChanges.then(async () => {
      if (!this.matches(context) || dbGeneration() !== generation || this.catalog.catalog()?.catalog_id !== offer.catalog_id) {
        throw new Error('WECHAT_GROUP_SELECTION_REQUIRED');
      }
      const row = this.store(context).list().find((group) => wechatGroupId(context.account, group.group_id) === businessId);
      if (!row || !offer.groups.some((group) => group.group_id === row.group_id)) throw new Error('WECHAT_GROUP_SELECTION_REQUIRED');
      const selected = new Set(this.catalog.selectedGroupIds());
      if (enabled) selected.add(row.group_id); else selected.delete(row.group_id);
      await this.catalog.select(offer.catalog_id, context.epoch, [...selected]);
    });
    this.groupChanges = work.catch(() => {});
    return work;
  }

  collectingGroupIds(): string[] {
    const context = this.context(), status = this.intake.status();
    if (!context || !status.collecting || status.scope?.connection_id !== context.connectionId
        || status.scope.account_epoch !== context.epoch) return [];
    return status.groups.map((group) => wechatGroupId(context.account, group.group_id));
  }

  async stop(): Promise<void> {
    // Abort before closing identity, so no pending reader can acquire new proof.
    const catalogClosed = this.catalog.stop();
    const intakeClosed = this.intake.stop();
    try { await this.connection.stop(); }
    finally { await Promise.all([catalogClosed, intakeClosed]); }
  }
}
