"""Disposable synthetic receipts; subprocess crashes never touch WeChat."""
from dataclasses import replace
from pathlib import Path
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import test_canary as canary_fixtures
import test_reader as fixtures
from canary import baseline_reader
from reader import Cursor, ReadError, Reader, Scope
from receipts import LocalReceipts, SUFFIX
from test_reader import ACCOUNT, GROUP_A, GROUP_B, image, shard

MANIFEST = {"shard_A": "generation_A"}
SCOPE = Scope(ACCOUNT, (GROUP_A,))
BASE = {("shard_A", GROUP_A): Cursor(0, 0)}


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        research = Path(__file__).resolve().parents[2] / ".review-research"
        research.mkdir(exist_ok=True)
        self.folder = tempfile.TemporaryDirectory(prefix="synthetic-receipts-", dir=research)
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / ("synthetic" + SUFFIX)
        self.assertTrue(self.path.resolve().is_relative_to(research.resolve()))

    def open(self, *, scope=SCOPE, manifest=MANIFEST, path=None):
        result = LocalReceipts(self.path if path is None else path, scope, manifest,
                               allow_selected_message_storage=True)
        self.addCleanup(result.close)
        return result

    def snapshots(self, rows=None):
        if rows is None:
            rows = [(1, 1, 1001, "synthetic selected text")]
        return (shard(image({GROUP_A: rows, GROUP_B: [(1, 1, 9001, "private unselected")]})),)

    def initialize(self, store, baseline=BASE):
        store.initialize(baseline)
        return store.restore_reader()

    def test_approval_path_guards_precede_file_creation(self):
        for approval in (False, 1, None):
            with self.subTest(approval=approval), patch("receipts.sqlite3.connect") as connect:
                with self.assertRaisesRegex(ReadError, "STORAGE_APPROVAL_REQUIRED"):
                    LocalReceipts(self.path, SCOPE, MANIFEST,
                                  allow_selected_message_storage=approval)
                connect.assert_not_called()
                self.assertFalse(self.path.exists())
        for path in ("relative" + SUFFIX, self.path.with_name("message_0.db"), ":memory:"):
            with self.subTest(path=path), patch("receipts.sqlite3.connect") as connect:
                with self.assertRaisesRegex(ReadError, "EXPLICIT_LOCAL_RECEIPT_FILE_REQUIRED"):
                    self.open(path=path)
                connect.assert_not_called()

    def test_first_activation_saves_only_metadata_not_old_bodies(self):
        baseline = baseline_reader(SCOPE, self.snapshots([(1, 40, 1001, "old private body")]))
        store = self.open()
        store.initialize(baseline.cursors)
        self.assertEqual((), store.stored_messages(limit=100))
        reader = store.restore_reader()
        reader.deliver(self.snapshots([(1, 40, 1001, "old private body"),
            (2, 41, 1002, "new selected")]), store.sink(reader), limit=100)
        store.close()
        self.assertNotIn(b"old private body", self.path.read_bytes())
        self.assertNotIn(b"private unselected", self.path.read_bytes())
        self.assertIn(b"new selected", self.path.read_bytes())

    def test_reopen_uses_saved_cursors_and_accepts_gap_messages_once(self):
        store = self.open()
        reader = self.initialize(store)
        reader.deliver(self.snapshots(), store.sink(reader), limit=100)
        store.close()
        reopened = self.open()
        resumed = reopened.restore_reader()
        self.assertEqual(Cursor(1, 1), resumed.cursors[("shard_A", GROUP_A)])
        snapshots = self.snapshots([(1, 1, 1001, "synthetic selected text"),
                                   (2, 2, 1002, "arrived while closed")])
        self.assertEqual(1, len(resumed.deliver(snapshots, reopened.sink(resumed), limit=100)))
        self.assertEqual((), resumed.deliver(snapshots, reopened.sink(resumed), limit=100))
        self.assertEqual(2, len(reopened.stored_messages(limit=100)))

    def test_exception_between_messages_and_cursors_rolls_back_whole_batch(self):
        store = self.open()
        reader = self.initialize(store)
        with patch.object(store, "_checkpoint", side_effect=OSError("synthetic private failure")):
            with self.assertRaisesRegex(ReadError, "^BATCH_NOT_ACKNOWLEDGED$"):
                reader.deliver(self.snapshots(), store.sink(reader), limit=100)
        self.assertEqual(BASE, reader.cursors)
        self.assertEqual(BASE, store.restore_reader().cursors)
        self.assertEqual((), store.stored_messages(limit=100))
        self.assertEqual(1, len(reader.deliver(self.snapshots(), store.sink(reader), limit=100)))

    def test_lost_ack_after_commit_can_replay_same_reader_idempotently(self):
        store = self.open()
        reader = self.initialize(store)
        def lost_ack(phase):
            if phase == "after_commit":
                raise OSError("synthetic lost confirmation")
        with patch.object(store, "_checkpoint", side_effect=lost_ack):
            with self.assertRaises(ReadError):
                reader.deliver(self.snapshots(), store.sink(reader), limit=100)
        self.assertEqual(BASE, reader.cursors)
        self.assertNotEqual(BASE, store.restore_reader().cursors)
        self.assertEqual(1, len(reader.deliver(self.snapshots(), store.sink(reader), limit=100)))
        self.assertEqual(1, len(store.stored_messages(limit=100)))

    def test_actual_process_crash_at_three_transaction_boundaries(self):
        script = '''
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from receipts import LocalReceipts
from reader import Scope
from test_reader import ACCOUNT, GROUP_A, image, shard
class CrashReceipts(LocalReceipts):
    def _checkpoint(self, phase):
        if phase == sys.argv[3]:
            os._exit(23)
with CrashReceipts(sys.argv[2], Scope(ACCOUNT,(GROUP_A,)),
    {'shard_A':'generation_A'}, allow_selected_message_storage=True) as store:
    reader = store.restore_reader()
    data = (shard(image({GROUP_A:[(1,1,1001,'synthetic crash text')]})),)
    reader.deliver(data, store.sink(reader), limit=100)
raise SystemExit(99)
'''
        for phase in ("after_messages", "after_cursors", "after_commit"):
            with self.subTest(phase=phase):
                path = self.path.with_name(phase + SUFFIX)
                store = self.open(path=path)
                self.initialize(store)
                store.close()
                child = subprocess.run([sys.executable, "-B", "-c", script,
                    str(Path(__file__).resolve().parent), str(path), phase],
                    capture_output=True, timeout=15,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                self.assertEqual(23, child.returncode, "synthetic crash point not reached")
                self.assertEqual(b"", child.stdout)
                self.assertEqual(b"", child.stderr)
                reopened = self.open(path=path)
                reader = reopened.restore_reader()
                saved = reopened.stored_messages(limit=100)
                committed = phase == "after_commit"
                self.assertEqual(1 if committed else 0, len(saved))
                self.assertEqual(Cursor(1, 1) if committed else Cursor(0, 0),
                                 reader.cursors[("shard_A", GROUP_A)])
                result = reader.deliver(self.snapshots([(1, 1, 1001, "synthetic crash text")]),
                                        reopened.sink(reader), limit=100)
                self.assertEqual(0 if committed else 1, len(result))
                self.assertEqual(1, len(reopened.stored_messages(limit=100)))
                reopened.close()

    def test_uncommitted_pages_spilled_to_disk_are_rolled_back_after_crash(self):
        store = self.open()
        self.initialize(store)
        store.close()
        original_size = self.path.stat().st_size
        script = '''
import os,sys
sys.path.insert(0,sys.argv[1])
from receipts import LocalReceipts
from reader import Scope
from test_reader import ACCOUNT,GROUP_A,image,shard
class CrashReceipts(LocalReceipts):
    def _checkpoint(self,phase):
        if phase == 'after_messages':
            os._exit(24)
with CrashReceipts(sys.argv[2],Scope(ACCOUNT,(GROUP_A,)),
    {'shard_A':'generation_A'},allow_selected_message_storage=True) as store:
    store._conn.execute('PRAGMA cache_size=1')
    reader=store.restore_reader()
    rows=[(i,i,1000+i,'synthetic spill '+('x'*8192)) for i in range(1,101)]
    reader.deliver((shard(image({GROUP_A:rows})),),store.sink(reader),limit=100)
raise SystemExit(99)
'''
        child = subprocess.run([sys.executable, "-B", "-c", script,
            str(Path(__file__).resolve().parent), str(self.path)], capture_output=True,
            timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(24, child.returncode)
        self.assertEqual((b"", b""), (child.stdout, child.stderr))
        self.assertGreater(self.path.stat().st_size, original_size)
        journal = Path(str(self.path) + "-journal")
        self.assertGreater(journal.stat().st_size, 512)
        reopened = self.open()
        self.assertEqual(BASE, reopened.restore_reader().cursors)
        self.assertEqual((), reopened.stored_messages(limit=100))
        self.assertFalse(journal.exists())

    def test_encrypted_poll_receipt_reopen_then_gap_receipt(self):
        helper = canary_fixtures.CanaryTests()
        process, files = helper.fixtures()
        with helper.session(process, files) as session:
            reader = baseline_reader(session.scope, session.capture())
            store = self.open(manifest=reader.manifest)
            store.initialize(reader.cursors)
            def write(rows):
                plain = bytearray(fixtures.reserved_image({GROUP_A: rows}))
                plain[18:20] = b"\x02\x02"
                encoded = b"".join(fixtures.CipherTests.encrypt_test_page(process.key,
                    bytes(range(16)), bytes(plain[o:o + fixtures.PAGE_SIZE]),
                    o // fixtures.PAGE_SIZE + 1) for o in range(0, len(plain), fixtures.PAGE_SIZE))
                from test_acquisition import index_header
                wal = fixtures.make_wal([(2, 2, encoded[fixtures.PAGE_SIZE:])])
                files.data.update({"": encoded, "-wal": wal, "-shm": index_header(wal, 1, 2)})
            rows = [(1, 40, 1001, "old"), (2, 41, 1002, "new")]
            write(rows)
            self.assertEqual(1, len(session.poll(reader, store.sink(reader), limit=100).batch))
            self.assertTrue(session.poll(reader, store.sink(reader), limit=100).unchanged)
            manifest = reader.manifest
            store.close()
        write(rows + [(3, 42, 1003, "gap")])
        second_process, _ = helper.fixtures()
        with helper.session(second_process, files) as session:
            reopened = self.open(manifest=manifest)
            resumed = reopened.restore_reader()
            result = session.poll(resumed, reopened.sink(resumed), limit=100)
            self.assertEqual(["gap"], [m.content for m in result.batch])
            self.assertEqual({"new", "gap"}, {m.content for m in reopened.stored_messages(limit=100)})
            self.assertNotIn(process.key, self.path.read_bytes())

    def test_multiple_shards_duplicate_server_id_save_once_advance_both(self):
        manifest = {**MANIFEST, "shard_B": "generation_B"}
        store = self.open(manifest=manifest)
        reader = self.initialize(store, {(s, GROUP_A): Cursor(0, 0) for s in manifest})
        snapshots = self.snapshots() + (shard(image({GROUP_A: [(5, 40, 1001,
            "synthetic selected text")]}), name="shard_B", generation="generation_B"),)
        self.assertEqual(2, len(reader.deliver(snapshots, store.sink(reader), limit=100)))
        self.assertEqual(1, len(store.stored_messages(limit=100)))
        self.assertEqual(reader.cursors, store.restore_reader().cursors)

    def test_conflicting_duplicate_does_not_choose_body_or_commit_progress(self):
        store = self.open()
        reader = self.initialize(store)
        reader.deliver(self.snapshots(), store.sink(reader), limit=100)
        before = reader.cursors
        with self.assertRaises(ReadError):
            reader.deliver(self.snapshots([(1, 1, 1001, "synthetic selected text"),
                (2, 2, 1001, "conflicting edited body")]), store.sink(reader), limit=100)
        self.assertEqual(before, store.restore_reader().cursors)
        self.assertEqual("synthetic selected text", store.stored_messages(limit=100)[0].content)

    def test_unselected_account_group_or_forged_id_rejected_atomically(self):
        store = self.open()
        reader = self.initialize(store)
        captured = []
        reader.deliver(self.snapshots(), lambda events, _: captured.extend(events) or True, limit=100)
        reader = store.restore_reader()
        msg = captured[0]
        after = {("shard_A", GROUP_A): msg.cursor}
        for changed in (replace(msg, account="other_account"), replace(msg, group=GROUP_B),
                        replace(msg, event_id="forged"), replace(msg, content=['not a SQLite value'])):
            with self.subTest(), self.assertRaises(ReadError):
                store.sink(reader)((changed,), after)
        self.assertEqual(BASE, store.restore_reader().cursors)
        self.assertEqual((), store.stored_messages(limit=100))

    def test_cursors_cannot_advance_without_corresponding_messages(self):
        store = self.open()
        reader = self.initialize(store)
        captured = []
        reader.deliver(self.snapshots(), lambda events, _: captured.extend(events) or True, limit=100)
        reader = store.restore_reader()
        with self.assertRaisesRegex(ReadError, "CURSOR_MESSAGE_MISMATCH"):
            store.sink(reader)(tuple(captured), {("shard_A", GROUP_A): Cursor(99, 99)})
        self.assertEqual(BASE, store.restore_reader().cursors)

    def test_stale_reader_cannot_overwrite_newer_committed_progress(self):
        store = self.open()
        first = self.initialize(store)
        stale = store.restore_reader()
        first.deliver(self.snapshots([(1, 1, 1001, "one"), (2, 2, 1002, "two")]),
                      store.sink(first), limit=100)
        with self.assertRaises(ReadError):
            stale.deliver(self.snapshots([(1, 1, 1001, "one")]), store.sink(stale), limit=100)
        self.assertEqual(Cursor(2, 2), store.restore_reader().cursors[("shard_A", GROUP_A)])
        self.assertEqual(2, len(store.stored_messages(limit=100)))

    def test_database_busy_does_not_advance_then_retry_succeeds(self):
        store = self.open()
        reader = self.initialize(store)
        other = sqlite3.connect(str(self.path), timeout=0, isolation_level=None)
        try:
            other.execute("BEGIN IMMEDIATE")
            with self.assertRaises(ReadError):
                reader.deliver(self.snapshots(), store.sink(reader), limit=100)
            self.assertEqual(BASE, reader.cursors)
        finally:
            other.close()
        self.assertEqual(1, len(reader.deliver(self.snapshots(), store.sink(reader), limit=100)))

    def test_sqlite_full_rolls_back_without_advancing_then_retry_succeeds(self):
        store = self.open()
        reader = self.initialize(store)
        pages = store._conn.execute("PRAGMA page_count").fetchone()[0]
        maximum = store._conn.execute("PRAGMA max_page_count").fetchone()[0]
        store._conn.execute(f"PRAGMA max_page_count={pages}")
        snapshots = self.snapshots([(1, 1, 1001, "synthetic capacity " + "x" * 65536)])
        with self.assertRaisesRegex(ReadError, "^BATCH_NOT_ACKNOWLEDGED$"):
            reader.deliver(snapshots, store.sink(reader), limit=100)
        self.assertEqual(BASE, reader.cursors)
        self.assertEqual(BASE, store.restore_reader().cursors)
        self.assertEqual((), store.stored_messages(limit=100))
        store._conn.execute(f"PRAGMA max_page_count={maximum}")
        self.assertEqual(1, len(reader.deliver(snapshots, store.sink(reader), limit=100)))

    def test_binding_change_cannot_silently_reset_or_reuse_progress(self):
        store = self.open()
        self.initialize(store)
        store.close()
        for scope, manifest in ((Scope("different_account", (GROUP_A,)), MANIFEST),
            (Scope(ACCOUNT, (GROUP_B,)), MANIFEST), (SCOPE, {"shard_A": "changed_generation"}),
            (SCOPE, {**MANIFEST, "shard_B": "generation_B"})):
            with self.subTest(), self.assertRaisesRegex(ReadError, "BINDING_MISMATCH"):
                self.open(scope=scope, manifest=manifest)
        reopened = self.open()
        self.assertEqual(BASE, reopened.restore_reader().cursors)
        with self.assertRaisesRegex(ReadError, "ALREADY_INITIALIZED"):
            reopened.initialize(BASE)

    def test_uninitialized_or_damaged_progress_never_gets_a_fresh_baseline(self):
        store = self.open()
        with self.assertRaisesRegex(ReadError, "NOT_INITIALIZED"):
            store.restore_reader()
        self.initialize(store)
        store._conn.execute("DELETE FROM receipt_cursors")
        with self.assertRaisesRegex(ReadError, "CURSORS_INVALID"):
            store.restore_reader()
        with self.assertRaisesRegex(ReadError, "ALREADY_INITIALIZED"):
            store.initialize(BASE)

    def test_foreign_database_is_rejected_before_writable_sqlite_open(self):
        db = sqlite3.connect(str(self.path))
        db.execute("CREATE TABLE private_other_data(body TEXT)")
        db.execute("INSERT INTO private_other_data VALUES ('unrelated')")
        db.commit()
        db.close()
        before = self.path.read_bytes()
        with patch("receipts.sqlite3.connect") as connect:
            with self.assertRaisesRegex(ReadError, "FORMAT_MISMATCH"):
                self.open()
            connect.assert_not_called()
        self.assertEqual(before, self.path.read_bytes())

    def test_corrupt_or_unexpected_schema_is_not_recreated(self):
        self.path.write_bytes(b"not a database, synthetic private payload")
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ReadError, "FORMAT_MISMATCH"):
            self.open()
        self.assertEqual(before, self.path.read_bytes())
        self.path.unlink()
        store = self.open()
        self.initialize(store)
        store._conn.execute("CREATE TABLE unexpected(body TEXT)")
        store.close()
        with self.assertRaisesRegex(ReadError, "SCHEMA_MISMATCH"):
            self.open()

    def test_binary_and_empty_selected_fields_round_trip_without_decoding_guess(self):
        store = self.open()
        reader = self.initialize(store)
        rows = [(1, 1, 1001, b"\xffsynthetic bytes"), (2, 2, 1002, ""), (3, 3, 1003, None)]
        reader.deliver(self.snapshots(rows), store.sink(reader), limit=100)
        self.assertEqual({None, "", b"\xffsynthetic bytes"},
                         {m.content for m in store.stored_messages(limit=100)})
        self.assertNotIn("synthetic bytes", repr(store.stored_messages(limit=100)))

    def test_nested_transaction_rejection_does_not_rollback_outer_write(self):
        store = self.open()
        self.initialize(store)
        with store._transaction():
            with self.assertRaisesRegex(ReadError, "TRANSACTION_ALREADY_RUNNING"):
                store.restore_reader()
            self.assertTrue(store._conn.in_transaction)
    def test_same_event_raw_integer_vs_real_field_is_conflict_not_silent_replay(self):
        from dataclasses import replace
        store = self.open(); reader = self.initialize(store)
        messages = reader.deliver(self.snapshots(), store.sink(reader), limit=100)
        store._conn.execute('UPDATE receipt_messages SET compressed_content=?', (0,))
        changed = (replace(messages[0], compressed_content=0.0),)
        with self.assertRaisesRegex(ReadError, 'LOCAL_RECEIPT_EVENT_CONFLICT'):
            store.import_history(changed, approve_history_read=True)
        self.assertIs(type(store.stored_messages(limit=100)[0].compressed_content), int)
    def test_v3_additive_upgrade_keeps_messages_cursors_and_has_no_invented_activation(self):
        store = self.open(); reader = self.initialize(store)
        reader.deliver(self.snapshots(), store.sink(reader), limit=100)
        before = store.restore_reader().cursors
        store._conn.execute('DROP TABLE receipt_activation')
        store._conn.execute('PRAGMA user_version=3'); store.close()
        upgraded = self.open()
        self.assertEqual(upgraded.restore_reader().cursors, before)
        self.assertEqual(len(upgraded.stored_messages(limit=100)), 1)
        self.assertIsNone(upgraded.activation_id())
        self.assertEqual(upgraded._conn.execute('PRAGMA user_version').fetchone()[0], 4)

    def test_over_one_hundred_messages_resume_after_reopen(self):
        store = self.open()
        reader = self.initialize(store)
        snapshots = self.snapshots([(i, i, 1000 + i, "x") for i in range(1, 126)])
        self.assertEqual(100, len(reader.deliver(snapshots, store.sink(reader), limit=100)))
        store.close()
        reopened = self.open()
        resumed = reopened.restore_reader()
        self.assertEqual(25, len(resumed.deliver(snapshots, reopened.sink(resumed), limit=100)))
        self.assertEqual(125, len(reopened.stored_messages(limit=1000)))


if __name__ == "__main__":
    unittest.main()
