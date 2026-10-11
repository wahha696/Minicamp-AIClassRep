"""Bounded structural experiment with an injected read-only byte source.

No native process/window access, file IO, GUI, account or production entrypoint.
This follows a candidate managed HWND map; it never scans the heap. Even a
stable main-window observation is NOT current-account or login proof.
"""
from dataclasses import dataclass, field
import hashlib
import math
import struct
import time

from reader import ReadError
from static_window_map import LOOKUP_BODY, WindowMapper


@dataclass(frozen=True, repr=False)
class WindowMapObservation:
    main_windows: int
    login_windows: int
    unknown_windows: int
    absent_windows: int
    bytes_read: int
    nodes_read: int
    ownership_token: bytes = field(default=b"", repr=False)
    login_verified: bool = field(default=False, init=False)


def observe_window_map(*, read, module_base, mapper, type_tables, hwnds,
                       max_bytes, max_nodes, max_seconds, clock=time.monotonic):
    """Diagnostic only; caller must separately establish consent and identity.

    Offsets/hash/body refer only to the exact static candidate, not other Qt
    builds. Read fields individually; never follow a nonmatching node's value
    or a widget's text/children. Reread the observed structure before returning.
    Rereads detect observed changes, not an atomic snapshot or ABA transitions.
    """
    if (type(max_bytes) is not int or not 1 <= max_bytes <= 1024 * 1024
            or type(max_nodes) is not int or not 1 <= max_nodes <= 4096
            or type(max_seconds) not in (int, float) or not math.isfinite(max_seconds)
            or not 0 < max_seconds <= 5):
        raise ReadError("EXPLICIT_WINDOW_MAP_BUDGET_REQUIRED")
    def pointer(value):
        return type(value) is int and value % 8 == 0 and 0x10000 <= value < 0x800000000000
    if (not callable(read) or not pointer(module_base) or type(mapper) is not WindowMapper
            or type(mapper.lookup_rva) is not int or mapper.lookup_rva < 0
            or type(mapper.global_rva) is not int or mapper.global_rva < 0
            or not pointer(module_base + mapper.lookup_rva)
            or not pointer(module_base + mapper.global_rva)
            or type(mapper.body) is not bytes or len(mapper.body) != len(LOOKUP_BODY)
            or mapper.body[:4] != LOOKUP_BODY[:4] or mapper.body[8:] != LOOKUP_BODY[8:]
            or mapper.lookup_rva + 8 + struct.unpack_from("<i", mapper.body, 4)[0] != mapper.global_rva):
        raise ReadError("EXPLICIT_WINDOW_MAPPER_REQUIRED")
    if (type(hwnds) is not tuple or not 1 <= len(hwnds) <= 32
            or any(type(h) is not int or not 0 < h <= 0xFFFFFFFFFFFFFFFF for h in hwnds)
            or len(set(hwnds)) != len(hwnds)
            or type(type_tables) is not dict or not 2 <= len(type_tables) <= 16
            or any(type(name) is not str for name in type_tables.values())
            or set(type_tables.values()) != {"mmui::MainWindow", "mmui::LoginWindow"}
            or any(not pointer(p) for p in type_tables)):
        raise ReadError("EXPLICIT_WINDOW_MAP_TARGETS_REQUIRED")
    deadline, total, nodes = clock() + max_seconds, 0, 0
    ledger = {}
    def guard():
        if clock() >= deadline:
            raise ReadError("WINDOW_MAP_TIME_EXCEEDED")
    def fetch(address, size, *, remember=True):
        nonlocal total
        guard()
        if not pointer(address) or address + size > 0x800000000000:
            raise ReadError("WINDOW_MAP_POINTER_INVALID")
        if total + size > max_bytes:
            raise ReadError("WINDOW_MAP_BYTE_LIMIT")
        total += size
        raw = read(address, size)
        guard()
        if type(raw) is not bytes or len(raw) != size:
            raise ReadError("WINDOW_MAP_SHORT_READ")
        if remember:
            key = (address, size)
            if key in ledger and ledger[key] != raw:
                raise ReadError("WINDOW_MAP_CHANGED")
            ledger[key] = raw
        return raw
    def word(address):
        return struct.unpack("<Q", fetch(address, 8))[0]

    if fetch(module_base + mapper.lookup_rva, len(mapper.body)) != mapper.body:
        raise ReadError("WINDOW_MAP_CODE_CHANGED")
    root = word(module_base + mapper.global_rva)
    counts = {"mmui::MainWindow": 0, "mmui::LoginWindow": 0, "unknown": 0, "absent": 0}
    ownership = []
    if root:
        data = word(root)
        # Exactly the observed QHashData fields: two pointers, ref/size/nodeSize,
        # bit widths, bucket count and seed. No payload or unrelated properties.
        _, buckets, ref, size, node_size, user_bits, bits, capacity, seed = struct.unpack(
            "<QQiiihhiI", fetch(data, 40))
        if (ref < -1 or not 0 <= size <= 1000000 or not 0 <= capacity <= 1000000
                or not 0 <= user_bits <= bits <= 31 or size and (not capacity or node_size != 32)):
            raise ReadError("WINDOW_MAP_LAYOUT_INVALID")
        if size:
            if not pointer(buckets):
                raise ReadError("WINDOW_MAP_POINTER_INVALID")
            objects = set()
            for hwnd in hwnds:
                guard()
                h = ((hwnd ^ (hwnd >> 31)) ^ seed) & 0xFFFFFFFF
                bucket = h % capacity
                current = word(buckets + bucket * 8)
                visited, match = set(), None
                while current != data:
                    if current in visited:
                        raise ReadError("WINDOW_MAP_CYCLE_OR_ALIAS")
                    visited.add(current)
                    if nodes >= max_nodes:
                        raise ReadError("WINDOW_MAP_NODE_LIMIT")
                    if len(visited) > size:
                        raise ReadError("WINDOW_MAP_LAYOUT_INVALID")
                    nodes += 1
                    nxt, node_hash, key, value = struct.unpack("<QI4xQQ", fetch(current, 32))
                    if node_hash % capacity != bucket or node_hash != ((key ^ (key >> 31)) ^ seed) & 0xFFFFFFFF:
                        raise ReadError("WINDOW_MAP_HASH_INVALID")
                    if key == hwnd:
                        if match is not None:
                            raise ReadError("WINDOW_MAP_DUPLICATE_KEY")
                        match = value
                    current = nxt
                if match is None:
                    counts["absent"] += 1
                    continue
                if match in objects:
                    raise ReadError("WINDOW_MAP_DUPLICATE_OBJECT")
                objects.add(match)
                table = word(match)
                kind = type_tables.get(table)
                if not kind:
                    counts["unknown"] += 1
                    continue
                private, widget_data = word(match + 8), word(match + 0x28)
                if word(private + 8) != match or widget_data != private + 0x120:
                    raise ReadError("WINDOW_MAP_OBJECT_OWNERSHIP_INVALID")
                if word(widget_data) != hwnd:
                    raise ReadError("WINDOW_MAP_HWND_MISMATCH")
                flags = struct.unpack("<I", fetch(widget_data + 0x10, 4))[0]
                if flags & 0x40000:
                    raise ReadError("WINDOW_MAP_OBJECT_DESTROYING")
                counts[kind] += 1
                ownership.append((hwnd, match, private, widget_data, table))
        else:
            counts["absent"] = len(hwnds)
    else:
        counts["absent"] = len(hwnds)
    for (address, size), original in ledger.items():
        if fetch(address, size, remember=False) != original:
            raise ReadError("WINDOW_MAP_CHANGED")
    guard()
    token = hashlib.sha256(b"".join(struct.pack("<5Q", *entry) for entry in sorted(ownership))).digest()
    return WindowMapObservation(counts["mmui::MainWindow"], counts["mmui::LoginWindow"],
                                counts["unknown"], counts["absent"], total, nodes, token)
