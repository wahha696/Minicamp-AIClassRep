"""Read-only coherent capture for the explicitly approved SQLite Windows VFS.

Shared main/READ_LOCK(0)/READ_LOCK(1) locks block checkpoint/reset/cleanup,
while allowing WAL append. No creation, SHM writes, SQLite source connection,
mtime heuristic, exclusive writer lock or fallback on missing/invalid SHM.
A checksum-validated initialized mxFrame=0 index legitimately reads main only.
WeChat's actual VFS/layout remains unverified; never select this automatically.
"""
from __future__ import annotations

import ntpath
import struct
import time
from contextlib import ExitStack
from dataclasses import dataclass, field

from native import NativeFile, normal_path
from reader import PAGE_SIZE, ReadError, committed_wal_pages, wal_checksum

SQLITE_WINDOWS_PROFILE = "sqlite-win32-wal-3007000-read-locks"


def validate_capture_request(root, relative, max_bytes, max_seconds):
    root = normal_path(root)
    if (not isinstance(relative, str) or not relative or ntpath.isabs(relative) or ntpath.splitdrive(relative)[0]
            or any(p in ("", ".", "..") for p in relative.replace("/", "\\").split("\\"))
            or ":" in relative or not relative.endswith(".db")):
        raise ReadError("EXPLICIT_RELATIVE_DB_REQUIRED")
    if type(max_bytes) is not int or not PAGE_SIZE <= max_bytes <= 0x7FFFFFFF:
        raise ReadError("SNAPSHOT_LIMIT")
    if type(max_seconds) not in (int, float) or not 0 < max_seconds <= 10:
        raise ReadError("SNAPSHOT_TIME_LIMIT")
    return root


@dataclass(frozen=True, repr=False)
class WalIndex:
    frames: int
    pages: int
    salt: bytes
    checksum: tuple[int, int]
    endian: int


def parse_index(header: bytes):
    if len(header) != 96 or header[:48] != header[48:]:
        raise ReadError("WAL_INDEX_BUSY_OR_INVALID")
    if (struct.unpack_from("<I", header)[0] != 3007000 or header[12] != 1
            or header[13] not in (0, 1)):
        raise ReadError("WAL_INDEX_UNSUPPORTED")
    if wal_checksum(header[:40], "<") != struct.unpack_from("<II", header, 40):
        raise ReadError("WAL_INDEX_CHECKSUM")
    frames, pages = struct.unpack_from("<II", header, 16)
    page_size = struct.unpack_from("<H", header, 14)[0]
    # walIndexRecover starts from a zeroed header; szPage/nPage are assigned
    # when a committed frame is found. A valid initialized empty index may
    # therefore retain zero szPage, even beside stale physical WAL bytes.
    # SQLite specifies mxFrame==0 reads exclusively from the main database.
    if page_size != PAGE_SIZE and not (page_size == 0 and frames == 0 and pages == 0):
        raise ReadError("WAL_INDEX_UNSUPPORTED")
    return WalIndex(frames, pages, header[32:40], struct.unpack_from("<II", header, 24), header[13])


@dataclass(frozen=True, repr=False)
class Snapshot:
    main: bytes = field(repr=False)
    wal: bytes = field(repr=False)
    identity: object = field(repr=False)
    index: WalIndex = field(repr=False)


class Snapshotter:
    def __init__(self, *, profile: str, files=NativeFile, clock=time.monotonic):
        if profile != SQLITE_WINDOWS_PROFILE:
            raise ReadError("EXPLICIT_VFS_PROFILE_REQUIRED")
        self._files, self._clock = files, clock

    def capture(self, root: str, relative: str, *, max_bytes: int, max_seconds: float,
                expected_identity=None):
        # Resolve/validate final root and each opened handle, including junctions.
        root = validate_capture_request(root, relative, max_bytes, max_seconds)
        deadline = self._clock() + max_seconds
        def check_time():
            if self._clock() > deadline:
                raise ReadError("SNAPSHOT_TIME_EXCEEDED")
        def read_all(file, length):
            chunks = []
            for offset in range(0, length, 1024 * 1024):
                check_time()
                chunks.append(file.read(offset, min(1024 * 1024, length - offset)))
            check_time()
            return b"".join(chunks)
        with ExitStack() as stack:
            directory = stack.enter_context(self._files(root, directory=True))
            canonical = directory.path
            if canonical != root:
                raise ReadError("ACCOUNT_ROOT_REDIRECTED")
            main_path = ntpath.join(canonical, relative)
            opened = []
            for suffix in ("", "-shm", "-wal"):
                file = stack.enter_context(self._files(main_path + suffix))
                if file.path != normal_path(main_path + suffix):
                    raise ReadError("DB_FINAL_PATH_MISMATCH")
                opened.append(file)
            main, shm, wal = opened
            identities = [f.identity() for f in opened]
            if expected_identity is not None and identities[0] != expected_identity:
                raise ReadError("DB_GENERATION_CHANGED")
            # Compatible shared locks; all acquisition attempts fail immediately.
            stack.enter_context(main.shared_lock(0x40000002, 510))
            stack.enter_context(shm.shared_lock(123, 1))
            stack.enter_context(shm.shared_lock(124, 1))
            check_time()
            def verify_named_handles():
                if directory.final_path() != canonical:
                    raise ReadError("ACCOUNT_ROOT_CHANGED")
                # A deleted/replaced file's old handle can retain the same
                # textual path. Reopen metadata handles and compare file IDs.
                for original, identity in zip(opened, identities):
                    with self._files(original.path) as current:
                        if current.path != original.path or current.identity() != identity:
                            raise ReadError("SNAPSHOT_SOURCE_CHANGED")
            verify_named_handles()
            index = parse_index(shm.read(0, 96))
            main_size = main.size()
            wal_length = 32 + index.frames * (24 + PAGE_SIZE) if index.frames else 0
            if (not main_size or main_size % PAGE_SIZE or main_size + wal_length > max_bytes
                    or index.pages * PAGE_SIZE > max_bytes or wal.size() < wal_length):
                raise ReadError("SNAPSHOT_SIZE_OR_BUDGET")
            main_bytes = read_all(main, main_size)
            wal_bytes = read_all(wal, wal_length)
            if wal_bytes:
                magic = struct.unpack_from(">I", wal_bytes)[0]
                if wal_bytes[16:24] != index.salt or magic != 0x377F0682 + index.endian:
                    raise ReadError("WAL_INDEX_GENERATION_MISMATCH")
                overlay = committed_wal_pages(wal_bytes, max_bytes)
                if (overlay.size != index.pages or struct.unpack_from(">I", wal_bytes, len(wal_bytes) - PAGE_SIZE - 20)[0] != index.pages
                        or struct.unpack_from(">II", wal_bytes, len(wal_bytes) - PAGE_SIZE - 8) != index.checksum):
                    raise ReadError("WAL_COMMIT_INDEX_MISMATCH")
            later = parse_index(shm.read(0, 96))
            if (later.salt != index.salt or later.frames < index.frames
                    or [f.identity() for f in opened] != identities or main.size() != main_size
                    or any(f.final_path() != f.path for f in opened)):
                raise ReadError("SNAPSHOT_SOURCE_CHANGED")
            verify_named_handles()
            check_time()
            return Snapshot(main_bytes, wal_bytes, identities[0], index)
