"""Bounded process/module metadata only. No memory, accounts or data directories.

Toolhelp snapshots temporarily enumerate other executable names/PIDs, but only
WeChat candidate PIDs are retained. Limited-query handles never request VM_READ.
Unsupported/inaccessible/multiple candidates fail without choosing a first PID.
"""
import ctypes as C
from dataclasses import dataclass
import math
import ntpath
import time

from native import ModuleIdentity, ProcessEntry, ProcessIdentity, kernel
from reader import ReadError
from window_observation import QueryProcess

KNOWN_PROFILES = {'4.1.15.50': '0cf6379405432385a1c442766443450f26a7689f45e53c1b4ad2822061f3113b'}


def candidate_pids(*, max_entries=8192, max_candidates=32, max_seconds=5,
                   api_factory=kernel, error=None, clock=time.monotonic):
    if (type(max_entries) is not int or not 1 <= max_entries <= 8192
            or type(max_candidates) is not int or not 1 <= max_candidates <= 32
            or type(max_seconds) not in (int, float) or not math.isfinite(max_seconds) or not 0 < max_seconds <= 5):
        raise ReadError('EXPLICIT_DISCOVERY_BUDGET_REQUIRED')
    deadline = clock() + max_seconds
    def guard():
        if clock() >= deadline:
            raise ReadError('DISCOVERY_TIME_EXCEEDED')
    guard()
    api = api_factory()
    error = error or C.get_last_error
    handle = api.CreateToolhelp32Snapshot(0x02, 0)
    if handle in (None, 0, C.c_void_p(-1).value):
        raise ReadError('DISCOVERY_SNAPSHOT_FAILED')
    found, seen, count = [], set(), 0
    try:
        guard()
        entry = ProcessEntry()
        entry.size = C.sizeof(entry)
        ok = api.Process32FirstW(handle, C.byref(entry))
        while ok:
            guard()
            count += 1
            if count > max_entries:
                raise ReadError('DISCOVERY_ENTRY_LIMIT')
            if entry.executable.casefold() in ('weixin.exe', 'wechat.exe'):
                pid = int(entry.pid)
                if pid <= 0 or pid in seen:
                    raise ReadError('DISCOVERY_PID_INVALID_OR_DUPLICATE')
                seen.add(pid)
                found.append(pid)
                if len(found) > max_candidates:
                    raise ReadError('DISCOVERY_CANDIDATE_LIMIT')
            entry.size = C.sizeof(entry)
            ok = api.Process32NextW(handle, C.byref(entry))
        if error() != 18:
            raise ReadError('DISCOVERY_ENUMERATION_FAILED')
        guard()
    finally:
        if not api.CloseHandle(handle):
            raise ReadError('DISCOVERY_CLOSE_FAILED')
    return tuple(sorted(found))


@dataclass(frozen=True, repr=False)
class Discovery:
    state: str
    process: ProcessIdentity | None = None
    module: ModuleIdentity | None = None
    sha256: str | None = None


def discover_target(*, enumerate_candidates=candidate_pids, query_factory=QueryProcess,
                    max_seconds=10, clock=time.monotonic):
    if type(max_seconds) not in (int, float) or not math.isfinite(max_seconds) or not 0 < max_seconds <= 10:
        raise ReadError('EXPLICIT_DISCOVERY_BUDGET_REQUIRED')
    deadline = clock() + max_seconds
    def guard():
        if clock() >= deadline:
            raise ReadError('DISCOVERY_TIME_EXCEEDED')
    before = enumerate_candidates(max_seconds=min(5, max_seconds))
    guard()
    if (type(before) is not tuple or len(before) > 32 or len(set(before)) != len(before)
            or any(type(pid) is not int or not 0 < pid <= 0xFFFFFFFF for pid in before)):
        raise ReadError('DISCOVERY_PID_INVALID_OR_DUPLICATE')
    if not before:
        return Discovery('not_running')
    targets = []
    unsupported = False
    for pid in before:
        guard()
        with query_factory(pid) as process:
            identity = process.identity()
            if identity.pid != pid or ntpath.basename(identity.executable) not in ('weixin.exe', 'wechat.exe'):
                raise ReadError('DISCOVERY_PROCESS_CHANGED')
            if identity.version not in KNOWN_PROFILES or ntpath.basename(identity.executable) != 'weixin.exe':
                unsupported = True
                continue
            core = ntpath.join(ntpath.dirname(identity.executable), identity.version, 'weixin.dll')
            try:
                module = process.module(core)
            except ReadError as error:
                if str(error) != 'EXPLICIT_MODULE_MISSING':
                    raise
                if process.identity() != identity:
                    raise ReadError('DISCOVERY_PROCESS_CHANGED') from None
                continue  # Known executable's helper process without this core module.
            if process.identity() != identity or module.path != core or module.version != identity.version:
                raise ReadError('DISCOVERY_PROCESS_CHANGED')
            targets.append((identity, module, KNOWN_PROFILES[identity.version]))
        guard()
    remaining = deadline - clock()
    if remaining <= 0:
        raise ReadError('DISCOVERY_TIME_EXCEEDED')
    after = enumerate_candidates(max_seconds=min(5, remaining))
    if before != after:
        raise ReadError('DISCOVERY_CANDIDATES_CHANGED')
    guard()
    # A supported core alongside an unsupported candidate is still ambiguous;
    # do not incorrectly tell the user that the supported installation changed
    # version. We still refuse to pick either process or read account memory.
    if unsupported and targets:
        return Discovery('ambiguous')
    if unsupported:
        return Discovery('unsupported')
    if len(targets) > 1:
        return Discovery('ambiguous')
    if not targets:
        return Discovery('main_process_unavailable')
    identity, module, sha = targets[0]
    with query_factory(identity.pid) as process:
        if process.identity() != identity or process.module(module.path) != module:
            raise ReadError('DISCOVERY_PROCESS_CHANGED')
    guard()
    return Discovery('found', identity, module, sha)
