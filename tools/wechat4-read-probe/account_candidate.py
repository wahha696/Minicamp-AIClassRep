"""Experimental account field observation; deliberately NOT a login detector.

Reads a fixed module and the candidate global_config pointer chain. Never reads
the nearby master-key field, DBs, contacts, UI or network. It can observe an old
account after logout, so observations must not open a business space.
"""
from __future__ import annotations

import math
import ntpath
import re
import struct
import time
from dataclasses import dataclass, field

from native import ModuleIdentity, NativeProcess, ProcessIdentity, normal_path
from reader import ReadError

LANDMARK = b"global_config"
MIN_ADDRESS, MAX_ADDRESS = 0x10000, 0x800000000000


@dataclass(frozen=True, repr=False)
class AccountProfile:
    expected_version: str
    acknowledged_experimental_layout: bool = False


@dataclass(frozen=True, repr=False)
class AccountObservation:
    account_id: str | None
    read_bytes: int
    anchor_rva: int | None = None
    login_verified: bool = field(default=False, init=False)


class _Reader:
    def __init__(self, process, expected, module, max_bytes, max_seconds, clock):
        self.process, self.expected, self.module = process, expected, module
        self.remaining, self.max_bytes = max_bytes, max_bytes
        self.clock, self.deadline = clock, clock() + max_seconds

    def guard(self):
        if self.clock() >= self.deadline:
            raise ReadError("ACCOUNT_OBSERVATION_TIME_EXCEEDED")
        if self.process.identity() != self.expected:
            raise ReadError("PROCESS_IDENTITY_CHANGED")

    def read(self, address, size):
        self.guard()
        if (type(address) is not int or not MIN_ADDRESS <= address < address + size <= MAX_ADDRESS
                or not 0 < size <= 1024 * 1024):
            raise ReadError("ACCOUNT_POINTER_INVALID")
        if size > self.remaining:
            raise ReadError("ACCOUNT_OBSERVATION_BYTE_BUDGET_EXCEEDED")
        self.remaining -= size
        data = self.process.read(address, size)
        if len(data) != size:
            raise ReadError("PROCESS_SHORT_READ")
        self.guard()
        return data

    def pointer(self, address):
        result = struct.unpack("<Q", self.read(address, 8))[0]
        if not MIN_ADDRESS <= result < MAX_ADDRESS:
            raise ReadError("ACCOUNT_POINTER_INVALID")
        return result

    def anchor(self):
        # Bounded streaming scan; no full module or process-memory cache.
        tail, found = b"", set()
        for offset in range(0, self.module.size, 1024 * 1024):
            block = self.read(self.module.base + offset, min(1024 * 1024, self.module.size - offset))
            joined = tail + block
            start = 0
            while True:
                at = joined.find(LANDMARK, start)
                if at < 0:
                    break
                address = self.module.base + offset - len(tail) + at
                if (at + 32 <= len(joined) and address % 8 == 0
                        and joined[at + 13:at + 16] == b"\0\0\0"
                        and struct.unpack_from("<QQ", joined, at + 16) == (13, 15)):
                    found.add(address)
                    if len(found) > 1:
                        raise ReadError("ACCOUNT_ANCHOR_AMBIGUOUS")
                start = at + 1
            tail = joined[-31:]
        if len(found) != 1:
            raise ReadError("ACCOUNT_ANCHOR_NOT_FOUND")
        address = found.pop()
        if address + 16 - 0x138 < self.module.base:
            raise ReadError("ACCOUNT_ANCHOR_OUTSIDE_MODULE")
        return address

    def string(self, address):
        header = self.read(address, 32)
        size, capacity = struct.unpack_from("<QQ", header, 16)
        if (size > 128 or capacity > 1024 * 1024 or capacity < size
                or (capacity < 16 and capacity not in (0, 15))):
            raise ReadError("ACCOUNT_STRING_LAYOUT_UNSUPPORTED")
        if capacity < 16:
            content = header[:size]
        else:
            pointer = struct.unpack_from("<Q", header)[0]
            content = self.read(pointer, size) if size else b""
        if self.read(address, 32) != header:
            raise ReadError("ACCOUNT_VALUE_CHANGED")
        if capacity >= 16 and size and self.read(pointer, size) != content:
            raise ReadError("ACCOUNT_VALUE_CHANGED")
        if not content:
            return None
        try:
            account = content.decode("ascii")
        except UnicodeError:
            raise ReadError("ACCOUNT_STRING_INVALID") from None
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{2,127}", account):
            raise ReadError("ACCOUNT_STRING_INVALID")
        return account


def observe_account(*, expected_process, expected_module, profile,
                    approve_runtime_account_read=False, accept_os_memory_limit=False,
                    max_bytes, max_seconds, process_factory=NativeProcess, clock=time.monotonic,
                    anchor_rva=None):
    """One explicitly approved observation, never a verified platform login.

    The profile is a fixed-source experimental layout, not a version-support
    promise. No fallback versions, recent-account choice, keys or DB access.
    """
    if approve_runtime_account_read is not True or accept_os_memory_limit is not True:
        raise ReadError("RUNTIME_ACCOUNT_READ_CONFIRMATION_REQUIRED")
    if (not isinstance(expected_process, ProcessIdentity) or not isinstance(expected_module, ModuleIdentity)
            or not isinstance(profile, AccountProfile) or profile.acknowledged_experimental_layout is not True
            or not re.fullmatch(r"4\.\d+\.\d+\.\d+", profile.expected_version)
            or profile.expected_version != expected_process.version
            or profile.expected_version != expected_module.version
            or normal_path(expected_process.executable) != expected_process.executable
            or normal_path(expected_module.path) != expected_module.path
            or ntpath.basename(expected_process.executable) != "weixin.exe"
            or ntpath.basename(expected_module.path) != "weixin.dll"
            or type(expected_process.pid) is not int or not 0 < expected_process.pid <= 0xFFFFFFFF
            or type(expected_process.created) is not int or expected_process.created <= 0):
        raise ReadError("EXPLICIT_ACCOUNT_PROFILE_AND_IDENTITIES_REQUIRED")
    if (type(max_bytes) is not int or max_bytes <= 0 or type(max_seconds) not in (int, float)
            or not math.isfinite(max_seconds) or not 0 < max_seconds <= 60
            or type(expected_module.base) is not int or type(expected_module.size) is not int
            or not MIN_ADDRESS <= expected_module.base < expected_module.base + expected_module.size <= MAX_ADDRESS
            or expected_module.size < 32 or anchor_rva is None and expected_module.size > max_bytes
            or anchor_rva is not None and (type(anchor_rva) is not int or anchor_rva % 8
                or not 0x128 <= anchor_rva < anchor_rva + 32 <= expected_module.size)):
        raise ReadError("EXPLICIT_ACCOUNT_OBSERVATION_BUDGET_REQUIRED")
    with process_factory(expected_process.pid) as process:
        reader = _Reader(process, expected_process, expected_module, max_bytes, max_seconds, clock)
        reader.guard()
        if process.module(expected_module.path) != expected_module:
            raise ReadError("PROCESS_MODULE_IDENTITY_CHANGED")
        anchor = reader.anchor() if anchor_rva is None else expected_module.base + anchor_rva
        # Cache only the location within an independently rechecked process and
        # module. Never cache account text, owner/config pointers or login state.
        expected_landmark = LANDMARK + b"\0\0\0" + struct.pack("<QQ", 13, 15)
        if reader.read(anchor, 32) != expected_landmark:
            raise ReadError("ACCOUNT_ANCHOR_CHANGED")
        pointer_address = anchor + 16 - 0x138
        owner = reader.pointer(pointer_address)
        config = reader.pointer(owner + 0x68)
        account = reader.string(config + 0x48)
        if reader.pointer(pointer_address) != owner or reader.pointer(owner + 0x68) != config:
            raise ReadError("ACCOUNT_VALUE_CHANGED")
        reader.guard()
        if process.module(expected_module.path) != expected_module:
            raise ReadError("PROCESS_MODULE_IDENTITY_CHANGED")
        if reader.read(anchor, 32) != expected_landmark:
            raise ReadError("ACCOUNT_ANCHOR_CHANGED")
        return AccountObservation(account, reader.max_bytes - reader.remaining, anchor - expected_module.base)
