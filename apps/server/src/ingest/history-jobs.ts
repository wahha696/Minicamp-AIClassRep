import { createHash, randomUUID } from 'node:crypto';
import { accountDataState, accountEpoch, currentAccount } from '../accounts.js';
import { db, dbGeneration, onAccountSwitch } from '../db/index.js';
import { isOnline } from '../napcat/onebot.js';
import { ingestMessages } from './index.js';
import { readQQHistoryEssence, readQQHistoryPage, setHistorySyncCoordinator, waitForAutomaticHistorySync, type SyncResult } from './history.js';
import type { WechatIntake } from './wechat-intake.js';
import type { CreateHistoryJobRequest, HistoryGroupProgress, HistoryJobDTO, HistoryPlatform } from '../../../../shared/history-jobs.js';

interface Group extends HistoryGroupProgress {
  cursor: number | null;
  oldest_at: number | null;
  phase: 'history' | 'essence' | 'done';
  seen_cursors?: number[];
}
interface Saved extends Omit<HistoryJobDTO, 'groups'> {
  version: 1;
  owner: string;
  since: number;
  /** A reconnect must read the new head after finishing saved backward cursors. */
  catchup_since?: number;
  groups: Group[];
}
interface Run {
  saved: Saved; generation: number; epoch: string; intakeId?: string; phase: 'queued' | 'reading'; abort: AbortController;
  done: Promise<void>; finish(): void; automatic?: boolean;
}
type Intake = Pick<WechatIntake, 'historyContext' | 'history'>;
const platforms = ['qq', 'wechat'] as const;
const key = (platform: HistoryPlatform) => `history_job_v1:${platform}`;
const active = (job: HistoryJobDTO) => job.status === 'running' || job.status === 'cancelling';
const cancelling = (job: HistoryJobDTO) => job.status === 'cancelling';
const qqRequests = new Set<AbortController>();
// A space switch must release indefinite requests even with no browser polling.
onAccountSwitch(() => { for (const controller of qqRequests) controller.abort(); });
const failures = new Set(['HISTORY_SCOPE_CHANGED', 'HISTORY_PAGE_UNAVAILABLE', 'HISTORY_INVALID_PAGE',
  'HISTORY_CURSOR_STALLED', 'HISTORY_STORAGE_FAILED', 'HISTORY_WECHAT_UNAVAILABLE']);

/** One task per platform and destination database. No HTTP connection owns the
 * work; a closed browser cannot cancel it. Stored checkpoints contain no text. */
export class HistoryJobs {
  private generation = -1;
  private epoch = '';
  private saved = new Map<HistoryPlatform, Saved>();
  private running = new Map<HistoryPlatform, Run>();
  constructor(private readonly intake: Intake) {}
  /** Automatic login backfills and legacy /api/sync share this exact task owner. */
  coordinateQQ(): void {
    setHistorySyncCoordinator({ start: (days) => this.create({ platform: 'qq', days, expected_account_epoch: accountEpoch() }),
      sync: (days) => this.synchronizeQQ(days), cancel: () => {
      const run = this.running.get('qq');
      if (!run) return;
      if (this.contextCurrent(run)) this.cancel(run.saved.id, run.epoch);
      else run.abort.abort();
    } });
  }
  private async synchronizeQQ(days: number): Promise<SyncResult> {
    if (!Number.isFinite(days) || days <= 0 || days > 30) throw new Error('HISTORY_DAYS_INVALID');
    const epoch = accountEpoch();
    let job: HistoryJobDTO;
    try {
      this.current(epoch);
      const previous = this.saved.get('qq');
      const existingRun = this.running.get('qq');
      if (previous && previous.owner === this.owner('qq') && (active(previous) || ['interrupted', 'failed'].includes(previous.status))) {
        // A manual task may cover only a subset. Automatic login recovery owns
        // the current enabled set, including groups enabled since the old run.
        for (const groupId of this.validate('qq').groups) {
          if (!previous.groups.some((group) => group.group_id === groupId)) previous.groups.push({
            group_id: groupId, status: 'pending', pages: 0, messages: 0, error: null,
            cursor: null, oldest_at: null, phase: 'history', seen_cursors: [],
          });
        }
        previous.groups_total = previous.groups.length;
        this.persist(previous);
      }
      if (previous && previous.owner === this.owner('qq')
          && (['interrupted', 'failed'].includes(previous.status) || (active(previous) && !existingRun?.automatic))) {
        // Keep the old checkpoint intact. Once it completes, revisit every group
        // from its newest page so messages received while offline cannot be lost.
        previous.catchup_since = Math.min(previous.catchup_since ?? Infinity, previous.created_at - 60_000, Date.now() - days * 86400000);
        this.persist(previous);
      }
      job = previous && previous.owner === this.owner('qq') && ['interrupted', 'failed'].includes(previous.status)
        ? this.retry(previous.id, epoch)
        : this.create({ platform: 'qq', days: days <= 1 ? 1 : days <= 7 ? 7 : 30, expected_account_epoch: epoch }, days);
    } catch (error) {
      if (error instanceof Error && error.message === 'HISTORY_NO_GROUPS') return { groups: 0, messages: 0, failures: 0 };
      throw error;
    }
    const run = this.running.get('qq');
    if (!run || run.saved.id !== job.id) throw new Error('HISTORY_SCOPE_CHANGED');
    run.automatic = true;
    await run.done;
    if (accountDataState() !== 'ready' || dbGeneration() !== run.generation || accountEpoch() !== epoch) throw new Error('HISTORY_SCOPE_CHANGED');
    if (run.saved.status === 'cancelled' || run.saved.status === 'interrupted') throw new Error('HISTORY_CANCELLED');
    return { groups: run.saved.groups_completed, messages: run.saved.messages,
      failures: run.saved.groups.filter((group) => group.status !== 'completed').length };
  }

  private owner(platform: HistoryPlatform): string | null {
    const account = platform === 'qq' ? currentAccount() : this.intake.historyContext()?.account;
    return account ? createHash('sha256').update(`${platform}:${account}`).digest('hex') : null;
  }
  private load(): void {
    if (accountDataState() !== 'ready') throw new Error('HISTORY_SCOPE_CHANGED');
    const generation = dbGeneration(), epoch = accountEpoch();
    if (this.generation === generation && this.epoch === epoch) return;
    for (const run of this.running.values()) run.abort.abort();
    this.generation = generation; this.epoch = epoch; this.saved.clear(); this.running.clear();
    for (const platform of platforms) {
      const value = db.prepare('SELECT value FROM kv WHERE key=?').get(key(platform))?.value;
      if (typeof value !== 'string') continue;
      let job: Saved;
      try { job = JSON.parse(value) as Saved; } catch { continue; }
      if (job.version !== 1 || job.platform !== platform || !Array.isArray(job.groups)) continue;
      if (active(job)) {
        job.status = 'interrupted'; job.error = 'HISTORY_INTERRUPTED'; job.retryable = true;
        job.current_group_id = null; job.updated_at = Date.now();
        this.persist(job);
      }
      this.saved.set(platform, job);
    }
  }
  private persist(job: Saved): void {
    if (!active(job)) job.waiting_since = null;
    this.refreshWechatCounts(job);
    job.updated_at = Date.now();
    db.prepare('INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key(job.platform), JSON.stringify(job));
  }
  private dto(job: Saved): HistoryJobDTO {
    this.refreshWechatCounts(job);
    const { version: _v, owner: _o, since: _s, catchup_since: _cs, groups, ...dto } = job;
    return { ...dto, groups: groups.map(({ cursor: _c, phase: _p, oldest_at: _a, seen_cursors: _sc, ...group }) => ({ ...group })) };
  }
  list(): HistoryJobDTO[] {
    this.load();
    for (const job of this.saved.values()) {
      const run = this.running.get(job.platform);
      if (active(job) && (!run || !this.contextCurrent(run))) {
        job.status = 'interrupted'; job.error = 'HISTORY_SCOPE_CHANGED'; job.retryable = true;
        job.current_group_id = null; this.running.delete(job.platform); this.persist(job);
      }
    }
    return [...this.saved.values()].filter((job) => {
      const owner = this.owner(job.platform);
      // Completed progress stays visible while a platform is disconnected.
      return owner === null || owner === job.owner;
    }).map((job) => this.dto(job));
  }
  get(id: string): HistoryJobDTO | null { return this.list().find((job) => job.id === id) ?? null; }
  private current(expected: string): void {
    this.load();
    if (expected !== accountEpoch()) throw new Error('HISTORY_SCOPE_CHANGED');
  }
  private validate(platform: HistoryPlatform, groupIds?: string[], intakeId?: string): { owner: string; groups: string[]; intakeId?: string } {
    const owner = this.owner(platform);
    if (!owner) throw new Error(platform === 'qq' ? 'HISTORY_QQ_OFFLINE' : 'HISTORY_WECHAT_UNAVAILABLE');
    let groups: string[], currentIntake: string | undefined;
    if (platform === 'qq') {
      if (!isOnline()) throw new Error('HISTORY_QQ_OFFLINE');
      groups = db.prepare("SELECT group_id FROM groups WHERE enabled=1 AND adapter='onebot'").all()
        .map((row) => String(row.group_id)).filter((id) => /^\d+$/.test(id));
    } else {
      const scope = this.intake.historyContext();
      if (!scope || scope.epoch !== accountEpoch() || (intakeId && intakeId !== scope.intakeId)) throw new Error('HISTORY_WECHAT_UNAVAILABLE');
      groups = scope.groups; currentIntake = scope.intakeId;
    }
    if (groupIds) {
      if (new Set(groupIds).size !== groupIds.length || groupIds.some((id) => !groups.includes(id))) throw new Error('HISTORY_SCOPE_CHANGED');
      groups = groupIds;
    }
    if (!groups.length) throw new Error('HISTORY_NO_GROUPS');
    return { owner, groups, intakeId: currentIntake };
  }
  create(request: CreateHistoryJobRequest, exactDays = request.days as number): HistoryJobDTO {
    this.current(request.expected_account_epoch);
    if (request.platform === 'wechat' && request.approve_history_read !== true) throw new Error('HISTORY_CONSENT_REQUIRED');
    const scope = this.validate(request.platform, request.group_ids, request.intake_id);
    const existing = this.saved.get(request.platform);
    if (existing && active(existing) && existing.owner === scope.owner) return this.dto(existing);
    const now = Date.now();
    const job: Saved = { version: 1, id: randomUUID(), owner: scope.owner, platform: request.platform, days: request.days,
      since: now - exactDays * 86400000, status: 'running', created_at: now, updated_at: now,
      groups_total: scope.groups.length, groups_completed: 0, pages: 0, messages: 0,
      current_group_id: null, waiting_since: null, error: null, retryable: false,
      groups: scope.groups.map((group_id) => ({ group_id, status: 'pending', pages: 0, messages: 0,
        error: null, cursor: null, oldest_at: null, phase: 'history', seen_cursors: [] })) };
    this.persist(job); this.saved.set(job.platform, job); this.launch(job, scope.intakeId);
    return this.dto(job);
  }
  cancel(id: string, expected: string): HistoryJobDTO {
    this.current(expected);
    const job = [...this.saved.values()].find((row) => row.id === id);
    if (!job || (this.owner(job.platform) !== null && job.owner !== this.owner(job.platform))) throw new Error('HISTORY_NOT_FOUND');
    if (active(job)) {
      const run = this.running.get(job.platform);
      if (run?.phase === 'queued') {
        job.status = 'cancelled'; job.retryable = true; this.running.delete(job.platform);
        qqRequests.delete(run.abort);
        run.finish();
      } else job.status = 'cancelling';
      // A QQ request is read-only; abandon an unreturned page and preserve the
      // last committed checkpoint. Late echoes are removed by callAction.
      if (job.platform === 'qq') run?.abort.abort();
      this.persist(job);
    }
    return this.dto(job);
  }
  retry(id: string, expected: string, intakeId?: string): HistoryJobDTO {
    this.current(expected);
    const job = [...this.saved.values()].find((row) => row.id === id);
    if (!job) throw new Error('HISTORY_NOT_FOUND');
    const scope = this.validate(job.platform, job.groups.map((group) => group.group_id), intakeId);
    if (scope.owner !== job.owner) throw new Error('HISTORY_SCOPE_CHANGED');
    if (active(job) || job.status === 'completed') return this.dto(job);
    for (const group of job.groups) if (group.status !== 'completed') { group.status = 'pending'; group.error = null; }
    job.status = 'running'; job.error = null; job.retryable = false; job.waiting_since = null;
    this.persist(job); this.launch(job, scope.intakeId); return this.dto(job);
  }
  private launch(saved: Saved, intakeId?: string): void {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const run: Run = { saved, intakeId, generation: dbGeneration(), epoch: accountEpoch(), phase: 'queued', abort: new AbortController(), done, finish };
    this.running.set(saved.platform, run);
    if (saved.platform === 'qq') qqRequests.add(run.abort);
    setImmediate(() => void this.run(run));
  }
  private owns(run: Run): boolean {
    return this.contextCurrent(run) && this.owner(run.saved.platform) === run.saved.owner;
  }
  private contextCurrent(run: Run): boolean {
    return accountDataState() === 'ready' && dbGeneration() === run.generation && accountEpoch() === run.epoch
      && this.running.get(run.saved.platform) === run;
  }
  private refreshWechatCounts(job: Saved): void {
    if (job.platform !== 'wechat') return;
    const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key(job.platform));
    if (typeof row?.value !== 'string') return;
    const stored = JSON.parse(row.value) as Saved;
    if (stored.id !== job.id) return;
    job.messages = stored.messages;
    for (const group of job.groups) group.messages = stored.groups.find((item) => item.group_id === group.group_id)?.messages ?? group.messages;
  }
  private assert(run: Run): void { if (!this.owns(run)) throw new Error('HISTORY_SCOPE_CHANGED'); }
  private checkpoint(run: Run, group: Group, inserted: number, page: boolean): void {
    this.assert(run);
    group.messages += inserted; run.saved.messages += inserted;
    if (page) { group.pages++; run.saved.pages++; }
    run.saved.waiting_since = null;
    this.persist(run.saved);
  }
  private async qq(run: Run, group: Group): Promise<void> {
    const job = run.saved;
    const onLongWait = () => {
      if (!this.owns(run) || run.abort.signal.aborted) return;
      job.waiting_since = Date.now(); this.persist(job);
    };
    while (group.phase === 'history' && job.status !== 'cancelling') {
      this.assert(run);
      const page = await readQQHistoryPage(group.group_id, job.since, group.cursor, () => this.owns(run), run.abort.signal, onLongWait);
      this.assert(run);
      if (!page.complete && page.next !== null && group.seen_cursors?.includes(page.next)) throw new Error('HISTORY_CURSOR_STALLED');
      // Ingestion and next cursor are indivisible: crashes can only replay a page.
      const before = structuredClone(group), messagesBefore = job.messages, pagesBefore = job.pages;
      db.exec('BEGIN');
      try {
        const { inserted } = ingestMessages(page.messages, 'history');
        group.cursor = page.next;
        if (page.next !== null) (group.seen_cursors ??= []).push(page.next);
        if (page.oldestAt !== null) group.oldest_at = Math.min(group.oldest_at ?? Infinity, page.oldestAt);
        if (page.complete) group.phase = 'essence';
        this.checkpoint(run, group, inserted, true); db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        Object.assign(group, before); job.messages = messagesBefore; job.pages = pagesBefore;
        throw error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (group.phase === 'essence' && job.status !== 'cancelling') {
      const messages = await readQQHistoryEssence(group.group_id, job.since, () => this.owns(run), run.abort.signal, onLongWait);
      this.assert(run);
      db.exec('BEGIN');
      const before = structuredClone(group), messagesBefore = job.messages;
      try {
        const { inserted } = ingestMessages(messages, 'history');
        group.phase = 'done'; this.checkpoint(run, group, inserted, false); db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        Object.assign(group, before); job.messages = messagesBefore; throw error;
      }
    }
  }
  private async wechat(run: Run, group: Group): Promise<void> {
    let more = false;
    // On restart/retry, the existing receipt database dedupes the repeated prefix;
    // only the current worker can own its opaque source cursor.
    do {
      if (run.saved.status === 'cancelling') return;
      this.assert(run);
      const result = await this.intake.history(run.epoch, run.intakeId!, group.group_id, run.saved.days, true, more,
        run.saved.created_at / 1000, run.saved.id);
      this.assert(run);
      if (result.intake_id) run.intakeId = result.intake_id;
      if (result.skipped) throw new Error('HISTORY_WECHAT_UNAVAILABLE');
      more = result.has_more;
      if (!more) group.phase = 'done';
      // Delivery has already counted newly committed business messages atomically.
      this.checkpoint(run, group, 0, true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (more);
  }
  private async run(run: Run): Promise<void> {
    const job = run.saved;
    try {
      if (job.platform === 'qq') await waitForAutomaticHistorySync();
      this.assert(run); run.phase = 'reading';
      do {
      for (const group of job.groups) {
        this.assert(run);
        if (job.status === 'cancelling') break;
        if (group.status === 'completed') continue;
        group.status = 'running'; job.current_group_id = group.group_id; job.waiting_since = null; this.persist(job);
        try {
          if (job.platform === 'qq') await this.qq(run, group); else await this.wechat(run, group);
          this.assert(run);
          if (group.phase === 'done') { group.status = 'completed'; job.groups_completed++; }
        } catch (error) {
          this.assert(run);
          const code = error instanceof Error ? error.message : '';
          if (!cancelling(job)) {
            group.status = 'failed'; group.error = failures.has(code) ? code
              : job.platform === 'wechat' ? 'HISTORY_WECHAT_UNAVAILABLE' : 'HISTORY_STORAGE_FAILED';
          }
        }
        if (job.platform === 'qq') {
          db.prepare(`INSERT INTO group_sync(group_id,last_sync_at,oldest_at,complete,reason) VALUES (?,?,?,?,?)
            ON CONFLICT(group_id) DO UPDATE SET last_sync_at=excluded.last_sync_at,
            oldest_at=excluded.oldest_at,complete=excluded.complete,reason=excluded.reason`)
            .run(group.group_id, Date.now(), group.oldest_at, group.status === 'completed' ? 1 : 0,
              group.status === 'completed' ? 'ok' : group.error ?? 'cancelled');
        }
        this.persist(job);
      }
      if (job.platform !== 'qq' || job.catchup_since === undefined || cancelling(job)
          || job.groups.some((group) => group.status !== 'completed')) break;
      // Persist the phase transition before sending another page. Counts remain
      // cumulative and message IDs dedupe the overlap with the old/live reads.
      job.since = job.catchup_since; delete job.catchup_since;
      job.groups_completed = 0; job.current_group_id = null;
      for (const group of job.groups) {
        group.status = 'pending'; group.phase = 'history'; group.cursor = null;
        group.oldest_at = null; group.seen_cursors = []; group.error = null;
      }
      this.persist(job);
      } while (true);
      this.assert(run);
      job.status = job.status === 'cancelling' ? 'cancelled' : job.groups.some((g) => g.status === 'failed') ? 'failed' : 'completed';
      job.error = job.groups.find((g) => g.error)?.error ?? null;
      job.retryable = job.status !== 'completed'; job.current_group_id = null; this.persist(job);
    } catch (error) {
      // A switched destination must never receive a late task's status write.
      if (this.contextCurrent(run)) {
        const code = error instanceof Error ? error.message : '';
        job.status = 'failed'; job.error = failures.has(code) ? code
          : job.platform === 'wechat' ? 'HISTORY_WECHAT_UNAVAILABLE' : 'HISTORY_STORAGE_FAILED';
        job.retryable = true; job.current_group_id = null;
        try { this.persist(job); } catch { /* The in-memory result still reports the storage failure. */ }
      }
    } finally {
      run.finish();
      qqRequests.delete(run.abort);
      if (this.running.get(job.platform) === run) this.running.delete(job.platform);
    }
  }
}
