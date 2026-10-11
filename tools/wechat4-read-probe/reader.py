"""Memory-only, fail-closed read core. NOT a validated live WeChat adapter.

Inputs must already be a coherent DB/WAL byte snapshot of the explicit account.
This module has no file/process/network/UI access or automatic account discovery.
See README for remaining live-version validation and business-bridge prerequisites.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import sqlite3
import struct
import threading
from dataclasses import dataclass, field
from typing import Callable, Mapping

from cng import AesCbc

PAGE_SIZE = 4096
RESERVED = 80
SQLITE_HEADER = b"SQLite format 3\x00"


class ReadError(RuntimeError):
    """Codes only: never include keys, paths, identities or message contents."""


@dataclass(frozen=True, repr=False)
class Scope:
    account: str
    groups: tuple[str, ...]

    def __post_init__(self):
        if not isinstance(self.account, str) or not self.account.strip():
            raise ReadError("EXPLICIT_ACCOUNT_REQUIRED")
        if (type(self.groups) is not tuple or not self.groups or len(set(self.groups)) != len(self.groups)
                or any(not isinstance(g, str) or not re.fullmatch(r"[\w-]+@chatroom", g) for g in self.groups)):
            raise ReadError("EXPLICIT_UNIQUE_GROUPS_REQUIRED")

    def check_account(self, account: str):
        if account != self.account:
            raise ReadError("ACCOUNT_MISMATCH")


class PageCodec:
    """Candidate's specific 4096/80-byte raw-key layout, verified page-by-page.

    This is NOT a general SQLCipher passphrase or arbitrary-version decoder.
    48-byte key material includes an explicit salt / plaintext 16-byte header.
    """

    def __init__(self, key_material: bytes, first_page: bytes):
        if len(key_material) not in (32, 48) or len(first_page) != PAGE_SIZE:
            raise ReadError("UNSUPPORTED_CIPHER_LAYOUT")
        self._explicit_salt = len(key_material) == 48
        salt = key_material[32:] if self._explicit_salt else first_page[:16]
        mac_salt = bytes(v ^ 0x3A for v in salt)
        self._mac_key = bytearray(hashlib.pbkdf2_hmac("sha512", key_material[:32], mac_salt, 2, 32))
        self._aes = None
        try:
            self._verify(first_page, 1)
            if self._explicit_salt and first_page[:16] != SQLITE_HEADER:
                raise ReadError("UNSUPPORTED_PLAINTEXT_HEADER")
            self._aes = AesCbc(key_material[:32])
        except BaseException:
            self.close()
            raise

    def _verify(self, page: bytes, pgno: int):
        if len(page) != PAGE_SIZE or not 1 <= pgno <= 0xFFFFFFFE:
            raise ReadError("PAGE_SIZE_OR_NUMBER")
        if not self._mac_key:
            raise ReadError("KEY_CLOSED")
        start = 16 if pgno == 1 else 0
        mac = hmac.new(self._mac_key, page[start:PAGE_SIZE - 64], "sha512")
        mac.update(struct.pack("<I", pgno))
        if not hmac.compare_digest(mac.digest(), page[-64:]):
            raise ReadError("PAGE_AUTHENTICATION_FAILED")

    def decrypt(self, page: bytes, pgno: int) -> bytes:
        self._verify(page, pgno)
        if self._aes is None:
            raise ReadError("KEY_CLOSED")
        start = 16 if pgno == 1 else 0
        plain = self._aes.decrypt(page[4016:4032], page[start:4016])
        return (SQLITE_HEADER if pgno == 1 else b"") + plain + bytes(RESERVED)

    def close(self):
        if self._aes is not None:
            self._aes.close()
            self._aes = None
        self._mac_key[:] = bytes(len(self._mac_key))
        self._mac_key.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def wal_checksum(data: bytes, endian: str, state=(0, 0)) -> tuple[int, int]:
    if len(data) % 8 or endian not in ("<", ">"):
        raise ReadError("WAL_CHECKSUM_INPUT")
    s0, s1 = state
    for x0, x1 in struct.iter_unpack(endian + "II", data):
        s0 = (s0 + x0 + s1) & 0xFFFFFFFF
        s1 = (s1 + x1 + s0) & 0xFFFFFFFF
    return s0, s1


@dataclass(frozen=True)
class WalOverlay:
    pages: dict[int, bytes] = field(repr=False)
    size: int | None
    base_limit: int | None


def committed_wal_pages(wal: bytes, max_bytes: int) -> WalOverlay:
    """Validate ordinary SQLite WAL raw bytes and select the last commit.

    Invalid/partial/current-generation frames fail the whole read; stale-salt
    frames after a verified commit stop the previous-generation tail. No silent
    fallback to old/main data. Encrypted WCDB checksum placement is unverified.
    """
    if not wal:
        return WalOverlay({}, None, None)
    if len(wal) < 32 or len(wal) > max_bytes:
        raise ReadError("WAL_SIZE")
    magic, version, page_size = struct.unpack_from(">III", wal)
    if magic not in (0x377F0682, 0x377F0683) or version != 3007000 or page_size != PAGE_SIZE:
        raise ReadError("WAL_FORMAT_UNSUPPORTED")
    endian = "<" if magic == 0x377F0682 else ">"
    state = wal_checksum(wal[:24], endian)
    if state != struct.unpack_from(">II", wal, 24):
        raise ReadError("WAL_HEADER_CHECKSUM")
    salt = wal[16:24]
    pages: dict[int, bytes] = {}
    committed: dict[int, bytes] = {}
    commit_size = None
    base_limit = None
    offset = 32
    while offset < len(wal):
        if len(wal) - offset < 24:
            raise ReadError("WAL_PARTIAL_FRAME")
        header = wal[offset:offset + 24]
        if header[8:16] != salt:
            # SQLite can reuse a longer WAL after reset, leaving stale frames.
            if commit_size is None:
                raise ReadError("WAL_GENERATION_MISMATCH")
            break
        if len(wal) - offset < 24 + PAGE_SIZE:
            raise ReadError("WAL_PARTIAL_FRAME")
        pgno, db_pages = struct.unpack_from(">II", header)
        if pgno == 0 or pgno * PAGE_SIZE > max_bytes or db_pages * PAGE_SIZE > max_bytes:
            raise ReadError("WAL_PAGE_BOUNDS")
        page = wal[offset + 24:offset + 24 + PAGE_SIZE]
        state = wal_checksum(header[:8] + page, endian, state)
        if state != struct.unpack_from(">II", header, 16):
            raise ReadError("WAL_FRAME_CHECKSUM")
        pages[pgno] = page
        if db_pages:
            if pgno > db_pages:
                raise ReadError("WAL_COMMIT_BOUNDS")
            # Forget pages truncated by a commit, even if a later one grows.
            pages = {n: p for n, p in pages.items() if n <= db_pages}
            committed = pages.copy()
            commit_size = db_pages
            base_limit = db_pages if base_limit is None else min(base_limit, db_pages)
        offset += 24 + PAGE_SIZE
    return WalOverlay(committed, commit_size, base_limit)


def decode_snapshot(main: bytes, wal: bytes, decode_page: Callable[[bytes, int], bytes],
                    *, max_bytes: int) -> bytearray:
    """Caller must supply a coherently captured, immutable main/WAL pair.

    max_bytes is an explicit research limit, not a promise about peak memory.
    WAL validation uses the raw-byte layout only; unsupported layouts fail.
    """
    if max_bytes < PAGE_SIZE or max_bytes > 0x7FFFFFFF:
        raise ReadError("SNAPSHOT_LIMIT")
    if not main or len(main) % PAGE_SIZE or len(main) + len(wal) > max_bytes:
        raise ReadError("MAIN_SIZE_OR_BUDGET")
    overlay = committed_wal_pages(wal, max_bytes)
    overlays, commit_size = overlay.pages, overlay.size
    original_pages = len(main) // PAGE_SIZE
    size = commit_size if commit_size is not None else original_pages
    base_limit = min(original_pages, overlay.base_limit) if overlay.base_limit is not None else original_pages
    if any(n not in overlays for n in range(base_limit + 1, size + 1)):
        raise ReadError("SNAPSHOT_MISSING_PAGE")
    result = bytearray()
    try:
        for n in range(1, size + 1):
            encoded = overlays.get(n, main[(n - 1) * PAGE_SIZE:n * PAGE_SIZE])
            page = decode_page(encoded, n)
            if len(page) != PAGE_SIZE:
                raise ReadError("DECODED_PAGE_SIZE")
            result.extend(page)
        if result[:16] != SQLITE_HEADER or result[16:18] != struct.pack(">H", PAGE_SIZE):
            raise ReadError("SQLITE_HEADER_UNSUPPORTED")
        if result[18] not in (1, 2) or result[19] not in (1, 2):
            raise ReadError("SQLITE_MODE_UNSUPPORTED")
        if commit_size is not None:
            result[28:32] = struct.pack(">I", size)
            result[92:96] = result[24:28]
        # sqlite3_deserialize cannot reopen a WAL-backed image; overlay first.
        result[18:20] = b"\x01\x01"
        return result
    except BaseException:
        result[:] = bytes(len(result))
        raise


class MemoryDatabase:
    """Only :memory: + deserialize; no plaintext-file or temp-file fallback."""

    def __init__(self, image: bytes | bytearray):
        self._conn = None
        if not hasattr(sqlite3.Connection, "deserialize"):
            raise ReadError("SQLITE_DESERIALIZE_REQUIRED")
        try:
            self._conn = sqlite3.connect(":memory:", cached_statements=0)
            self._conn.enable_load_extension(False)
            self._conn.execute("PRAGMA temp_store=MEMORY")
            self._conn.execute("PRAGMA trusted_schema=OFF")
            self._conn.deserialize(image)
            self._conn.execute("PRAGMA query_only=ON")
            if self._conn.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ReadError("SQLITE_INTEGRITY_FAILED")
            self._conn.row_factory = sqlite3.Row
            self._conn.set_authorizer(self._authorize)
        except sqlite3.Error:
            self.close()
            raise ReadError("SQLITE_SNAPSHOT_OPEN_FAILED") from None
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _authorize(action, arg1, arg2, _database, _trigger):
        if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_RECURSIVE):
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_FUNCTION and arg2 in {"count", "min", "max", "length", "coalesce"}:
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY

    def query(self, sql: str, params=()):
        if self._conn is None:
            raise ReadError("SQLITE_CLOSED")
        try:
            return self._conn.execute(sql, params).fetchall()
        except sqlite3.Error:
            raise ReadError("SQLITE_QUERY_FAILED") from None

    def close(self):
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


@dataclass(frozen=True, order=True)
class Cursor:
    sort_seq: int
    local_id: int

    def __post_init__(self):
        if type(self.sort_seq) is not int or type(self.local_id) is not int or min(self.sort_seq, self.local_id) < 0:
            raise ReadError("CURSOR_INVALID")


@dataclass(frozen=True, repr=False)
class Shard:
    account: str
    shard_id: str
    generation: str
    image: bytes | bytearray = field(repr=False)


@dataclass(frozen=True, repr=False)
class Message:
    event_id: str
    account: str
    group: str
    shard_id: str
    cursor: Cursor
    server_id: int
    kind: int
    sender_id: int
    timestamp: int
    # SQLite storage values remain raw; decoding is a separate opt-in step.
    content: str | bytes | int | float | None
    compressed_content: str | bytes | int | float | None


def message_event_id(account, group, shard_id, generation, server_id, local_id):
    """One identity rule shared by the reader and its local receipt validator."""
    identity = ("server", str(server_id)) if server_id > 0 else (
        "local", shard_id, generation, str(local_id))
    fields = ("wechat", account, group, *identity)
    encoded = b"".join(struct.pack(">I", len(v.encode())) + v.encode() for v in fields)
    return hashlib.sha256(encoded).hexdigest()


class Reader:
    """Explicit manifest + per-shard/group cursors, acknowledge whole batches.

    sink must transactionally accept raw events AND next cursors before True.
    False/exception leaves cursors unchanged; retry reuses event IDs. The live
    receipts.py supplies an opt-in isolated local prototype, not a business bridge.
    """

    def __init__(self, scope: Scope, manifest: Mapping[str, str],
                 cursors: Mapping[tuple[str, str], Cursor], *, allow_missing_groups=False):
        if not manifest or any(not isinstance(s, str) or not isinstance(g, str) or not s or not g
                               for s, g in manifest.items()):
            raise ReadError("EXPLICIT_SHARD_MANIFEST_REQUIRED")
        expected = {(s, g) for s in manifest for g in scope.groups}
        if set(cursors) != expected or any(not isinstance(c, Cursor) for c in cursors.values()):
            raise ReadError("EXPLICIT_ALL_CURSORS_REQUIRED")
        self._scope, self._manifest, self._cursors = scope, dict(manifest), dict(cursors)
        self._allow_missing_groups = allow_missing_groups is True
        self._lock = threading.Lock()

    @property
    def scope(self):
        return self._scope  # Scope is frozen; callers cannot expand its groups.

    @property
    def manifest(self):
        return self._manifest.copy()

    @property
    def cursors(self):
        return self._cursors.copy()

    def deliver(self, shards: tuple[Shard, ...], sink: Callable,
                *, limit: int) -> tuple[Message, ...]:
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ReadError("BATCH_LIMIT")
        if not self._lock.acquire(blocking=False):
            raise ReadError("READ_ALREADY_RUNNING")
        try:
            return self._deliver(shards, sink, limit)
        finally:
            self._lock.release()

    def _deliver(self, shards: tuple[Shard, ...], sink: Callable, limit: int):
        if len(shards) != len(self._manifest) or {s.shard_id for s in shards} != set(self._manifest):
            raise ReadError("SHARD_MANIFEST_MISMATCH")
        for shard in shards:
            self._scope.check_account(shard.account)
            if shard.generation != self._manifest[shard.shard_id]:
                raise ReadError("SHARD_GENERATION_CHANGED")
            if type(shard.image) is not bytes:
                raise ReadError("IMMUTABLE_SNAPSHOT_REQUIRED")
        messages: list[Message] = []
        found = set()
        for shard in shards:
            with MemoryDatabase(shard.image) as db:
                for group in self._scope.groups:
                    table = "Msg_" + hashlib.md5(group.encode("utf-8")).hexdigest()
                    tables = db.query("SELECT type FROM sqlite_master WHERE name=?", (table,))
                    if not tables:
                        continue  # Group can be stored in a different shard.
                    if len(tables) != 1 or tables[0][0] != "table":
                        raise ReadError("MESSAGE_TABLE_UNSUPPORTED")
                    found.add(group)
                    cursor = self._cursors[(shard.shard_id, group)]
                    rows = db.query(
                        f'SELECT local_id, sort_seq, server_id, local_type, real_sender_id, '
                        f'create_time, message_content, compress_content FROM "{table}" '
                        'WHERE sort_seq > ? OR (sort_seq = ? AND local_id > ?) '
                        'ORDER BY sort_seq ASC, local_id ASC LIMIT ?',
                        (cursor.sort_seq, cursor.sort_seq, cursor.local_id, limit))
                    previous = cursor
                    for row in rows:
                        try:
                            current = Cursor(row["sort_seq"], row["local_id"])
                            server_id, kind, sender, ts = (row[k] for k in
                                ("server_id", "local_type", "real_sender_id", "create_time"))
                            if any(type(v) is not int for v in (server_id, kind, sender, ts)):
                                raise ReadError("MESSAGE_SCHEMA_UNSUPPORTED")
                            if current <= previous or current.local_id == 0:
                                raise ReadError("MESSAGE_CURSOR_NOT_UNIQUE")
                            event_id = message_event_id(self._scope.account, group,
                                shard.shard_id, shard.generation, server_id, current.local_id)
                            messages.append(Message(event_id, self._scope.account, group,
                                shard.shard_id, current, server_id, kind, sender, ts,
                                row["message_content"], row["compress_content"]))
                            previous = current
                        except (ValueError, TypeError, OverflowError):
                            raise ReadError("MESSAGE_SCHEMA_UNSUPPORTED") from None
        if found != set(self._scope.groups) and not self._allow_missing_groups:
            raise ReadError("SELECTED_GROUP_NOT_FOUND")
        messages.sort(key=lambda m: (m.cursor.sort_seq, m.cursor.local_id, m.shard_id, m.group))
        batch = tuple(messages[:limit])
        if not batch:
            return ()
        next_cursors = self._cursors.copy()
        for msg in batch:
            next_cursors[(msg.shard_id, msg.group)] = msg.cursor
        try:
            accepted = sink(batch, next_cursors.copy())
        except Exception:
            raise ReadError("BATCH_NOT_ACKNOWLEDGED") from None
        if accepted is not True:
            raise ReadError("BATCH_NOT_ACKNOWLEDGED")
        self._cursors = next_cursors
        return batch
