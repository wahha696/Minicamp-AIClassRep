"""Joint account/window evidence for calibration; never production login proof."""
from dataclasses import dataclass, field
import math
import time

from account_candidate import AccountProfile, observe_account
from managed_windows import observe_managed_windows, validate_managed_profile
from native import NativeProcess
from reader import ReadError
from window_observation import NativeWindows


@dataclass(frozen=True, repr=False)
class IdentitySnapshot:
    state: str
    account_id: str | None
    anchor_rva: int | None
    bytes_read: int
    window_checks: int
    login_verified: bool = field(default=False, init=False)


def require_account_snapshot(result, account, module_size, anchor=None):
    """Bind research evidence to an explicit account, without granting a login."""
    if (type(result) is not IdentitySnapshot or result.state != 'main_and_account_observed'
            or result.window_checks != 2 or result.account_id != account
            or type(result.anchor_rva) is not int or result.anchor_rva % 8
            or not 0x128 <= result.anchor_rva < result.anchor_rva + 32 <= module_size
            or anchor is not None and result.anchor_rva != anchor):
        raise ReadError('IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT')
    return result.anchor_rva


class _Borrowed:
    def __init__(self, process, read):
        self.process, self.read = process, read

    def identity(self):
        return self.process.identity()

    def module(self, path):
        return self.process.module(path)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass  # The outer owner closes the one process handle on every path.


def observe_identity_snapshot(*, expected_process, expected_module, report, expected_sha256,
                              approve_joint_read=False, accept_os_memory_limit=False, anchor_rva=None,
                              max_bytes, max_seconds, process_factory=NativeProcess,
                              windows_factory=NativeWindows, clock=time.monotonic):
    """Window -> account -> account -> window using one owned process handle.

    Skip account access entirely unless a unique main window and no login page
    are observed. Verify the account again at the freshly checked location;
    changing/unknown/failed evidence cannot revive an old account. An account
    location supplied by the caller must be discarded on process/module change.
    """
    if approve_joint_read is not True or accept_os_memory_limit is not True:
        raise ReadError("JOINT_IDENTITY_CONFIRMATION_REQUIRED")
    if (type(max_bytes) is not int or not 1 <= max_bytes <= 256 * 1024 * 1024
            or type(max_seconds) not in (int, float) or not math.isfinite(max_seconds)
            or not 0 < max_seconds <= 15):
        raise ReadError("EXPLICIT_JOINT_IDENTITY_BUDGET_REQUIRED")
    # Identity/profile validation happens before opening any native handle.
    validate_managed_profile(expected_process=expected_process, expected_module=expected_module,
        report=report, expected_sha256=expected_sha256, approve_managed_read=True,
        max_windows=32, max_bytes=1024 * 1024, max_nodes=4096, max_seconds=5)
    if anchor_rva is not None and (type(anchor_rva) is not int or anchor_rva % 8
            or not 0x128 <= anchor_rva < anchor_rva + 32 <= expected_module.size):
        raise ReadError("EXPLICIT_JOINT_ANCHOR_REQUIRED")
    deadline, total = clock() + max_seconds, 0
    def remaining(limit):
        value = min(limit, deadline - clock())
        if value <= 0:
            raise ReadError("JOINT_IDENTITY_TIME_EXCEEDED")
        return value
    with process_factory(expected_process.pid) as process:
        def read(address, size):
            nonlocal total
            remaining(15)
            if total + size > max_bytes:
                raise ReadError("JOINT_IDENTITY_BYTE_LIMIT")
            total += size
            raw = process.read(address, size)
            remaining(15)
            return raw
        borrowed = _Borrowed(process, read)
        def windows():
            return observe_managed_windows(expected_process=expected_process, expected_module=expected_module,
                report=report, expected_sha256=expected_sha256, approve_managed_read=True,
                max_windows=32, max_bytes=min(1024 * 1024, max_bytes - total), max_nodes=4096,
                max_seconds=remaining(5), process_factory=lambda _: borrowed,
                windows_factory=windows_factory, clock=clock)
        first = windows()
        if first.main_windows != 1 or first.login_windows != 0:
            state = "login_page_observed" if first.login_windows == 1 and first.main_windows == 0 else "unknown"
            return IdentitySnapshot(state, None, None, total, 1)
        def account(at):
            return observe_account(expected_process=expected_process, expected_module=expected_module,
                profile=AccountProfile(expected_process.version, True), approve_runtime_account_read=True,
                accept_os_memory_limit=True, max_bytes=max_bytes - total, max_seconds=remaining(15),
                anchor_rva=at, process_factory=lambda _: borrowed, clock=clock)
        candidate = account(anchor_rva)
        if candidate.account_id is None:
            return IdentitySnapshot("unknown", None, None, total, 1)
        confirm = account(candidate.anchor_rva)
        if confirm.account_id != candidate.account_id or confirm.anchor_rva != candidate.anchor_rva:
            raise ReadError("JOINT_ACCOUNT_CHANGED")
        after = windows()
        if (after.main_windows != 1 or after.login_windows != 0
                or after.ownership_token != first.ownership_token):
            raise ReadError("JOINT_WINDOW_STATE_CHANGED")
        if process.identity() != expected_process or process.module(expected_module.path) != expected_module:
            raise ReadError("JOINT_PROCESS_OR_MODULE_CHANGED")
        remaining(15)
        return IdentitySnapshot("main_and_account_observed", confirm.account_id, confirm.anchor_rva, total, 2)
