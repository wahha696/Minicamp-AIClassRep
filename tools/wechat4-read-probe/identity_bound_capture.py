"""Account/window checks around memory-only capture. Not production login proof.

No automatic discovery, account switching, polling, delivery, disk or network
entrypoint. The caller still needs explicit key/database consent, file scope
and a separately authenticated business connection. Every new session starts
without an account-location cache; failed sessions can only be closed.
"""
import threading

from identity_snapshot import observe_identity_snapshot, require_account_snapshot
from managed_windows import validate_managed_profile
from reader import ReadError, Scope


class IdentityBoundCapture:
    def __init__(self, *, scope, expected_process, expected_module, report,
                 expected_sha256, session_factory, approve_joint_read=False,
                 accept_os_memory_limit=False, observe=observe_identity_snapshot):
        if (type(scope) is not Scope or approve_joint_read is not True
                or accept_os_memory_limit is not True or not callable(session_factory)
                or not callable(observe)):
            raise ReadError('IDENTITY_CAPTURE_SCOPE_REQUIRED')
        validate_managed_profile(expected_process=expected_process, expected_module=expected_module,
            report=report, expected_sha256=expected_sha256, approve_managed_read=True,
            max_windows=32, max_bytes=1048576, max_nodes=4096, max_seconds=5)
        self.scope, self.expected = scope, expected_process
        self._options = dict(expected_process=expected_process, expected_module=expected_module,
            report=report, expected_sha256=expected_sha256, approve_joint_read=True,
            accept_os_memory_limit=True)
        self._factory, self._observe = session_factory, observe
        self._session, self._anchor, self._state = None, None, 'new'
        self._lock = threading.Lock()

    def _check(self):
        cached = self._anchor is not None
        result = self._observe(**self._options, anchor_rva=self._anchor,
            max_bytes=1048576 if cached else 268435456, max_seconds=5 if cached else 15)
        self._anchor = require_account_snapshot(result, self.scope.account,
            self._options['expected_module'].size, self._anchor)

    def _close(self):
        self._state, self._anchor = 'closed', None
        if self._session is not None:
            self._session.close()
            self._session = None  # Keep the owner for retry if close raises.

    def __enter__(self):
        with self._lock:
            if self._state != 'new':
                raise ReadError('IDENTITY_CAPTURE_SESSION_NOT_NEW')
            self._state = 'opening'
            try:
                self._check()  # No key reads or database handles before current identity.
                self._session = self._factory()
                if self._session.scope != self.scope or self._session.expected != self.expected:
                    raise ReadError('IDENTITY_CAPTURE_SESSION_SCOPE_MISMATCH')
                self._session.__enter__()
                self._check()  # Key discovery may take time; confirm again before capture.
                self._state = 'open'
                return self
            except BaseException:
                self._close()
                raise

    def capture(self):
        with self._lock:
            if self._state != 'open':
                raise ReadError('IDENTITY_CAPTURE_SESSION_NOT_OPEN')
            try:
                self._check()
                shards = self._session.capture()
                self._check()
                return shards  # Nothing escapes until the second fresh identity check.
            except BaseException:
                self._close()
                raise

    def revalidate(self):
        """Fresh identity check immediately before selected-message persistence."""
        with self._lock:
            if self._state != 'open':
                raise ReadError('IDENTITY_CAPTURE_SESSION_NOT_OPEN')
            try:
                self._check()
            except BaseException:
                self._close()
                raise

    def close(self):
        with self._lock:
            self._close()

    def __exit__(self, *_):
        self.close()
