"""Idle optimization with real crypto/SQLite over synthetic memory files only."""
import time
import unittest
from dataclasses import replace
from unittest.mock import patch

import canary
import test_canary as canary_fixtures
import test_reader as fixtures
from canary import baseline_reader
from reader import Cursor, ReadError, Scope
from test_acquisition import IDENTITY, index_header
from test_reader import ACCOUNT, GROUP_A, GROUP_B, PAGE_SIZE


class PollingTests(unittest.TestCase):
    def setUp(self):
        helper = canary_fixtures.CanaryTests()
        self.process, self.files = helper.fixtures()
        self.session = helper.session(self.process, self.files)
        self.session.__enter__()
        self.addCleanup(self.session.close)
        self.reader = baseline_reader(self.session.scope, self.session.capture())

    def write(self, rows):
        # Two synthetic table-leaf pages, encrypted/authenticated by production
        # code and queried by SQLite. No real process/files or chat content.
        plain = bytearray(fixtures.reserved_image({GROUP_A: rows}))
        plain[18:20] = b"\x02\x02"
        self.assertEqual(2 * PAGE_SIZE, len(plain))
        encoded = b"".join(fixtures.CipherTests.encrypt_test_page(self.process.key,
            bytes(range(16)), bytes(plain[o:o + PAGE_SIZE]), o // PAGE_SIZE + 1)
            for o in range(0, len(plain), PAGE_SIZE))
        self.files.data[""] = encoded
        wal = fixtures.make_wal([(2, 2, encoded[PAGE_SIZE:])])
        self.files.data["-wal"] = wal
        self.files.data["-shm"] = index_header(wal, 1, 2)

    def poll(self, sink=lambda *_: True, **kwargs):
        return self.session.poll(self.reader, sink, limit=kwargs.pop("limit", 100), **kwargs)

    def test_unchanged_skips_decryption_and_query_but_still_reads_and_checks(self):
        with patch("canary.decode_selected_shards", wraps=canary.decode_selected_shards) as decode:
            self.assertTrue(self.poll().decoded)
            reads = len(self.files.events)
            with patch.object(self.reader, "deliver", wraps=self.reader.deliver) as deliver:
                for _ in range(20):
                    result = self.poll()
                    self.assertTrue(result.unchanged)
                    self.assertFalse(result.decoded)
                    self.assertEqual((), result.batch)
                deliver.assert_not_called()
            self.assertEqual(1, decode.call_count)
            self.assertGreater(len(self.files.events), reads)
        self.assertEqual(32, len(self.session._fingerprint))
        self.assertIs(self.reader, self.session._reader)
        self.assertEqual([], self.files.locks)
        self.assertEqual(len(self.files.opened), len(self.files.closed))

    def test_over_one_hundred_pending_messages_drain_before_skip(self):
        self.write([(i, 40 + i, 1000 + i, "x") for i in range(1, 126)])
        received = []
        def accept(events, cursors):
            received.extend(e.event_id for e in events)
            return True
        self.assertEqual(100, len(self.poll(accept).batch))
        self.assertIsNone(self.session._fingerprint)
        self.assertEqual(25, len(self.poll(accept).batch))
        self.assertIsNotNone(self.session._fingerprint)
        self.assertTrue(self.poll(accept).unchanged)
        self.assertEqual(125, len(set(received)))
        self.assertEqual(Cursor(165, 125), self.reader.cursors[("shard_A", GROUP_A)])

    def test_exact_limit_requires_another_query_to_prove_drain(self):
        self.write([(i, 40 + i, 1000 + i, "x") for i in range(1, 101)])
        self.assertEqual(100, len(self.poll().batch))
        self.assertIsNone(self.session._fingerprint)
        result = self.poll()
        self.assertTrue(result.decoded)
        self.assertEqual((), result.batch)
        self.assertTrue(self.poll().unchanged)

    def test_rejected_sink_never_caches_or_advances_and_retry_reuses_id(self):
        self.write([(2, 41, 1002, "x")])
        before, seen = self.reader.cursors, []
        for answer in (False, 1, None):
            def reject(events, cursors):
                seen.append(events[0].event_id)
                return answer
            with self.assertRaisesRegex(ReadError, "BATCH_NOT_ACKNOWLEDGED"):
                self.poll(reject)
            self.assertIsNone(self.session._fingerprint)
            self.assertEqual(before, self.reader.cursors)
        result = self.poll()
        self.assertEqual({result.batch[0].event_id}, set(seen))
        self.assertTrue(self.poll().unchanged)

    def test_sink_exception_is_sanitized_and_does_not_skip_retry(self):
        self.write([(2, 41, 1002, "x")])
        def fail(*_):
            raise OSError("synthetic private body")
        with self.assertRaisesRegex(ReadError, "^BATCH_NOT_ACKNOWLEDGED$"):
            self.poll(fail)
        self.assertIsNone(self.session._fingerprint)
        self.assertEqual(1, len(self.poll().batch))

    def test_lock_failure_after_cached_snapshot_fails_closed_and_invalidates(self):
        self.poll()
        self.files.fail_lock = 123
        with self.assertRaisesRegex(ReadError, "SNAPSHOT_LOCK_BUSY"):
            self.poll()
        self.assertIsNone(self.session._fingerprint)
        self.assertEqual([], self.files.locks)
        self.files.fail_lock = None
        self.assertTrue(self.poll().decoded)

    def test_same_length_main_ciphertext_mutation_is_not_skipped(self):
        self.poll()
        old = self.files.data[""]
        changed = bytearray(old)
        changed[100] ^= 1
        self.files.data[""] = bytes(changed)
        before = self.reader.cursors
        with self.assertRaisesRegex(ReadError, "SELECTED_DB_KEY_MISSING_OR_AMBIGUOUS"):
            self.poll()
        self.assertIsNone(self.session._fingerprint)
        self.assertEqual(before, self.reader.cursors)
        self.files.data[""] = old
        self.assertTrue(self.poll().decoded)

    def test_wal_only_commit_is_detected_with_unchanged_main(self):
        self.poll()
        old_main = self.files.data[""]
        self.write([(2, 41, 1002, "x")])
        self.files.data[""] = old_main
        result = self.poll()
        self.assertTrue(result.decoded)
        self.assertEqual(1, len(result.batch))
        self.assertTrue(self.poll().unchanged)

    def test_reader_replacement_cannot_reuse_previous_acknowledgement(self):
        self.write([(2, 41, 1002, "x")])
        self.poll()
        self.reader = canary.Reader(self.reader.scope, self.reader._manifest,
            {("shard_A", GROUP_A): Cursor(40, 1)})
        self.assertEqual(1, len(self.poll().batch))

    def test_scope_change_rejected_before_any_source_read(self):
        self.reader = canary.Reader(Scope(ACCOUNT, (GROUP_B,)), self.reader._manifest,
                                   {("shard_A", GROUP_B): Cursor(0, 0)})
        reads = len(self.files.events)
        with self.assertRaisesRegex(ReadError, "READER_SCOPE_MISMATCH"):
            self.poll()
        self.assertEqual(reads, len(self.files.events))

    def test_process_or_file_identity_change_is_never_hidden_by_unchanged_content(self):
        self.poll()
        self.process._identity = replace(IDENTITY, created=IDENTITY.created + 1)
        with self.assertRaisesRegex(ReadError, "PROCESS_IDENTITY_CHANGED"):
            self.poll()
        self.assertIsNone(self.session._fingerprint)
        self.process._identity = IDENTITY
        self.poll()
        self.files.identities[""] = replace(self.files.identities[""], index=999)
        with self.assertRaisesRegex(ReadError, "DB_GENERATION_CHANGED"):
            self.poll()
        self.assertIsNone(self.session._fingerprint)

    def test_expired_before_capture_does_no_io_or_query(self):
        reads = len(self.files.events)
        with patch.object(self.reader, "deliver") as deliver:
            result = self.poll(deadline=time.monotonic() - 1)
            self.assertTrue(result.expired)
            deliver.assert_not_called()
        self.assertEqual(reads, len(self.files.events))

    def test_expired_after_decryption_never_queries_body_or_commits_fingerprint(self):
        clock = [0.0]
        decode = canary.decode_selected_shards
        def slow_decode(*args, **kwargs):
            result = decode(*args, **kwargs)
            clock[0] = 2.0
            return result
        with patch("canary.time.monotonic", side_effect=lambda: clock[0]), \
                patch("canary.decode_selected_shards", side_effect=slow_decode), \
                patch.object(self.reader, "deliver") as deliver:
            result = self.poll(deadline=1.0)
            self.assertTrue(result.expired)
            self.assertTrue(result.decoded)
            deliver.assert_not_called()
        self.assertIsNone(self.session._fingerprint)

    def test_capture_and_close_discard_optimization_state(self):
        self.poll()
        self.session.capture()
        self.assertIsNone(self.session._fingerprint)
        self.assertIsNone(self.session._reader)
        self.poll()
        self.session.close()
        self.assertIsNone(self.session._fingerprint)
        self.assertIsNone(self.session._reader)
        self.assertTrue(self.process.closed)


if __name__ == "__main__":
    unittest.main()
