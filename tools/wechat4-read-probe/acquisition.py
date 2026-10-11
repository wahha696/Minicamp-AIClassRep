"""Explicit, opt-in acquisition building blocks. No automatic live entrypoint.

Cipher object layout is an experimental profile from the pinned candidate;
finding a key does not prove the process's currently logged-in account.
"""
from __future__ import annotations

import ntpath
import hashlib
import re
import struct
import time
from dataclasses import dataclass, field

from native import NativeProcess, ProcessIdentity, normal_path
from reader import PAGE_SIZE, PageCodec, ReadError, Scope, Shard, SQLITE_HEADER, decode_snapshot
from snapshot import SQLITE_WINDOWS_PROFILE, Snapshotter, validate_capture_request

MARKER = b"com.Tencent.WCDB.Config.Cipher"
XOR_MASK = bytes.fromhex("d2c7442458020000004889442450488b450048844c2448488944254048584c24")
HEX_LITERAL = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")


def validate_scan_budget(max_bytes, max_seconds, chunk_bytes=1024 * 1024, max_hits=128):
    if (type(max_bytes) is not int or max_bytes <= 0 or type(max_seconds) not in (int, float)
            or not 0 < max_seconds <= 60 or type(chunk_bytes) is not int
            or not 64 <= chunk_bytes <= 1024 * 1024 or type(max_hits) is not int or not 1 <= max_hits <= 1024):
        raise ReadError("EXPLICIT_SCAN_BUDGET_REQUIRED")


@dataclass(frozen=True, repr=False)
class Consent:
    account: str
    key_read: bool = False
    encrypted_db_read: bool = False
    tool_memory_only_with_os_limit: bool = False

    def check(self, scope: Scope):
        scope.check_account(self.account)
        if (self.key_read is not True or self.encrypted_db_read is not True
                or self.tool_memory_only_with_os_limit is not True):
            raise ReadError("REAL_READ_SCOPE_CONFIRMATION_REQUIRED")


@dataclass(frozen=True, repr=False)
class CipherProfile:
    expected_version: str
    acknowledged_experimental_layout: bool = False

    def check(self, identity: ProcessIdentity):
        if (not re.fullmatch(r"4\.\d+\.\d+\.\d+", self.expected_version)
                or self.acknowledged_experimental_layout is not True):
            raise ReadError("EXPLICIT_EXPERIMENTAL_CIPHER_PROFILE_REQUIRED")
        if identity.version != self.expected_version or ntpath.basename(identity.executable).lower() != "weixin.exe":
            raise ReadError("PROCESS_PATH_OR_VERSION_MISMATCH")


@dataclass(frozen=True, repr=False)
class Candidate:
    material: bytes = field(repr=False)


def validate_target(scope, consent, expected, profile):
    consent.check(scope)
    profile.check(expected)
    if (type(expected.pid) is not int or not 0 < expected.pid <= 0xFFFFFFFF
            or type(expected.created) is not int or expected.created <= 0
            or normal_path(expected.executable) != expected.executable):
        raise ReadError("EXPLICIT_VERIFIED_PROCESS_IDENTITY_REQUIRED")


class KeyScanner:
    def __init__(self, process, expected: ProcessIdentity, *, max_bytes: int, max_seconds: float,
                 chunk_bytes: int = 1024 * 1024, max_hits: int = 128, clock=time.monotonic):
        validate_scan_budget(max_bytes, max_seconds, chunk_bytes, max_hits)
        self._process, self._expected, self._clock = process, expected, clock
        self._remaining, self._deadline = max_bytes, clock() + max_seconds
        self._chunk, self._max_hits = chunk_bytes, max_hits

    def _guard(self):
        if self._clock() > self._deadline:
            raise ReadError("KEY_SCAN_TIME_EXCEEDED")

    def _read(self, address, length):
        self._guard()
        self._remaining -= length
        if self._remaining < 0:
            raise ReadError("KEY_SCAN_BYTE_BUDGET_EXCEEDED")
        data = self._process.read(address, length)
        if len(data) != length:
            raise ReadError("PROCESS_SHORT_READ")
        self._guard()
        return data

    def _find_cipher_references(self):
        # One full traversal. Collect (pointer, length) pairs even when their
        # target marker appears later in address order; join only after scanning.
        # This is the same exact byte pattern as the previous second pass.
        markers, possible = set(), {}
        length_needle = struct.pack("<Q", len(MARKER))
        overlap = max(len(MARKER) - 1, 15)
        pending_limit = min(65536, self._max_hits * 64)
        for base, size in self._process.regions():
            self._guard()
            if not 0x10000 <= base < base + size <= 0x800000000000:
                raise ReadError("PROCESS_REGION_INVALID")
            tail = b""
            for offset in range(0, size, self._chunk):
                block = self._read(base + offset, min(self._chunk, size - offset))
                joined = tail + block
                start = 0
                while True:
                    found = joined.find(MARKER, start)
                    if found < 0:
                        break
                    markers.add(base + offset - len(tail) + found)
                    if len(markers) > self._max_hits:
                        raise ReadError("KEY_MARKER_HIT_LIMIT")
                    start = found + 1
                start = 8
                while True:
                    found = joined.find(length_needle, start)
                    if found < 0:
                        break
                    pointer = struct.unpack_from("<Q", joined, found - 8)[0]
                    if 0x10000 <= pointer < 0x800000000000 - len(MARKER):
                        address = base + offset - len(tail) + found - 8
                        possible[address] = pointer
                        if len(possible) > pending_limit:
                            raise ReadError("KEY_PENDING_REFERENCE_LIMIT")
                    start = found + 1
                tail = joined[-overlap:]
        if not markers:
            raise ReadError("CIPHER_MARKER_NOT_FOUND")
        references = sorted(address for address, pointer in possible.items() if pointer in markers)
        if len(references) > self._max_hits:
            raise ReadError("KEY_REFERENCE_HIT_LIMIT")
        return markers, references

    def candidates(self):
        if self._process.identity() != self._expected:
            raise ReadError("PROCESS_IDENTITY_CHANGED")
        markers, references = self._find_cipher_references()
        result: set[Candidate] = set()
        seen_configs = set()
        for address in references:
            if address < 0x10010:
                continue
            node = self._read(address - 16, 0x50)
            if struct.unpack_from("<Q", node, 0x10)[0] not in markers or struct.unpack_from("<Q", node, 0x18)[0] != len(MARKER):
                continue
            config = struct.unpack_from("<Q", node, 0x28)[0]
            if not 0x10000 <= config < 0x800000000000 - 0xB0:
                continue
            if config in seen_configs:
                continue
            seen_configs.add(config)
            obj = self._read(config + 0x88, 0x28)
            pointer, length = struct.unpack_from("<QQ", obj, 8)
            if not 0 < length <= 1024 or not 0x10000 <= pointer < pointer + length <= 0x800000000000:
                continue
            blob = self._read(pointer, length)
            decoded = bytes(v ^ XOR_MASK[i % len(XOR_MASK)] for i, v in enumerate(blob))
            for match in HEX_LITERAL.finditer(decoded):
                run = match.group(1)
                starts = {0}
                if len(run) > 96:
                    starts.update(range(0, len(run) - 63, 32))
                    starts.add(len(run) - 64)
                for start in sorted(starts):
                    if start + 64 <= len(run):
                        result.add(Candidate(bytes.fromhex(run[start:start + 64].decode("ascii"))))
                    if start + 96 <= len(run):
                        result.add(Candidate(bytes.fromhex(run[start:start + 96].decode("ascii"))))
                    if len(result) > self._max_hits:
                        raise ReadError("KEY_SCAN_CANDIDATE_LIMIT")
        if self._process.identity() != self._expected:
            raise ReadError("PROCESS_IDENTITY_CHANGED")
        if not result:
            raise ReadError("NO_CIPHER_CANDIDATES")
        return frozenset(result)


def scan_explicit_process(scope: Scope, consent: Consent, expected: ProcessIdentity,
                          profile: CipherProfile, *, max_bytes: int, max_seconds: float,
                          process_factory=NativeProcess):
    # Approval and all target validation happen BEFORE opening a read handle.
    validate_target(scope, consent, expected, profile)
    validate_scan_budget(max_bytes, max_seconds)
    with process_factory(expected.pid) as process:
        return KeyScanner(process, expected, max_bytes=max_bytes, max_seconds=max_seconds).candidates()


def match_selected_pages(candidates: frozenset[Candidate], first_pages: dict[str, bytes]):
    """Match ONLY the supplied DB first pages; never search another account.

    This proves key possession for these pages, not an active-login identity.
    Do not log or serialize the returned material. Consumers own its lifetime.
    """
    if not candidates or not first_pages or any(len(p) != PAGE_SIZE for p in first_pages.values()):
        raise ReadError("EXPLICIT_SELECTED_FIRST_PAGES_REQUIRED")
    matches = {}
    for name, page in first_pages.items():
        accepted = set()
        for candidate in candidates:
            material = candidate.material
            if len(material) == 48 and page[:16] != SQLITE_HEADER:
                continue
            try:
                with PageCodec(material, page):
                    accepted.add(material)
            except ReadError as exc:
                if str(exc) != "PAGE_AUTHENTICATION_FAILED":
                    raise
        if len(accepted) != 1:
            raise ReadError("SELECTED_DB_KEY_MISSING_OR_AMBIGUOUS")
        matches[name] = Candidate(accepted.pop())
    return matches


def read_selected_snapshots(scope: Scope, consent: Consent, expected: ProcessIdentity,
                            profile: CipherProfile, *, vfs_profile: str, root: str,
                            selected_databases: dict[str, tuple[str, object]],
                            scan_bytes: int, scan_seconds: float,
                            snapshot_bytes: int, snapshot_seconds: float,
                            scan_hits: int = 128,
                            process_factory=NativeProcess, snapshotter_factory=Snapshotter):
    """Acquire explicit encrypted shards, match keys and decrypt in memory.

    Values are (relative DB path, expected file identity from an approved
    metadata-only selection). No account enumeration, identity guessing, default
    history cursor, message output, durable sink or automatic live polling.
    Shared locks are held only during encrypted capture, not during decryption.
    """
    validate_target(scope, consent, expected, profile)
    validate_scan_budget(scan_bytes, scan_seconds, max_hits=scan_hits)
    if (vfs_profile != SQLITE_WINDOWS_PROFILE or not selected_databases
            or any(not isinstance(name, str) or not name or not isinstance(item, tuple) or len(item) != 2
                   or item[1] is None for name, item in selected_databases.items())):
        raise ReadError("EXPLICIT_DATABASE_IDENTITIES_AND_VFS_REQUIRED")
    for relative, _identity in selected_databases.values():
        validate_capture_request(root, relative, snapshot_bytes, snapshot_seconds)
    # All DB reads must remain under the same held process handle/identity.
    with process_factory(expected.pid) as process:
        candidates = KeyScanner(process, expected, max_bytes=scan_bytes, max_seconds=scan_seconds,
                                max_hits=scan_hits).candidates()
        return capture_selected_shards(scope, process, expected, candidates, root=root,
            selected_databases=selected_databases,
            snapshotter=snapshotter_factory(profile=vfs_profile),
            snapshot_bytes=snapshot_bytes, snapshot_seconds=snapshot_seconds)


def capture_selected_shards(scope, process, expected, candidates, *, root,
                            selected_databases, snapshotter, snapshot_bytes, snapshot_seconds):
    """Internal capture for an already consent-gated, held process session.

    Reusing memory-only candidates avoids scanning the process on every poll.
    Each capture still checks process/file identities and page authentication.
    """
    snapshots = capture_selected_encrypted(process, expected, root=root,
        selected_databases=selected_databases, snapshotter=snapshotter,
        snapshot_bytes=snapshot_bytes, snapshot_seconds=snapshot_seconds)
    return decode_selected_shards(scope, process, expected, candidates, snapshots,
                                  snapshot_bytes=snapshot_bytes)


def capture_selected_encrypted(process, expected, *, root, selected_databases,
                               snapshotter, snapshot_bytes, snapshot_seconds):
    """Always capture/check all explicitly selected encrypted sources; no cache."""
    snapshots = {}
    remaining = snapshot_bytes
    deadline = time.monotonic() + snapshot_seconds
    for name, (relative, identity) in selected_databases.items():
        if process.identity() != expected:
            raise ReadError("PROCESS_IDENTITY_CHANGED")
        seconds = deadline - time.monotonic()
        if seconds <= 0 or remaining < PAGE_SIZE:
            raise ReadError("SNAPSHOT_TOTAL_BUDGET_EXCEEDED")
        snapshots[name] = snapshotter.capture(root, relative, max_bytes=remaining,
            max_seconds=seconds, expected_identity=identity)
        remaining -= len(snapshots[name].main) + len(snapshots[name].wal)
    if process.identity() != expected:
        raise ReadError("PROCESS_IDENTITY_CHANGED")
    return snapshots


def fingerprint_selected_snapshots(snapshots):
    """Digest complete coherent ciphertext + identities/index, never mtime.

    Not authentication: it may only be compared with an in-session fingerprint
    whose bytes have already passed full authentication AND drained delivery.
    """
    from native import FileIdentity
    digest = hashlib.sha256(b"classrep-encrypted-snapshot-v1\x00")
    for name, snap in sorted(snapshots.items()):
        if not isinstance(snap.identity, FileIdentity):
            raise ReadError("NATIVE_FILE_IDENTITY_REQUIRED")
        for data in (name.encode("utf-8"), struct.pack("<QQQ", snap.identity.volume,
                     snap.identity.index, snap.identity.created),
                     struct.pack("<II8sIIB", snap.index.frames, snap.index.pages, snap.index.salt,
                                 *snap.index.checksum, snap.index.endian), snap.main, snap.wal):
            digest.update(struct.pack("<Q", len(data)))
            digest.update(data)
    return digest.digest()


def decode_selected_shards(scope, process, expected, candidates, snapshots, *, snapshot_bytes):
    """Authenticate/decrypt all selected snapshots, after capture locks release."""
    if process.identity() != expected:
        raise ReadError("PROCESS_IDENTITY_CHANGED")
    matched = match_selected_pages(candidates, {name: snap.main[:PAGE_SIZE] for name, snap in snapshots.items()})
    results = []
    for name, snap in snapshots.items():
        with PageCodec(matched[name].material, snap.main[:PAGE_SIZE]) as codec:
            page1 = codec.decrypt(snap.main[:PAGE_SIZE], 1)
            if page1[18:20] != b"\x02\x02":
                raise ReadError("SOURCE_WAL_MODE_REQUIRED")
            plain = decode_snapshot(snap.main, snap.wal, codec.decrypt, max_bytes=snapshot_bytes)
            try:
                from native import FileIdentity
                if not isinstance(snap.identity, FileIdentity):
                    raise ReadError("NATIVE_FILE_IDENTITY_REQUIRED")
                generation = hashlib.sha256(struct.pack("<QQQ", snap.identity.volume,
                    snap.identity.index, snap.identity.created)).hexdigest()
                results.append(Shard(scope.account, name, generation, bytes(plain)))
            finally:
                plain[:] = bytes(len(plain))
    if process.identity() != expected:
        raise ReadError("PROCESS_IDENTITY_CHANGED")
    return tuple(results)
