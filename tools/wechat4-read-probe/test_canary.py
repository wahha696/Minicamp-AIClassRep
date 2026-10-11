"""Synthetic canary privacy, lifecycle and history-boundary tests only."""
import sqlite3
import struct
import unittest
import io
from contextlib import redirect_stderr
from dataclasses import replace
from unittest.mock import patch

from acquisition import CipherProfile, Consent, KeyScanner, MARKER as CIPHER_MARKER
from canary import CaptureSession, MarkerReceipt, baseline_reader, main, selected_metadata
from reader import Cursor, MemoryDatabase, ReadError, Scope, Shard
from snapshot import SQLITE_WINDOWS_PROFILE, Snapshotter
from test_acquisition import FakeFiles, FakeProcess, IDENTITY, RELATIVE, ROOT
import test_reader as fixtures
from test_reader import (ACCOUNT, GROUP_A, GROUP_B, MAX_BYTES, PAGE_SIZE,
                         image, make_wal, reserved_image, shard)

MARKER = "CLASSREP_TEST_SYNTHETIC"


class CanaryTests(unittest.TestCase):
    def test_baseline_cannot_access_historical_body_columns(self):
        class GuardedDatabase(MemoryDatabase):
            def __init__(self, data):
                super().__init__(data)
                def guard(action, arg1, arg2, database, trigger):
                    if action == sqlite3.SQLITE_READ and arg2 in ("message_content", "compress_content"):
                        return sqlite3.SQLITE_DENY
                    return MemoryDatabase._authorize(action, arg1, arg2, database, trigger)
                self._conn.set_authorizer(guard)
        scope = Scope(ACCOUNT, (GROUP_A,))
        reader = baseline_reader(scope, (shard(image({GROUP_A: [(2, 40, 10, MARKER),
            (3, 40, 11, "historical private text")]})),), database_factory=GuardedDatabase)
        self.assertEqual(Cursor(40, 3), reader.cursors[("shard_A", GROUP_A)])
        receipt = MarkerReceipt(MARKER)
        reader.deliver((shard(image({GROUP_A: [(2, 40, 10, MARKER),
            (3, 40, 11, "historical private text"), (4, 40, 12, MARKER),
            (5, 41, 13, "new unrelated text")]})),), receipt, limit=10)
        self.assertEqual(1, receipt.summary()["marker_count"])
        self.assertNotIn("historical", str(receipt.summary()))
        self.assertNotIn(MARKER, str(receipt.summary()))

    def test_all_shards_have_independent_baseline_and_group_must_exist(self):
        scope = Scope(ACCOUNT, (GROUP_A, GROUP_B))
        shards = (shard(image({GROUP_A: [(1, 10, 1, "old A")]})),
                  shard(image({GROUP_B: []}), name="shard_B", generation="generation_B"))
        reader = baseline_reader(scope, shards)
        self.assertEqual(4, len(reader.cursors))
        self.assertEqual(Cursor(0, 0), reader.cursors[("shard_B", GROUP_B)])
        with self.assertRaisesRegex(ReadError, "SELECTED_GROUP_NOT_FOUND"):
            baseline_reader(scope, shards[:1])
        with self.assertRaisesRegex(ReadError, "SHARD_MANIFEST_MISMATCH"):
            baseline_reader(scope, shards + shards)

    def test_marker_boundaries_and_event_deduplication(self):
        scope = Scope(ACCOUNT, (GROUP_A,))
        reader = baseline_reader(scope, (shard(image({GROUP_A: []})),))
        receipt = MarkerReceipt(MARKER)
        data = image({GROUP_A: [(1, 1, 100, MARKER + "_OTHER"),
            (2, 2, 101, "prefix " + MARKER + " suffix"), (3, 3, 101, MARKER)]})
        reader.deliver((shard(data),), receipt, limit=10)
        self.assertEqual(1, receipt.summary()["marker_count"])
        with self.assertRaisesRegex(ReadError, "EXPLICIT_TEST_MARKER_REQUIRED"):
            MarkerReceipt("arbitrary chat search")

    def test_empty_text_with_compressed_field_is_not_reported_as_decoded(self):
        scope = Scope(ACCOUNT, (GROUP_A,))
        reader = baseline_reader(scope, (shard(image({GROUP_A: []})),))
        receipt = MarkerReceipt(MARKER)
        db = sqlite3.connect(":memory:")
        try:
            db.deserialize(image({GROUP_A: [(1, 1, 100, "")]}))
            table = "Msg_" + fixtures.hashlib.md5(GROUP_A.encode()).hexdigest()
            db.execute(f'UPDATE "{table}" SET compress_content=?', (b"synthetic encoded field",))
            db.commit()
            data = db.serialize()
        finally:
            db.close()
        reader.deliver((shard(data),), receipt, limit=10)
        summary = receipt.summary()
        self.assertTrue(summary["unverified_encoded_content"])
        self.assertEqual(1, summary["events_examined"])
        self.assertEqual(1, summary["empty_content_fields"])
        self.assertEqual(1, summary["nonempty_compressed_fields"])
        self.assertNotIn("synthetic encoded field", str(summary))

    def test_invalid_utf8_is_counted_without_leaking_content(self):
        scope = Scope(ACCOUNT, (GROUP_A,))
        reader = baseline_reader(scope, (shard(image({GROUP_A: []})),))
        receipt = MarkerReceipt(MARKER)
        reader.deliver((shard(image({GROUP_A: [(1, 1, 100, b"private\xff")]})),), receipt, limit=10)
        self.assertEqual(1, receipt.summary()["invalid_utf8_fields"])
        self.assertEqual(1, receipt.summary()["events_examined"])
        self.assertNotIn("private", str(receipt.summary()))

    def test_unmatched_account_and_non_message_db_rejected(self):
        root = ROOT + "\\" + ACCOUNT + "\\db_storage"
        metadata = {"accounts": [{"folder": ACCOUNT, "root": root, "selected": [{
            "relative": "message/message_0.db", "path": root + "\\message\\message_0.db",
            "identity": {"volume": 1, "index": 2, "created": 3}}]}],
            "process": {"pid": IDENTITY.pid, "executable": IDENTITY.executable,
                        "created": IDENTITY.created, "version": IDENTITY.version}}
        self.assertEqual(1, len(selected_metadata(metadata, ACCOUNT)[1]))
        with self.assertRaisesRegex(ReadError, "EXPLICIT_ACCOUNT_SELECTION_REQUIRED"):
            selected_metadata(metadata, "other_account")
        metadata["accounts"][0]["selected"][0]["relative"] = "contact/contact.db"
        with self.assertRaisesRegex(ReadError, "EXPLICIT_MESSAGE_DATABASES_REQUIRED"):
            selected_metadata(metadata, ACCOUNT)

    def test_cli_missing_approval_never_opens_metadata_or_process(self):
        with patch("builtins.open") as opened, patch("canary.NativeProcess") as process, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                main([])
            opened.assert_not_called()
            process.assert_not_called()

    def session(self, process, files, **changes):
        options = dict(root=ROOT, selected_databases={"shard_A": (RELATIVE, files.identities[""])},
            vfs_profile=SQLITE_WINDOWS_PROFILE, scan_bytes=20000, scan_seconds=5,
            snapshot_bytes=MAX_BYTES, snapshot_seconds=5,
            process_factory=lambda _: process,
            snapshotter_factory=lambda **kw: Snapshotter(files=files, **kw))
        options.update(changes)
        return CaptureSession(Scope(ACCOUNT, (GROUP_A,)), Consent(ACCOUNT, True, True, True),
            IDENTITY, CipherProfile(IDENTITY.version, True), **options)

    def fixtures(self):
        class CloseableProcess(FakeProcess):
            def close(self):
                self.closed = True
        process = CloseableProcess()
        old = bytearray(reserved_image())
        old[18:20] = b"\x02\x02"
        encoded = b"".join(fixtures.CipherTests.encrypt_test_page(process.key, bytes(range(16)),
            bytes(old[o:o + PAGE_SIZE]), o // PAGE_SIZE + 1) for o in range(0, len(old), PAGE_SIZE))
        return process, FakeFiles(encoded, make_wal([(2, 2, encoded[PAGE_SIZE:])]))

    def test_session_scans_once_rechecks_identity_and_always_closes(self):
        process, files = self.fixtures()
        session = self.session(process, files)
        with session:
            scan_reads = len(process.calls)
            first, second = session.capture(), session.capture()
            self.assertEqual(len(first), len(second))
            self.assertEqual(scan_reads, len(process.calls))
            process._identity = replace(IDENTITY, created=IDENTITY.created + 1)
            with self.assertRaisesRegex(ReadError, "PROCESS_IDENTITY_CHANGED"):
                session.capture()
        self.assertTrue(process.closed)
        self.assertEqual(frozenset(), session._candidates)
        self.assertEqual([], files.locks)

    def test_failed_scan_closes_handle_and_capture_failure_releases_locks(self):
        process, files = self.fixtures()
        process.short_read = True
        with self.assertRaisesRegex(ReadError, "PROCESS_SHORT_READ"):
            with self.session(process, files):
                self.fail("short read must not enter session")
        self.assertTrue(process.closed)
        process, files = self.fixtures()
        files.fail_lock = 123
        with self.assertRaisesRegex(ReadError, "SNAPSHOT_LOCK_BUSY"):
            with self.session(process, files) as session:
                session.capture()
        self.assertEqual([], files.locks)
        self.assertTrue(process.closed)

    def test_invalid_scope_budget_or_vfs_never_opens_process(self):
        process, files = self.fixtures()
        for changes in ({"scan_bytes": 0}, {"vfs_profile": "guessed"},
                        {"selected_databases": {}}, {"snapshot_seconds": 11}):
            with self.subTest(changes=changes), patch("canary.NativeProcess") as opened:
                with self.assertRaises(ReadError):
                    self.session(process, files, **changes)
                self.assertEqual([], process.calls)
                opened.assert_not_called()

    def test_many_synthetic_references_are_bounded_and_diagnostics_distinguish_phase(self):
        process = FakeProcess()
        pair = struct.pack("<QQ", process.base + 125, len(CIPHER_MARKER))
        process.memory.extend(bytes(32768))
        for index in range(200):
            node = 4096 + 128 * index
            process.memory[node + 16:node + 32] = pair
            struct.pack_into("<Q", process.memory, node + 40, process.base + 1024)
        with self.assertRaisesRegex(ReadError, "^KEY_REFERENCE_HIT_LIMIT$"):
            KeyScanner(process, IDENTITY, max_bytes=100000, max_seconds=5).candidates()
        candidates = KeyScanner(process, IDENTITY, max_bytes=100000, max_seconds=5,
                                max_hits=1024).candidates()
        self.assertEqual(1, len(candidates))
        self.assertEqual(1, process.calls.count((process.base + 1024 + 0x88, 0x28)))
        process.memory[3000:3000 + len(CIPHER_MARKER)] = CIPHER_MARKER
        with self.assertRaisesRegex(ReadError, "^KEY_MARKER_HIT_LIMIT$"):
            KeyScanner(process, IDENTITY, max_bytes=100000, max_seconds=5,
                       max_hits=1).candidates()

    def test_single_pass_handles_reference_before_marker_and_cross_chunk_pair(self):
        process = FakeProcess(marker_offset=3500)
        process.memory[104:184] = process.memory[512:592]
        process.memory[512:592] = bytes(80)
        candidates = KeyScanner(process, IDENTITY, max_bytes=5000, max_seconds=5,
                                chunk_bytes=128).candidates()
        self.assertEqual(1, len(candidates))
        # 4096-byte full traversal once, then only explicit object reads. The
        # approved byte cap would reject the old two full traversal algorithm.
        full_blocks = [(address, length) for address, length in process.calls if length == 128]
        self.assertEqual(32, len(full_blocks))
        self.assertEqual(32, len(set(full_blocks)))

    def test_unresolved_reference_storage_has_a_bound_and_returns_no_partial_result(self):
        process = FakeProcess()
        process.memory.extend(bytes(4096))
        for index in range(65):
            struct.pack_into("<QQ", process.memory, 4096 + index * 16,
                             0x70000 + index * 32, len(CIPHER_MARKER))
        with self.assertRaisesRegex(ReadError, "^KEY_PENDING_REFERENCE_LIMIT$"):
            KeyScanner(process, IDENTITY, max_bytes=10000, max_seconds=5,
                       max_hits=1).candidates()


if __name__ == "__main__":
    unittest.main()
