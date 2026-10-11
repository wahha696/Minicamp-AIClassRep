"""One-shot managed-window evidence, NOT a login or account verifier.

Read only a hash-pinned profile's code/table bytes and HWND-linked metadata.
No chat, contact, account, key, UIA, heap scanning or write/GUI operations.
"""
from dataclasses import dataclass, field
import math
import re
import struct
import time

from native import ModuleIdentity, NativeProcess, ProcessIdentity, normal_path
from reader import ReadError
from static_types import CLASSES, StaticReport
from window_map_snapshot import observe_window_map
from window_observation import NativeWindows


@dataclass(frozen=True, repr=False)
class ManagedWindowObservation:
    main_windows: int
    login_windows: int
    unknown_windows: int
    absent_windows: int
    target_windows: int
    bytes_read: int
    nodes_read: int
    ownership_token: bytes = field(default=b"", repr=False)
    login_verified: bool = field(default=False, init=False)


def validate_managed_profile(*, expected_process, expected_module, report, expected_sha256,
                             approve_managed_read=False, max_windows, max_bytes, max_nodes, max_seconds):
    if approve_managed_read is not True:
        raise ReadError("MANAGED_WINDOW_CONFIRMATION_REQUIRED")
    if (type(expected_process) is not ProcessIdentity or type(expected_module) is not ModuleIdentity
            or type(expected_process.pid) is not int or not 0 < expected_process.pid <= 0xFFFFFFFF
            or type(expected_process.created) is not int or expected_process.created <= 0
            or expected_process.version != "4.1.15.50" or expected_module.version != expected_process.version
            or normal_path(expected_process.executable) != expected_process.executable
            or expected_process.executable.rsplit("\\", 1)[-1] != "weixin.exe"
            or normal_path(expected_module.path) != expected_module.path
            or expected_module.path.rsplit("\\", 1)[-1] != "weixin.dll"
            or type(expected_module.base) is not int or expected_module.base % 65536
            or not 65536 <= expected_module.base < 0x800000000000
            or type(expected_module.size) is not int or not 0 < expected_module.size <= 256 * 1024 * 1024
            or expected_module.base + expected_module.size > 0x800000000000):
        raise ReadError("EXPLICIT_MANAGED_PROCESS_REQUIRED")
    if (type(max_windows) is not int or not 1 <= max_windows <= 32
            or type(max_bytes) is not int or not 1 <= max_bytes <= 1024 * 1024
            or type(max_nodes) is not int or not 1 <= max_nodes <= 4096
            or type(max_seconds) not in (int, float) or not math.isfinite(max_seconds) or not 0 < max_seconds <= 5):
        raise ReadError("EXPLICIT_MANAGED_WINDOW_BUDGET_REQUIRED")
    if (type(report) is not StaticReport or type(expected_sha256) is not str
            or not re.fullmatch("[0-9a-f]{64}", expected_sha256) or report.sha256 != expected_sha256
            or report.image_bytes != expected_module.size or len(report.window_mapper_candidates) != 1
            or tuple(t.class_name for t in report.types) != CLASSES):
        raise ReadError("MANAGED_STATIC_PROFILE_INVALID")
    mapper = report.window_mapper_candidates[0]
    tables, checks = {}, [(mapper.lookup_rva, mapper.body)]
    for item in report.types:
        if len(item.qt_accessor_candidates) != 1:
            raise ReadError("MANAGED_STATIC_PROFILE_INVALID")
        entry = item.qt_accessor_candidates[0]
        if (not 1 <= len(entry.pointer_table_candidates) <= 8
                or tuple(t for t, _ in entry.table_method_rvas) != entry.pointer_table_candidates):
            raise ReadError("MANAGED_STATIC_PROFILE_INVALID")
        # All displacements are relative to the instruction, unchanged by ASLR.
        accessor = (b"\x48\x8b\x49\x08\x48\x83\x79\x28\0\x0f\x85"
                    + struct.pack("<i", entry.dynamic_meta_target_rva - entry.function_rva - 15)
                    + b"\x48\x8d\x05" + struct.pack("<i", item.metaobject_rva - entry.function_rva - 22)
                    + b"\xc3")
        checks.append((entry.function_rva, accessor))
        for table, methods in entry.table_method_rvas:
            if expected_module.base + table in tables or len(methods) != 3 or methods[0] != entry.function_rva:
                raise ReadError("MANAGED_STATIC_PROFILE_INVALID")
            if any(type(m) is not int or not 0 < m < expected_module.size for m in methods):
                raise ReadError("MANAGED_STATIC_PROFILE_INVALID")
            tables[expected_module.base + table] = item.class_name
            checks.append((table, struct.pack("<3Q", *(expected_module.base + m for m in methods))))
    if (len(tables) < 2 or any(type(rva) is not int or not 0 < rva < rva + len(raw) <= expected_module.size
                            for rva, raw in checks)
            or not 0 < mapper.global_rva < mapper.global_rva + 8 <= expected_module.size):
        raise ReadError("MANAGED_STATIC_PROFILE_INVALID")
    return mapper, tables, checks


def observe_managed_windows(*, expected_process, expected_module, report, expected_sha256,
                            approve_managed_read=False, max_windows, max_bytes, max_nodes, max_seconds,
                            process_factory=NativeProcess, windows_factory=NativeWindows,
                            clock=time.monotonic):
    mapper, tables, checks = validate_managed_profile(expected_process=expected_process, expected_module=expected_module,
        report=report, expected_sha256=expected_sha256, approve_managed_read=approve_managed_read,
        max_windows=max_windows, max_bytes=max_bytes, max_nodes=max_nodes, max_seconds=max_seconds)
    deadline, total = clock() + max_seconds, 0
    def guard():
        if clock() >= deadline:
            raise ReadError("MANAGED_WINDOW_TIME_EXCEEDED")
    with process_factory(expected_process.pid) as process:
        def identity():
            guard()
            if process.identity() != expected_process or process.module(expected_module.path) != expected_module:
                raise ReadError("MANAGED_PROCESS_OR_MODULE_CHANGED")
            guard()
        def read(at, size):
            nonlocal total
            guard()
            if total + size > max_bytes:
                raise ReadError("MANAGED_WINDOW_BYTE_LIMIT")
            total += size
            raw = process.read(at, size)
            guard()
            if type(raw) is not bytes or len(raw) != size:
                raise ReadError("MANAGED_WINDOW_SHORT_READ")
            return raw
        identity()
        windows = windows_factory()
        selected = windows.handles(expected_process.pid, max_windows=max_windows, guard=guard)
        def owners(handles):
            if (type(handles) is not tuple or not 1 <= len(handles) <= max_windows
                    or any(type(h) is not int or not 0 < h <= 0xFFFFFFFFFFFFFFFF for h in handles)
                    or len(set(handles)) != len(handles)):
                raise ReadError("MANAGED_TARGET_WINDOW_SET_INVALID")
            for handle in handles:
                guard()
                if windows.owner(handle) != expected_process.pid:
                    raise ReadError("MANAGED_WINDOW_OWNER_CHANGED")
        owners(selected)
        for rva, raw in checks:
            if read(expected_module.base + rva, len(raw)) != raw:
                raise ReadError("MANAGED_RUNTIME_PROFILE_CHANGED")
        remaining = deadline - clock()
        if remaining <= 0 or max_bytes - total <= 0:
            raise ReadError("MANAGED_WINDOW_BUDGET_EXCEEDED")
        observation = observe_window_map(read=read, module_base=expected_module.base, mapper=mapper,
            type_tables=tables, hwnds=selected, max_bytes=max_bytes - total, max_nodes=max_nodes,
            max_seconds=remaining, clock=clock)
        for rva, raw in checks:
            if read(expected_module.base + rva, len(raw)) != raw:
                raise ReadError("MANAGED_RUNTIME_PROFILE_CHANGED")
        after = windows.handles(expected_process.pid, max_windows=max_windows, guard=guard)
        owners(after)
        if set(after) != set(selected):
            raise ReadError("MANAGED_WINDOW_SET_CHANGED")
        identity()
        return ManagedWindowObservation(observation.main_windows, observation.login_windows,
            observation.unknown_windows, observation.absent_windows, len(selected), total, observation.nodes_read,
            observation.ownership_token)
