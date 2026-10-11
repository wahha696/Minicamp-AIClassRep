"""Inert multi-group coordinator: one capture, independent durable group progress.

Caller supplies admitted identity-bound capture, persisted desired activation
plans and dedicated receipt paths. No discovery, CLI, background loop or AI.
Acknowledgement callback is internal, never an HTTP login/storage credential.
"""
from dataclasses import dataclass
import ntpath
import threading

from reader import ReadError, Scope
from receipts import LocalReceipts
from selected_intake import SelectedMessageIntake


@dataclass(frozen=True, repr=False)
class GroupPlan:
    group_id: str
    receipt_path: str
    activation_id: str
    activation_pending: bool
    require_existing_progress: bool


class _SharedView:
    def __init__(self, owner, group):
        self.owner, self.scope = owner, Scope(owner.scope.account, (group,))
    def __enter__(self): return self
    def capture(self):
        if self.owner._snapshots is None: raise ReadError('GROUP_INTAKE_SNAPSHOT_UNAVAILABLE')
        return self.owner._snapshots
    def revalidate(self): self.owner._capture.revalidate()
    def close(self): pass  # Only the owner closes the one underlying capture.


class GroupMessageIntake:
    def __init__(self, *, scope, capture, plans, destination, approve_selected_storage=False,
                 activation_committed):
        if approve_selected_storage is not True:
            raise ReadError('SELECTED_MESSAGE_STORAGE_APPROVAL_REQUIRED')
        if (type(scope) is not Scope or capture.scope != scope or type(plans) is not tuple
                or len(plans) != len(scope.groups) or any(type(plan) is not GroupPlan for plan in plans)
                or {plan.group_id for plan in plans} != set(scope.groups)
                or not callable(activation_committed)):
            raise ReadError('GROUP_INTAKE_PLAN_INVALID')
        paths = set()
        for plan in plans:
            if (type(plan.activation_pending) is not bool or type(plan.require_existing_progress) is not bool
                    or type(plan.receipt_path) is not str or not ntpath.isabs(plan.receipt_path)
                    or plan.receipt_path.startswith('\\\\') or not plan.receipt_path.endswith('.wechat-receipts.sqlite3')):
                raise ReadError('GROUP_INTAKE_PLAN_INVALID')
            LocalReceipts._activation(plan.activation_id)
            paths.add(ntpath.normcase(ntpath.normpath(plan.receipt_path)))
        if len(paths) != len(plans): raise ReadError('GROUP_INTAKE_PLAN_INVALID')
        LocalReceipts._destination(destination)
        self.scope, self._capture, self._plans = scope, capture, plans
        self._destination, self._ack = destination, activation_committed
        self._children, self._snapshots, self._state = {}, None, 'new'
        self._lock = threading.Lock()

    def __enter__(self):
        with self._lock:
            if self._state != 'new': raise ReadError('GROUP_INTAKE_NOT_NEW')
            self._state = 'opening'
            try:
                self._capture.__enter__()
                self._snapshots = self._capture.capture()
                for plan in self._plans:
                    view = _SharedView(self, plan.group_id)
                    child = SelectedMessageIntake(scope=view.scope, capture=view, receipt_path=plan.receipt_path,
                        destination=self._destination, approve_selected_storage=True,
                        activation_id=plan.activation_id, activation_pending=plan.activation_pending,
                        require_existing_progress=plan.require_existing_progress)
                    self._children[plan.group_id] = child
                    child.__enter__()
                    # Cursor + token already committed in each group's receipt.
                    # Lost callback acknowledgement retries that token without
                    # resetting its baseline or deleting any pending messages.
                    self._capture.revalidate()
                    self._ack(plan.group_id, plan.activation_id)
                self._state = 'open'
                return self
            except BaseException:
                self._close()
                raise
            finally:
                self._snapshots = None

    def poll(self, *, limit=100):
        if type(limit) is not int or not 1 <= limit <= 1000: raise ReadError('BATCH_LIMIT')
        with self._lock:
            if self._state != 'open': raise ReadError('GROUP_INTAKE_NOT_OPEN')
            try:
                self._snapshots = self._capture.capture()
                return {group: child.poll(limit=limit) for group, child in self._children.items()}
            except BaseException:
                self._close()
                raise
            finally:
                self._snapshots = None

    def deliver(self, group, names, send, *, zstd=None):
        with self._lock:
            if self._state != 'open' or group not in self._children: raise ReadError('GROUP_INTAKE_NOT_OPEN')
            try:
                return self._children[group].deliver(names, send, zstd=zstd)
            except BaseException:
                self._close()  # Pending receipts remain durable for the next owned session.
                raise

    def status(self):
        with self._lock:
            if self._state != 'open': raise ReadError('GROUP_INTAKE_NOT_OPEN')
            return {group: child.status() for group, child in self._children.items()}

    def refresh_history(self, group, **request):
        with self._lock:
            if self._state != 'open' or group not in self._children: raise ReadError('GROUP_INTAKE_NOT_OPEN')
            try:
                self._snapshots = self._capture.capture()
                return self._children[group].refresh_history(**request)
            except BaseException:
                self._close()
                raise
            finally:
                self._snapshots = None

    def issues(self, group, *, limit=100):
        with self._lock:
            if self._state != 'open' or group not in self._children: raise ReadError('GROUP_INTAKE_NOT_OPEN')
            return self._children[group].issues(limit=limit)

    def retry_issues(self, group, event_ids):
        with self._lock:
            if self._state != 'open' or group not in self._children: raise ReadError('GROUP_INTAKE_NOT_OPEN')
            try:
                return self._children[group].retry_issues(event_ids)
            except BaseException:
                self._close()
                raise

    def _close(self):
        self._state, self._snapshots = 'closed', None
        failure = None
        for child in self._children.values():
            try: child.close()
            except BaseException as error:
                if failure is None: failure = error
        try:
            self._capture.close()
        except BaseException as error:
            if failure is None: failure = error
        if failure is not None: raise failure

    def close(self):
        with self._lock: self._close()
    def __exit__(self, *_): self.close()
