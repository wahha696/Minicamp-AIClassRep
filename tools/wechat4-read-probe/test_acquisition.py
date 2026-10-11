"""Fake WeChat memory only; native file tests use disposable synthetic SQLite."""
import ctypes
import hashlib
import ntpath
import os
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from acquisition import (Candidate, CipherProfile, Consent, KeyScanner, MARKER, XOR_MASK,
                         match_selected_pages, read_selected_snapshots, scan_explicit_process)
from native import FileIdentity, NativeFile, NativeProcess, ProcessIdentity, normal_path
from reader import PAGE_SIZE, ReadError, Reader, Scope, Cursor, decode_snapshot
from snapshot import SQLITE_WINDOWS_PROFILE, Snapshotter, parse_index
import test_reader as fixtures
from test_reader import (ACCOUNT, GROUP_A, MAX_BYTES, image, make_wal,
                         raw_decode, reserved_image)

ROOT = r"c:\synthetic_account"
RELATIVE = r"message\message_0.db"
IDENTITY = ProcessIdentity(1234, r"c:\synthetic_install\weixin.exe", 123456, "4.1.15.13")


def index_header(wal, frames, pages, change=1, page_size=PAGE_SIZE):
    first = bytearray(40)
    struct.pack_into("<III", first, 0, 3007000, 0, change)
    struct.pack_into("<BBHII", first, 12, 1, 0, page_size, frames, pages)
    first[32:40] = wal[16:24]
    if frames:
        offset = 32 + (frames - 1) * (24 + PAGE_SIZE)
        struct.pack_into("<II", first, 24, *struct.unpack_from(">II", wal, offset + 16))
    # Independent checksum writer, not parse_index's production helper.
    a, b = 0, 0
    words = struct.unpack("<10I", first)
    for offset in range(0, 10, 2):
        a = (a + words[offset] + b) & 0xFFFFFFFF
        b = (b + words[offset + 1] + a) & 0xFFFFFFFF
    copy = bytes(first) + struct.pack("<II", a, b)
    return copy + copy


class FakeFiles:
    def __init__(self, main=None, wal=None):
        main = image() if main is None else main
        wal = make_wal([(2, 2, main[PAGE_SIZE:])]) if wal is None else wal
        self.data = {"": main, "-wal": wal, "-shm": index_header(wal, 1, 2)}
        self.identities = {s: FileIdentity(1, i, 3) for i, s in enumerate(self.data, 1)}
        self.opened, self.closed, self.locks = [], [], []
        self.events = []
        self.fail_lock = None
        self.redirect = None
        self.root_redirect = None
        self.read_hook = None

    def __call__(self, path, directory=False):
        host = self
        suffix = None if directory else path[len(ntpath.join(ROOT, RELATIVE)):]
        if not directory and suffix not in host.data:
            raise ReadError("FILE_OPEN_READ_FAILED")
        host.opened.append(path)
        class File:
            def __init__(self):
                self.path = host.root_redirect if directory and host.root_redirect else normal_path(path)
                if not directory and host.redirect == suffix:
                    self.path = r"c:\outside_scope\other.db"
                self._identity = None if directory else host.identities[suffix]
            def identity(self):
                return self._identity
            def final_path(self):
                return self.path
            def size(self):
                return len(host.data[suffix])
            def read(self, offset, count):
                host.events.append(("read", suffix, offset, count))
                if host.read_hook:
                    host.read_hook(host, suffix, offset, count)
                result = host.data[suffix][offset:offset + count]
                if len(result) != count:
                    raise ReadError("FILE_SHORT_READ")
                return result
            @contextmanager
            def shared_lock(self, offset, count):
                if offset == host.fail_lock:
                    raise ReadError("SNAPSHOT_LOCK_BUSY")
                host.locks.append((offset, count))
                try:
                    yield
                finally:
                    host.locks.remove((offset, count))
            def __enter__(self):
                return self
            def __exit__(self, *_):
                host.closed.append(path)
        return File()


class FakeProcess:
    def __init__(self, *, identity=IDENTITY, key=None, marker_offset=125, literal=None):
        self._identity = identity
        self.base, self.memory = 0x10000, bytearray(4096)
        self.calls, self.closed = [], False
        self.identity_calls, self.identity_changes_after = 0, None
        self.short_read = False
        self.key = bytes(range(32)) if key is None else key
        marker = self.base + marker_offset
        self.memory[marker_offset:marker_offset + len(MARKER)] = MARKER
        # Artificial candidate profile: node/name, config object, XOR hex blob.
        node, config, blob = 512, 1024, 2048
        struct.pack_into("<QQ", self.memory, node + 16, marker, len(MARKER))
        struct.pack_into("<Q", self.memory, node + 40, self.base + config)
        raw = literal if literal is not None else b"x'" + self.key.hex().encode() + b"'"
        encoded = bytes(v ^ XOR_MASK[i % len(XOR_MASK)] for i, v in enumerate(raw))
        struct.pack_into("<QQ", self.memory, config + 0x88 + 8, self.base + blob, len(encoded))
        self.memory[blob:blob + len(encoded)] = encoded
    def identity(self):
        self.identity_calls += 1
        if self.identity_changes_after is not None and self.identity_calls > self.identity_changes_after:
            return ProcessIdentity(self._identity.pid, self._identity.executable, self._identity.created + 1, self._identity.version)
        return self._identity
    def regions(self):
        yield self.base, len(self.memory)
    def read(self, address, length):
        self.calls.append((address, length))
        result = bytes(self.memory[address - self.base:address - self.base + length])
        return result[:-1] if self.short_read else result
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.closed = True


class ScannerTests(unittest.TestCase):
    def test_marker_across_chunks_yields_only_in_memory_candidates(self):
        process = FakeProcess(marker_offset=125)
        candidates = KeyScanner(process, IDENTITY, max_bytes=20000, max_seconds=5, chunk_bytes=128).candidates()
        self.assertIn(Candidate(process.key), candidates)
        self.assertNotIn(process.key.hex(), repr(candidates))
        self.assertLessEqual(max(length for _, length in process.calls), 128)

    def test_96_hex_raw_key_and_salt_both_preserved(self):
        key, salt = bytes(range(32)), bytes(range(16))
        process = FakeProcess(literal=b"X'" + (key + salt).hex().encode() + b"'")
        candidates = KeyScanner(process, IDENTITY, max_bytes=20000, max_seconds=5).candidates()
        self.assertIn(Candidate(key), candidates)
        self.assertIn(Candidate(key + salt), candidates)

    def test_scan_byte_time_and_hit_limits_do_not_return_partial_results(self):
        process = FakeProcess()
        with self.assertRaisesRegex(ReadError, "BYTE_BUDGET"):
            KeyScanner(process, IDENTITY, max_bytes=128, max_seconds=5, chunk_bytes=128).candidates()
        with self.assertRaisesRegex(ReadError, "TIME_EXCEEDED"):
            scanner = KeyScanner(process, IDENTITY, max_bytes=20000, max_seconds=1, clock=iter((0, 2)).__next__)
            scanner.candidates()
        process.memory[3000:3000 + len(MARKER)] = MARKER
        with self.assertRaisesRegex(ReadError, "HIT_LIMIT"):
            KeyScanner(process, IDENTITY, max_bytes=20000, max_seconds=5, max_hits=1).candidates()

    def test_short_reads_and_process_restart_are_fatal(self):
        process = FakeProcess()
        process.short_read = True
        with self.assertRaisesRegex(ReadError, "PROCESS_SHORT_READ"):
            KeyScanner(process, IDENTITY, max_bytes=20000, max_seconds=5).candidates()
        process = FakeProcess()
        process.identity_changes_after = 1
        with self.assertRaisesRegex(ReadError, "PROCESS_IDENTITY_CHANGED"):
            KeyScanner(process, IDENTITY, max_bytes=20000, max_seconds=5).candidates()

    def test_permissions_target_and_profile_fail_before_process_open(self):
        scope = Scope(ACCOUNT, (GROUP_A,))
        cases = (
            (Consent(ACCOUNT), IDENTITY, CipherProfile("4.1.15.13", True)),
            (Consent("other", True, True, True), IDENTITY, CipherProfile("4.1.15.13", True)),
            (Consent(ACCOUNT, True, True, True), IDENTITY, CipherProfile("4.1.15.13")),
            (Consent(ACCOUNT, True, True, True), IDENTITY, CipherProfile("4.1.16.1", True)),
            (Consent(ACCOUNT, True, True, True), ProcessIdentity(1234, r"c:\synthetic\wechat.exe", 1, "3.9.12.51"), CipherProfile("3.9.12.51", True)),
        )
        for consent, identity, profile in cases:
            with self.subTest(profile=profile.expected_version):
                with patch("acquisition.NativeProcess", side_effect=AssertionError("must not open")) as factory:
                    with self.assertRaises(ReadError):
                        scan_explicit_process(scope, consent, identity, profile, max_bytes=20000,
                                              max_seconds=5, process_factory=factory)
                    factory.assert_not_called()

    def test_explicit_single_pid_is_closed_after_scan(self):
        process = FakeProcess()
        pids = []
        def factory(pid):
            pids.append(pid)
            return process
        result = scan_explicit_process(Scope(ACCOUNT, (GROUP_A,)), Consent(ACCOUNT, True, True, True),
            IDENTITY, CipherProfile(IDENTITY.version, True), max_bytes=20000, max_seconds=5,
            process_factory=factory)
        self.assertTrue(result)
        self.assertEqual([1234], pids)
        self.assertTrue(process.closed)

    def test_identity_mismatch_reads_no_memory(self):
        process = FakeProcess(identity=ProcessIdentity(1234, IDENTITY.executable, 999, IDENTITY.version))
        with self.assertRaisesRegex(ReadError, "PROCESS_IDENTITY_CHANGED"):
            KeyScanner(process, IDENTITY, max_bytes=20000, max_seconds=5).candidates()
        self.assertEqual([], process.calls)

    def test_complete_acquisition_validates_paths_and_budgets_before_open(self):
        scope, consent = Scope(ACCOUNT, (GROUP_A,)), Consent(ACCOUNT, True, True, True)
        for path, scan_bytes, snapshot_bytes in (("../other.db", 20000, MAX_BYTES),
                                                (RELATIVE, 0, MAX_BYTES), (RELATIVE, 20000, 1)):
            with patch("acquisition.NativeProcess") as factory:
                with self.assertRaises(ReadError):
                    read_selected_snapshots(scope, consent, IDENTITY, CipherProfile(IDENTITY.version, True),
                        vfs_profile=SQLITE_WINDOWS_PROFILE, root=ROOT,
                        selected_databases={"shard_A": (path, FileIdentity(1, 1, 1))},
                        scan_bytes=scan_bytes, scan_seconds=5, snapshot_bytes=snapshot_bytes, snapshot_seconds=5,
                        process_factory=factory)
                factory.assert_not_called()


class CaptureTests(unittest.TestCase):
    def capture(self, files, **kwargs):
        return Snapshotter(profile=SQLITE_WINDOWS_PROFILE, files=files).capture(ROOT, RELATIVE,
            max_bytes=MAX_BYTES, max_seconds=5, **kwargs)

    def assert_clean(self, files):
        self.assertEqual([], files.locks)
        self.assertEqual(sorted(files.opened), sorted(files.closed))

    def test_valid_index_and_exact_committed_prefix(self):
        files = FakeFiles()
        snap = self.capture(files)
        self.assertEqual(files.data[""], snap.main)
        self.assertEqual(files.data["-wal"], snap.wal)
        self.assertEqual(1, snap.index.frames)
        self.assert_clean(files)

    def test_initialized_zero_frame_zero_page_size_ignores_physical_wal(self):
        files = FakeFiles()
        # Physical WAL has a valid old commit but current initialized SHM
        # publishes no frames. Never resurrect the old WAL transaction.
        files.data["-shm"] = index_header(files.data["-wal"], 0, 0, page_size=0)
        snap = self.capture(files)
        self.assertEqual(0, snap.index.frames)
        self.assertEqual(b"", snap.wal)
        self.assertEqual(files.data[""], snap.main)
        self.assertFalse(any(e[1] == "-wal" for e in files.events))
        self.assert_clean(files)

    def test_zero_page_size_requires_initialized_valid_checksum_empty_index(self):
        for frames, pages in ((1, 0), (1, 2), (0, 2)):
            files = FakeFiles()
            files.data["-shm"] = index_header(files.data["-wal"], frames, pages, page_size=0)
            with self.assertRaisesRegex(ReadError, "WAL_INDEX_UNSUPPORTED"):
                self.capture(files)
            self.assert_clean(files)
        for offset in (12, 40, 48):
            files = FakeFiles()
            h = bytearray(index_header(files.data["-wal"], 0, 0, page_size=0))
            h[offset] ^= 1
            files.data["-shm"] = bytes(h)
            with self.assertRaises(ReadError):
                self.capture(files)
            self.assert_clean(files)

    def test_first_commit_during_empty_capture_only_appears_in_next_snapshot(self):
        old = image({GROUP_A: [(1, 40, 1001, "old")]})
        new = image({GROUP_A: [(1, 40, 1001, "new")]})
        files = FakeFiles(old)
        files.data["-shm"] = index_header(files.data["-wal"], 0, 0, page_size=0)
        def commit(host, suffix, _offset, _count):
            if suffix == "":
                host.data["-wal"] = make_wal([(2, 2, new[PAGE_SIZE:])])
                host.data["-shm"] = index_header(host.data["-wal"], 1, 2, change=2)
                host.read_hook = None
        files.read_hook = commit
        snap = self.capture(files)
        self.assertEqual(b"", snap.wal)
        self.assertEqual(old, snap.main)
        later = self.capture(files)
        self.assertEqual(1, later.index.frames)
        self.assertEqual(new, bytes(decode_snapshot(later.main, later.wal, raw_decode, max_bytes=MAX_BYTES)))
        self.assert_clean(files)

    def test_writer_append_after_index_read_does_not_move_snapshot_boundary(self):
        old = image({GROUP_A: [(1, 40, 1001, "old")]})
        new = image({GROUP_A: [(1, 40, 1001, "new")]})
        files = FakeFiles(old)
        original_wal = files.data["-wal"]
        def append(host, suffix, _offset, _count):
            if suffix == "":
                host.data["-wal"] = make_wal([(2, 2, old[PAGE_SIZE:]), (2, 2, new[PAGE_SIZE:])])
                host.data["-shm"] = index_header(host.data["-wal"], 2, 2, change=2)
                host.read_hook = None
        files.read_hook = append
        snap = self.capture(files)
        self.assertEqual(original_wal, snap.wal)
        self.assertEqual(1, snap.index.frames)
        self.assert_clean(files)

    def test_checkpoint_or_reset_lock_conflict_releases_all_handles(self):
        for lock in (0x40000002, 123, 124):
            files = FakeFiles()
            files.fail_lock = lock
            with self.assertRaisesRegex(ReadError, "LOCK_BUSY"):
                self.capture(files)
            self.assert_clean(files)

    def test_file_generation_change_and_redirect_fail_closed(self):
        files = FakeFiles()
        with self.assertRaisesRegex(ReadError, "DB_GENERATION_CHANGED"):
            self.capture(files, expected_identity=FileIdentity(99, 99, 99))
        self.assert_clean(files)
        for suffix in ("", "-wal", "-shm"):
            files = FakeFiles()
            files.redirect = suffix
            with self.assertRaisesRegex(ReadError, "FINAL_PATH_MISMATCH"):
                self.capture(files)
            self.assertFalse(any(e[0] == "read" for e in files.events))
            self.assert_clean(files)

    def test_index_duplicate_checksum_and_last_commit_must_match(self):
        for offset in (0, 40, 48):
            files = FakeFiles()
            header = bytearray(files.data["-shm"])
            header[offset] ^= 1
            files.data["-shm"] = bytes(header)
            with self.assertRaises(ReadError):
                self.capture(files)
            self.assert_clean(files)
        files = FakeFiles()
        files.data["-shm"] = index_header(files.data["-wal"], 1, 3)
        with self.assertRaisesRegex(ReadError, "WAL_COMMIT_INDEX_MISMATCH"):
            self.capture(files)
        self.assert_clean(files)

    def test_no_shm_never_falls_back_to_main_only(self):
        files = FakeFiles()
        del files.data["-shm"]
        with self.assertRaisesRegex(ReadError, "FILE_OPEN_READ_FAILED"):
            self.capture(files)
        self.assert_clean(files)

    def test_source_generation_change_during_read_discards_snapshot(self):
        files = FakeFiles()
        def replace(host, suffix, _offset, _count):
            if suffix == "":
                host.identities[""] = FileIdentity(1, 1000, 3)
        files.read_hook = replace
        with self.assertRaisesRegex(ReadError, "SOURCE_CHANGED"):
            self.capture(files)
        self.assert_clean(files)

    def test_invalid_relative_paths_and_vfs_are_rejected(self):
        for path in ("../other.db", "..\\other.db", "C:\\other.db", "other.db:stream", "other.txt"):
            files = FakeFiles()
            with self.assertRaises(ReadError):
                Snapshotter(profile=SQLITE_WINDOWS_PROFILE, files=files).capture(ROOT, path,
                    max_bytes=MAX_BYTES, max_seconds=5)
            self.assertEqual([], files.opened)
        with self.assertRaises(ReadError):
            Snapshotter(profile="guessed_wechat_vfs")

    def test_redirected_account_root_is_rejected_without_reading_child_files(self):
        files = FakeFiles()
        files.root_redirect = r"c:\another_account"
        with self.assertRaisesRegex(ReadError, "ACCOUNT_ROOT_REDIRECTED"):
            self.capture(files)
        self.assertEqual(1, len(files.opened))
        self.assertEqual([], files.events)
        self.assert_clean(files)

    def test_elapsed_time_budget_releases_locks_and_handles(self):
        files = FakeFiles()
        snapshotter = Snapshotter(profile=SQLITE_WINDOWS_PROFILE, files=files, clock=iter((0, 2)).__next__)
        with self.assertRaisesRegex(ReadError, "TIME_EXCEEDED"):
            snapshotter.capture(ROOT, RELATIVE, max_bytes=MAX_BYTES, max_seconds=1)
        self.assert_clean(files)


@unittest.skipUnless(sys.platform == "win32", "Windows CNG and file locks required")
class IntegrationTests(unittest.TestCase):
    def test_native_reopened_quiet_database_has_readable_empty_index(self):
        research = Path(__file__).resolve().parents[2] / ".review-research"
        research.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="synthetic-cold-wal-", dir=research) as folder:
            target = Path(folder) / "synthetic.db"
            with sqlite3.connect(str(target)) as initial:
                initial.execute("PRAGMA page_size=4096")
                initial.execute("CREATE TABLE synthetic(value INTEGER)")
                initial.execute("INSERT INTO synthetic VALUES (1)")
            initial.close()
            writer = sqlite3.connect(str(target), timeout=0)
            try:
                self.assertEqual("wal", writer.execute("PRAGMA journal_mode=WAL").fetchone()[0])
                self.assertEqual([(1,)], writer.execute("SELECT value FROM synthetic").fetchall())
                with NativeFile(str(target) + "-shm") as shm:
                    header = shm.read(0, 96)
                self.assertEqual(0, struct.unpack_from("<H", header, 14)[0])
                self.assertEqual(0, parse_index(header).frames)
                snap = Snapshotter(profile=SQLITE_WINDOWS_PROFILE).capture(
                    folder, "synthetic.db", max_bytes=MAX_BYTES, max_seconds=5)
                from reader import MemoryDatabase
                with MemoryDatabase(decode_snapshot(snap.main, snap.wal, raw_decode, max_bytes=MAX_BYTES)) as db:
                    self.assertEqual([1], [r[0] for r in db.query("SELECT value FROM synthetic")])
                writer.execute("INSERT INTO synthetic VALUES (2)")
                writer.commit()
                snap = Snapshotter(profile=SQLITE_WINDOWS_PROFILE).capture(
                    folder, "synthetic.db", max_bytes=MAX_BYTES, max_seconds=5)
                self.assertGreater(snap.index.frames, 0)
                with MemoryDatabase(decode_snapshot(snap.main, snap.wal, raw_decode, max_bytes=MAX_BYTES)) as db:
                    self.assertEqual([1, 2], [r[0] for r in db.query("SELECT value FROM synthetic ORDER BY value")])
            finally:
                writer.close()

    def test_native_process_api_reads_only_this_tests_own_artificial_buffer(self):
        buffer = ctypes.create_string_buffer(b"SYNTHETIC_CNG_PROBE_ONLY", 24)
        with NativeProcess(os.getpid()) as process:
            identity = process.identity()
            self.assertEqual(os.getpid(), identity.pid)
            self.assertGreater(identity.created, 0)
            self.assertEqual(buffer.raw, process.read(ctypes.addressof(buffer), len(buffer)))
        self.assertIsNone(process._handle)

    def test_fake_key_scan_encrypted_wal_capture_and_selected_group_read(self):
        key, salt = bytes(range(32)), bytes(range(16))
        old = bytearray(reserved_image())
        old[18:20] = b"\x02\x02"
        encrypt = fixtures.CipherTests.encrypt_test_page
        encrypted = b"".join(encrypt(key, salt, bytes(old[o:o + PAGE_SIZE]), o // PAGE_SIZE + 1)
                             for o in range(0, len(old), PAGE_SIZE))
        wal = make_wal([(2, 2, encrypted[PAGE_SIZE:])])
        files = FakeFiles(encrypted, wal)
        process = FakeProcess(key=key)
        def snapshotter_factory(**kwargs):
            return Snapshotter(files=files, **kwargs)
        snapshots = read_selected_snapshots(Scope(ACCOUNT, (GROUP_A,)), Consent(ACCOUNT, True, True, True),
            IDENTITY, CipherProfile(IDENTITY.version, True), vfs_profile=SQLITE_WINDOWS_PROFILE,
            root=ROOT, selected_databases={"shard_A": (RELATIVE, files.identities[""])},
            scan_bytes=20000, scan_seconds=5, snapshot_bytes=MAX_BYTES, snapshot_seconds=5,
            process_factory=lambda _: process, snapshotter_factory=snapshotter_factory)
        reader = Reader(Scope(ACCOUNT, (GROUP_A,)), {s.shard_id: s.generation for s in snapshots},
                        {("shard_A", GROUP_A): Cursor(0, 0)})
        events = reader.deliver(snapshots, lambda *_: True, limit=10)
        self.assertEqual("synthetic message", events[0].content)
        self.assertTrue(process.closed)
        self.assertEqual([], files.locks)

    def test_missing_selected_key_never_searches_other_account(self):
        key, salt = bytes(range(32)), bytes(range(16))
        page = fixtures.CipherTests.encrypt_test_page(key, salt, reserved_image()[:PAGE_SIZE], 1)
        with self.assertRaisesRegex(ReadError, "SELECTED_DB_KEY_MISSING_OR_AMBIGUOUS"):
            match_selected_pages(frozenset({Candidate(bytes(32))}), {"explicit_db": page})

    def test_native_sqlite_append_allowed_checkpoint_and_reset_deferred_then_release(self):
        # Only synthetic DB files under the ignored workspace research root.
        research = Path(__file__).resolve().parents[2] / ".review-research"
        research.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="synthetic-wal-locks-", dir=research) as folder:
            self.assertTrue(Path(folder).resolve().is_relative_to(research.resolve()))
            target = Path(folder) / "synthetic.db"
            writer = sqlite3.connect(str(target), timeout=0)
            try:
                writer.execute("PRAGMA page_size=4096")
                self.assertEqual("wal", writer.execute("PRAGMA journal_mode=WAL").fetchone()[0])
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("CREATE TABLE synthetic(value INTEGER)")
                writer.execute("INSERT INTO synthetic VALUES (1)")
                writer.commit()
                with NativeFile(str(target)) as main, NativeFile(str(target) + "-shm") as shm:
                    with main.shared_lock(0x40000002, 510), shm.shared_lock(123, 1), shm.shared_lock(124, 1):
                        before = target.read_bytes()
                        writer.execute("INSERT INTO synthetic VALUES (2)")
                        writer.commit()  # Must still be allowed while read locks held.
                        checkpoint = writer.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
                        self.assertLess(checkpoint[2], checkpoint[1])
                        self.assertEqual(before, target.read_bytes())
                        reset = writer.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                        self.assertEqual(1, reset[0])
                reset = writer.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                self.assertEqual(0, reset[0])
                writer.execute("INSERT INTO synthetic VALUES (3)")
                writer.commit()
                snapshot = Snapshotter(profile=SQLITE_WINDOWS_PROFILE).capture(
                    str(Path(folder)), "synthetic.db", max_bytes=MAX_BYTES, max_seconds=5)
                data = decode_snapshot(snapshot.main, snapshot.wal, raw_decode, max_bytes=MAX_BYTES)
                from reader import MemoryDatabase
                with MemoryDatabase(data) as db:
                    values = db.query("SELECT value FROM synthetic ORDER BY value")
                    self.assertEqual([1, 2, 3], [r[0] for r in values])
            finally:
                writer.close()


if __name__ == "__main__":
    unittest.main()
