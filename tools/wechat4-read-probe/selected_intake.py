"""Explicit selected-message capture -> durable receipt -> business delivery.

No CLI, discovery, automatic loops, HTTP, AI or source database persistence.
Caller supplies an identity-bound capture, selected immutable scope and local
receipt path. Changing selected groups is not implemented by resetting progress.
"""
import threading

from canary import baseline_reader
from delivery import deliver_once
from history import history_page, validate_history_request
from reader import Cursor, ReadError, Reader, Scope
from receipts import LocalReceipts


SINK_FAILURE_REASONS = frozenset((
    'IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT', 'IDENTITY_CAPTURE_SESSION_NOT_OPEN',
    'JOINT_ACCOUNT_CHANGED', 'JOINT_WINDOW_STATE_CHANGED', 'JOINT_PROCESS_OR_MODULE_CHANGED',
    'JOINT_IDENTITY_TIME_EXCEEDED', 'JOINT_IDENTITY_BYTE_LIMIT',
    'LOCAL_RECEIPT_CURSORS_INVALID', 'LOCAL_RECEIPT_BATCH_INVALID',
    'LOCAL_RECEIPT_MESSAGE_INVALID', 'LOCAL_RECEIPT_INTEGER_INVALID',
    'LOCAL_RECEIPT_CONTENT_TYPE_UNSUPPORTED', 'LOCAL_RECEIPT_COMPRESSED_TYPE_UNSUPPORTED',
    'LOCAL_RECEIPT_EVENT_ID_INVALID', 'LOCAL_RECEIPT_CURSOR_REGRESSION',
    'LOCAL_RECEIPT_CURSOR_MESSAGE_MISMATCH', 'LOCAL_RECEIPT_BINDING_MISMATCH',
    'LOCAL_RECEIPT_STATE_INVALID', 'LOCAL_RECEIPT_NOT_INITIALIZED',
    'LOCAL_RECEIPT_STALE_READER', 'LOCAL_RECEIPT_EVENT_CONFLICT',
    'LOCAL_RECEIPT_REPLAY_INCOMPLETE', 'LOCAL_RECEIPT_CLOSED',
    'LOCAL_RECEIPT_TRANSACTION_ALREADY_RUNNING', 'LOCAL_RECEIPT_WRITE_FAILED',
    'LOCAL_RECEIPT_ROLLBACK_FAILED',
))


class IntakeSinkError(ReadError):
    """Sanitized local diagnostics; preserves Reader's no-ack contract."""
    def __init__(self, phase, error):
        super().__init__('BATCH_NOT_ACKNOWLEDGED')
        self.sink_phase = phase if phase in ('identity_recheck', 'receipt_commit') else 'unknown'
        self.sink_reason = (str(error) if type(error) is ReadError and str(error) in SINK_FAILURE_REASONS
                            else 'SELECTED_INTAKE_SINK_FAILED')


class SelectedMessageIntake:
    def __init__(self, *, scope, capture, receipt_path, destination,
                 approve_selected_storage=False, user_reenabled=False, require_existing_progress=False,
                 activation_id=None, activation_pending=False, store_factory=LocalReceipts):
        if approve_selected_storage is not True:
            raise ReadError('SELECTED_MESSAGE_STORAGE_APPROVAL_REQUIRED')
        if (type(scope) is not Scope or capture.scope != scope
                or not callable(getattr(capture, 'revalidate', None)) or type(user_reenabled) is not bool
                or type(require_existing_progress) is not bool
                or (require_existing_progress and user_reenabled)
                or type(activation_pending) is not bool
                or (activation_id is None and activation_pending)
                or (activation_id is not None and user_reenabled)):
            raise ReadError('SELECTED_INTAKE_SCOPE_INVALID')
        if activation_id is not None: LocalReceipts._activation(activation_id)
        LocalReceipts._destination(destination)
        self.scope, self.destination = scope, destination
        self._capture, self._path, self._factory = capture, receipt_path, store_factory
        self._reenabled = user_reenabled
        self._require_existing = require_existing_progress
        self._activation, self._activation_pending = activation_id, activation_pending
        self._store, self._reader, self._state = None, None, 'new'
        self._lock = threading.Lock()

    def __enter__(self):
        with self._lock:
            if self._state != 'new':
                raise ReadError('SELECTED_INTAKE_NOT_NEW')
            self._state = 'opening'
            try:
                self._capture.__enter__()
                shards = self._capture.capture()
                # Validate all account/shard identities without querying bodies.
                manifest = {shard.shard_id: shard.generation for shard in shards}
                if not shards or len(manifest) != len(shards):
                    raise ReadError('SHARD_MANIFEST_MISMATCH')
                for shard in shards:
                    self.scope.check_account(shard.account)
                Reader(self.scope, manifest, {(s, g): Cursor(0, 0)
                    for s in manifest for g in self.scope.groups})
                self._capture.revalidate()
                self._store = self._factory(self._path, self.scope, manifest,
                    allow_selected_message_storage=True)
                if self._store.initialized():
                    saved_activation = self._store.activation_id() if self._activation is not None else None
                    if self._activation is not None and saved_activation is None:
                        raise ReadError('LOCAL_RECEIPT_ACTIVATION_MISMATCH')
                    if self._activation is not None and saved_activation != self._activation and not self._activation_pending:
                        raise ReadError('LOCAL_RECEIPT_ACTIVATION_MISMATCH')
                    if self._reenabled or (self._activation_pending and saved_activation != self._activation):
                        baseline = baseline_reader(self.scope, shards, allow_missing_groups=True)
                        self._capture.revalidate()
                        self._store.reactivate(baseline.cursors, approve_skip_disabled_gap=True, activation_id=self._activation)
                    self._reader = self._store.restore_reader(allow_missing_groups=True)
                else:
                    if self._require_existing or (self._activation is not None and not self._activation_pending):
                        raise ReadError('LOCAL_RECEIPT_NOT_INITIALIZED')
                    # A catalog group can have no local table until its first message.
                    baseline = baseline_reader(self.scope, shards, allow_missing_groups=True)
                    self._capture.revalidate()
                    self._store.initialize(baseline.cursors, activation_id=self._activation)
                    self._reader = self._store.restore_reader(allow_missing_groups=True)
                del shards
                self._state = 'open'
                return self
            except BaseException:
                self._close()
                raise

    def _require_open(self):
        if self._state != 'open':
            raise ReadError('SELECTED_INTAKE_NOT_OPEN')

    def poll(self, *, limit=100, observe_saved=None):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ReadError('BATCH_LIMIT')
        if observe_saved is not None and not callable(observe_saved):
            raise ReadError('SELECTED_INTAKE_OBSERVER_INVALID')
        if not self._lock.acquire(blocking=False):
            raise ReadError('READ_ALREADY_RUNNING')
        try:
            self._require_open()
            try:
                shards = self._capture.capture()
                persist = self._store.sink(self._reader)
                sink_failure = None
                def sink(events, cursors):
                    nonlocal sink_failure
                    stage = 'identity_recheck'
                    try:
                        self._capture.revalidate()
                        stage = 'receipt_commit'
                        return persist(events, cursors)
                    except Exception as error:
                        sink_failure = IntakeSinkError(stage, error)
                        raise sink_failure from None
                try:
                    batch = self._reader.deliver(shards, sink, limit=limit)
                except ReadError:
                    if sink_failure is not None:
                        raise sink_failure from None
                    raise
                del shards
                if observe_saved is not None:
                    observe_saved(batch)  # Only committed selected rows; never an acknowledgement.
                return {'saved': len(batch), 'may_have_more': len(batch) == limit}
            except BaseException:
                self._close()
                raise
        finally:
            self._lock.release()

    def deliver(self, names, send, *, zstd=None):
        with self._lock:
            self._require_open()
            # Caller send must additionally bind current business space/epoch.
            # Transport failure leaves durable events unacknowledged for retry.
            try:
                self._capture.revalidate()
            except BaseException:
                self._close()
                raise
            return deliver_once(self._store, self.destination, names, send, zstd=zstd)

    def status(self):
        with self._lock:
            self._require_open()
            return self._store.delivery_status(self.destination)

    def issues(self, *, limit=100):
        with self._lock:
            self._require_open()
            return self._store.delivery_issues(self.destination, limit=limit)

    def retry_issues(self, event_ids):
        with self._lock:
            self._require_open()
            self._capture.revalidate()
            return self._store.retry_delivery_issues(self.destination, event_ids)

    def refresh_history(self, *, days, now_seconds, after=None, limit=100, approve_history_read=False):
        # Validate before opening a source snapshot; endpoint must also explain
        # that newly imported history may enter the ordinary AI processing queue.
        if (approve_history_read is not True or type(days) is not int or days not in (1, 7, 30)):
            raise ReadError('HISTORY_APPROVAL_OR_DAYS_REQUIRED')
        validate_history_request(days, now_seconds, limit)
        with self._lock:
            self._require_open()
            try:
                shards = self._capture.capture()
                page, progress, has_more = history_page(self.scope, self._reader.manifest, shards,
                    days=days, now_seconds=now_seconds, after=after, limit=limit, allow_missing_groups=True)
                del shards
                self._capture.revalidate()
                inserted = self._store.import_history(page, approve_history_read=True)
                return {'inserted': inserted, 'next': progress, 'has_more': has_more}
            except BaseException:
                self._close()
                raise

    def _close(self):
        self._state, self._reader = 'closed', None
        try:
            self._capture.close()
        finally:
            if self._store is not None:
                self._store.close()
                self._store = None

    def close(self):
        with self._lock:
            self._close()

    def __exit__(self, *_):
        self.close()
