"""Artificial SQLite snapshots + disposable receipts, never real WeChat."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from reader import Cursor, ReadError, Scope
from receipts import LocalReceipts, SUFFIX
from selected_intake import IntakeSinkError, SelectedMessageIntake
from test_delivery import ack, names
from test_reader import ACCOUNT, GROUP_A, GROUP_B, image, shard


class Capture:
    def __init__(self, scope, rows):
        self.scope, self.rows, self.closed, self.checks = scope, rows, False, 0
        self.failing_check = None
        self.captures = 0
    def __enter__(self): return self
    def capture(self):
        self.captures += 1
        return (shard(image(self.rows)),)
    def revalidate(self):
        self.checks += 1
        if self.checks == self.failing_check:
            self.closed = True
            raise ReadError('IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT')
    def close(self): self.closed = True


class IntakeTests(unittest.TestCase):
    def setUp(self):
        research = Path(__file__).resolve().parents[2] / '.review-research'
        self.folder = tempfile.TemporaryDirectory(prefix='synthetic-intake-', dir=research)
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / ('synthetic' + SUFFIX)
        self.scope = Scope(ACCOUNT, (GROUP_A,))
        self.capture = Capture(self.scope, {GROUP_A: [(1, 10, 1001, 'old selected')], GROUP_B: [(1, 1, 9001, 'private unselected')]})
    def receiver(self, capture=None, **options):
        result = SelectedMessageIntake(scope=self.scope, capture=capture or self.capture,
            receipt_path=self.path, destination='synthetic-space', approve_selected_storage=True, **options)
        self.addCleanup(result.close)
        return result
    def test_construction_is_inert_and_consent_is_required_before_read_or_store(self):
        with self.assertRaisesRegex(ReadError, 'STORAGE_APPROVAL_REQUIRED'):
            SelectedMessageIntake(scope=self.scope, capture=self.capture, receipt_path=self.path, destination='synthetic-space')
        result = self.receiver()
        self.assertEqual(self.capture.captures, 0)
        self.assertFalse(self.path.exists())
        with self.assertRaisesRegex(ReadError, 'NOT_OPEN'): result.poll()
    def test_first_activation_saves_only_new_selected_messages_and_restart_catches_gap(self):
        result = self.receiver(); result.__enter__()
        self.assertEqual(result.status()['pending'], 0)
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'new selected'))
        self.assertEqual(result.poll(), {'saved': 1, 'may_have_more': False})
        result.close()
        data = self.path.read_bytes()
        self.assertNotIn(b'old selected', data); self.assertNotIn(b'private unselected', data)
        self.assertIn(b'new selected', data)
        self.capture.rows[GROUP_A].append((3, 12, 1003, 'arrived while closed'))
        next_capture = Capture(self.scope, self.capture.rows)
        with self.receiver(next_capture) as restarted:
            self.assertEqual(restarted.poll()['saved'], 1)
            self.assertEqual(restarted.poll()['saved'], 0)
            self.assertEqual(restarted.status()['pending'], 2)
    def test_identity_failure_before_creation_writes_no_receipt_and_closes_capture(self):
        self.capture.failing_check = 1
        with self.assertRaisesRegex(ReadError, 'ACCOUNT_NOT_CURRENT'): self.receiver().__enter__()
        self.assertFalse(self.path.exists()); self.assertTrue(self.capture.closed)
    def test_identity_changes_before_sink_commit_keeps_saved_progress_and_no_new_body(self):
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'must not persist'))
        self.capture.failing_check = self.capture.checks + 1
        with self.assertRaises(IntakeSinkError) as failed: result.poll()
        self.assertEqual(failed.exception.sink_phase, 'identity_recheck')
        self.assertEqual(failed.exception.sink_reason, 'IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT')
        self.assertTrue(self.capture.closed)
        with LocalReceipts(self.path, self.scope, {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            self.assertEqual(store.restore_reader().cursors[('shard_A', GROUP_A)], Cursor(10, 1))
            self.assertEqual(store.stored_messages(limit=100), ())
        self.assertNotIn(b'must not persist', self.path.read_bytes())
    def test_sqlite_write_failure_diagnostic_and_reopen_retry_keep_progress_atomic(self):
        import sqlite3
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'retry after rollback'))
        observed = Mock()
        with patch.object(LocalReceipts, '_checkpoint', side_effect=sqlite3.OperationalError('private path/body')):
            with self.assertRaises(IntakeSinkError) as failed: result.poll(observe_saved=observed)
        self.assertEqual(failed.exception.sink_phase, 'receipt_commit')
        self.assertEqual(failed.exception.sink_reason, 'LOCAL_RECEIPT_WRITE_FAILED')
        observed.assert_not_called(); self.assertTrue(self.capture.closed)
        with LocalReceipts(self.path, self.scope, {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            self.assertEqual(store.restore_reader().cursors[('shard_A', GROUP_A)], Cursor(10, 1))
            self.assertEqual(store.stored_messages(limit=100), ())
        with self.receiver(Capture(self.scope, self.capture.rows)) as restarted:
            self.assertEqual(restarted.poll()['saved'], 1)
            self.assertEqual(restarted.poll()['saved'], 0)
            self.assertEqual(restarted.status()['pending'], 1)
    def test_failure_after_commit_reopens_at_saved_progress_without_duplicate_or_success_claim(self):
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'committed before acknowledgement failed'))
        observed = Mock()
        def checkpoint(stage):
            if stage == 'after_commit': raise OSError('private exception text')
        with patch.object(LocalReceipts, '_checkpoint', side_effect=checkpoint):
            with self.assertRaises(IntakeSinkError) as failed: result.poll(observe_saved=observed)
        self.assertEqual(failed.exception.sink_reason, 'SELECTED_INTAKE_SINK_FAILED')
        self.assertNotIn('private', str(failed.exception)); observed.assert_not_called()
        with self.receiver(Capture(self.scope, self.capture.rows)) as restarted:
            self.assertEqual(restarted.poll()['saved'], 0)
            self.assertEqual(restarted.status()['pending'], 1)
    def test_unsupported_compressed_text_is_saved_and_deferred_without_blocking_normal_text(self):
        import sqlite3, hashlib
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A] += [(2, 11, 1002, 'normal'), (3, 12, 1003, 'unsupported field')]
        db = sqlite3.connect(':memory:'); db.deserialize(image(self.capture.rows))
        table = 'Msg_' + hashlib.md5(GROUP_A.encode()).hexdigest()
        db.execute(f'UPDATE "{table}" SET compress_content=? WHERE local_id=3', ('synthetic unsupported text',))
        db.commit(); modified = db.serialize(); db.close()
        self.capture.capture = lambda: (shard(modified),)
        self.assertEqual(result.poll()['saved'], 2)
        sent = []
        def send(doc): sent.extend(doc['messages']); return ack(doc)
        outcome = result.deliver(names, send)
        self.assertEqual(outcome['delivered'], 1); self.assertEqual(outcome['deferred'], 1)
        self.assertEqual(sent[0]['text'], 'normal')
        result.close()
        with LocalReceipts(self.path, self.scope, {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            self.assertEqual(len(store.stored_messages(limit=100)), 2)
            self.assertEqual(store.restore_reader().cursors[('shard_A', GROUP_A)], Cursor(12, 3))
            self.assertEqual(store.pending_delivery('synthetic-space', limit=100, include_issues=True)[0].compressed_content,
                'synthetic unsupported text')
            self.assertEqual(store.delivery_issues('synthetic-space', limit=100)[0]['reason'],
                'DELIVERY_COMPRESSED_FIELD_UNSUPPORTED')
    def test_receipt_integer_limit_remains_strict_with_no_truncation(self):
        from reader import Message, message_event_id
        result = self.receiver(); result.__enter__()
        for server in (-(1 << 63) - 1, 1 << 63, True):
            event = Message(message_event_id(ACCOUNT, GROUP_A, 'shard_A', 'generation_A', server, 2),
                ACCOUNT, GROUP_A, 'shard_A', Cursor(11, 2), server, 1, 7, 1700000000, 'synthetic', None)
            with self.subTest(server=server), self.assertRaisesRegex(ReadError, 'LOCAL_RECEIPT_INTEGER_INVALID'):
                result._store._values(event)
    def test_raw_sqlite_fields_round_trip_and_unsupported_values_do_not_starve_text(self):
        import sqlite3, hashlib
        values = (None, b'', '', 'not a compressed frame', b'unknown bytes', 0, 9, 0.0, 1.25)
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A] += [(i, i + 10, 1000 + i, 'normal text') for i in range(2, len(values) + 2)]
        db = sqlite3.connect(':memory:'); db.deserialize(image(self.capture.rows))
        table = 'Msg_' + hashlib.md5(GROUP_A.encode()).hexdigest()
        for i, value in enumerate(values, 2):
            db.execute(f'UPDATE "{table}" SET compress_content=? WHERE local_id=?', (value, i))
        db.commit(); modified = db.serialize(); db.close()
        self.capture.capture = lambda: (shard(modified),)
        observed = Mock()
        self.assertEqual(result.poll(observe_saved=observed)['saved'], len(values))
        observed.assert_called_once()
        sent = []
        def send(doc): sent.extend(doc['messages']); return ack(doc)
        outcome = result.deliver(names, send)
        self.assertEqual(outcome['delivered'], 3); self.assertEqual(outcome['deferred'], 6)
        result.close()
        with LocalReceipts(self.path, self.scope, {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            rows = sorted(store.stored_messages(limit=100), key=lambda m: m.cursor)
            self.assertEqual([(type(m.compressed_content), m.compressed_content) for m in rows],
                [(type(v), v) for v in values])
            self.assertEqual(store.delivery_status('synthetic-space'), {'pending': 0, 'deferred': 6})
    def test_raw_value_validator_rejects_non_sqlite_or_lossy_values(self):
        from reader import Message, message_event_id
        result = self.receiver(); result.__enter__()
        valid = Message(message_event_id(ACCOUNT, GROUP_A, 'shard_A', 'generation_A', 1002, 2),
            ACCOUNT, GROUP_A, 'shard_A', Cursor(11, 2), 1002, 1, 7, 1700000000, 'synthetic', None)
        for value in (True, [], {}, float('nan'), float('inf'), 1 << 63, '\ud800'):
            for field in ('content', 'compressed_content'):
                with self.subTest(value=type(value), field=field), self.assertRaises(ReadError):
                    result._store._values(replace(valid, **{field: value}))
    def test_corrupt_missing_progress_is_never_replaced_with_a_new_baseline(self):
        result = self.receiver(); result.__enter__(); result.close()
        with LocalReceipts(self.path, self.scope, {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            store._conn.execute('DELETE FROM receipt_cursors')
        with self.assertRaisesRegex(ReadError, 'CURSORS_INVALID'): self.receiver(Capture(self.scope, self.capture.rows)).__enter__()
    def test_explicit_restart_refuses_empty_receipt_and_never_initializes_progress(self):
        with self.assertRaisesRegex(ReadError, 'LOCAL_RECEIPT_NOT_INITIALIZED'):
            self.receiver(require_existing_progress=True).__enter__()
        with LocalReceipts(self.path, self.scope, {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            self.assertFalse(store.initialized())
            self.assertEqual(store._conn.execute('SELECT count(*) FROM receipt_cursors').fetchone()[0], 0)
        self.assertTrue(self.capture.closed)
    def test_committed_activation_retry_does_not_rebaseline_even_if_state_acknowledgement_was_lost(self):
        import uuid
        token = str(uuid.uuid4())
        result = self.receiver(activation_id=token, activation_pending=True); result.__enter__(); result.close()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'arrived after baseline before state ack'))
        with self.receiver(Capture(self.scope, self.capture.rows), activation_id=token, activation_pending=True) as retry:
            self.assertEqual(retry.poll()['saved'], 1)
            self.assertEqual(retry.poll()['saved'], 0)
        self.capture.rows[GROUP_A].append((3, 12, 1003, 'normal restart gap'))
        with self.receiver(Capture(self.scope, self.capture.rows), activation_id=token) as resumed:
            self.assertEqual(resumed.poll()['saved'], 1)
            self.assertEqual(resumed.status()['pending'], 2)
    def test_activation_token_and_reenable_baseline_commit_together_or_both_roll_back(self):
        import uuid
        old, new = str(uuid.uuid4()), str(uuid.uuid4())
        result = self.receiver(activation_id=old, activation_pending=True); result.__enter__()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'already received pending'))
        result.poll(); result.close()
        self.capture.rows[GROUP_A].append((3, 12, 1003, 'disabled gap'))
        def fault(phase):
            if phase == 'after_reactivation_token': raise OSError('synthetic write failure')
        with patch.object(LocalReceipts, '_checkpoint', side_effect=fault):
            with self.assertRaises(OSError):
                self.receiver(Capture(self.scope, self.capture.rows), activation_id=new, activation_pending=True).__enter__()
        with LocalReceipts(self.path, self.scope, {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            self.assertEqual(store.activation_id(), old)
            self.assertEqual(store.restore_reader().cursors[('shard_A', GROUP_A)], Cursor(11, 2))
            self.assertEqual(len(store.stored_messages(limit=100)), 1)
        with self.receiver(Capture(self.scope, self.capture.rows), activation_id=new, activation_pending=True) as enabled:
            self.assertEqual(enabled.poll()['saved'], 0)
            self.assertEqual(enabled.status()['pending'], 1)
        self.capture.rows[GROUP_A].append((4, 13, 1004, 'after new activation'))
        with self.receiver(Capture(self.scope, self.capture.rows), activation_id=new, activation_pending=True) as retry:
            self.assertEqual(retry.poll()['saved'], 1)
            self.assertEqual(retry.status()['pending'], 2)
    def test_mismatched_token_without_explicit_pending_activation_never_resets_progress(self):
        import uuid
        token = str(uuid.uuid4())
        with self.receiver(activation_id=token, activation_pending=True): pass
        with self.assertRaisesRegex(ReadError, 'ACTIVATION_MISMATCH'):
            self.receiver(Capture(self.scope, self.capture.rows), activation_id=str(uuid.uuid4())).__enter__()
    def test_explicit_restart_uses_existing_progress_but_cannot_skip_gap_as_reenable(self):
        result = self.receiver(); result.__enter__(); result.close()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'restart gap'))
        with self.receiver(Capture(self.scope, self.capture.rows), require_existing_progress=True) as resumed:
            self.assertEqual(resumed.poll()['saved'], 1)
            self.assertEqual(resumed.poll()['saved'], 0)
        with self.assertRaisesRegex(ReadError, 'SELECTED_INTAKE_SCOPE_INVALID'):
            self.receiver(Capture(self.scope, self.capture.rows), require_existing_progress=True, user_reenabled=True)
    def test_user_reenable_skips_disabled_gap_but_keeps_older_pending_and_next_restart_catches_gap(self):
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'already received pending'))
        result.poll(); result.close()
        self.capture.rows[GROUP_A].append((3, 12, 1003, 'disabled gap'))
        with self.receiver(Capture(self.scope, self.capture.rows), user_reenabled=True) as reenabled:
            self.assertEqual(reenabled.poll()['saved'], 0)
            self.assertEqual(reenabled.status()['pending'], 1)
        self.capture.rows[GROUP_A].append((4, 13, 1004, 'offline after reenable'))
        with self.receiver(Capture(self.scope, self.capture.rows)) as restarted:
            self.assertEqual(restarted.poll()['saved'], 1)
            self.assertEqual(restarted.status()['pending'], 2)
        self.assertNotIn(b'disabled gap', self.path.read_bytes())
    def test_reenable_failure_rolls_back_cursor_without_deleting_pending(self):
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'saved pending'))
        result.poll(); result.close()
        self.capture.rows[GROUP_A].append((3, 12, 1003, 'disabled message'))
        with patch.object(LocalReceipts, '_checkpoint', side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):
                self.receiver(Capture(self.scope, self.capture.rows), user_reenabled=True).__enter__()
        with LocalReceipts(self.path, self.scope, {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            self.assertEqual(store.restore_reader().cursors[('shard_A', GROUP_A)], Cursor(11, 2))
            self.assertEqual(len(store.stored_messages(limit=100)), 1)
    def test_manifest_change_does_not_reset_old_progress(self):
        result = self.receiver(); result.__enter__(); result.close()
        capture = Capture(self.scope, self.capture.rows)
        capture.capture = lambda: (replace(shard(image(self.capture.rows)), generation='new-generation'),)
        with self.assertRaisesRegex(ReadError, 'BINDING_MISMATCH'): self.receiver(capture).__enter__()
        self.assertTrue(capture.closed)
    def test_125_pending_messages_drain_over_two_polls_and_reopen_keeps_remainder(self):
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A] += [(i, i + 10, 1000 + i, 'new text') for i in range(2, 127)]
        self.assertEqual(result.poll(), {'saved': 100, 'may_have_more': True}); result.close()
        with self.receiver(Capture(self.scope, self.capture.rows)) as restarted:
            self.assertEqual(restarted.poll(), {'saved': 25, 'may_have_more': False})
            self.assertEqual(restarted.status()['pending'], 125)
    def test_failed_transport_preserves_pending_for_retry_without_closing_valid_capture(self):
        with self.receiver() as result:
            self.capture.rows[GROUP_A].append((2, 11, 1002, 'deliver me'))
            result.poll()
            with self.assertRaisesRegex(ReadError, 'DELIVERY_NOT_ACKNOWLEDGED'):
                result.deliver(names, Mock(side_effect=OSError('private failure')))
            self.assertEqual(result.status()['pending'], 1); self.assertFalse(self.capture.closed)
            outcome = result.deliver(names, ack)
            self.assertEqual(outcome['delivered'], 1); self.assertEqual(result.status()['pending'], 0)
            self.assertEqual(result.deliver(names, ack)['delivered'], 0)
    def test_delivery_checks_identity_before_reading_pending_or_sending(self):
        result = self.receiver(); result.__enter__(); send = Mock()
        self.capture.failing_check = self.capture.checks + 1
        with self.assertRaisesRegex(ReadError, 'ACCOUNT_NOT_CURRENT'): result.deliver(names, send)
        send.assert_not_called(); self.assertTrue(self.capture.closed)
    def test_saved_observer_runs_only_after_commit_and_failed_commit_has_no_marker_claim(self):
        result = self.receiver(); result.__enter__()
        self.capture.rows[GROUP_A].append((2, 11, 1002, 'CLASSREP_TEST_SYNTHETIC_INTAKE'))
        observed = []
        def inspect(batch):
            self.assertEqual(len(result._store.stored_messages(limit=100)), 1)
            observed.extend(message.content for message in batch)
        self.assertEqual(result.poll(observe_saved=inspect)['saved'], 1)
        self.assertEqual(observed, ['CLASSREP_TEST_SYNTHETIC_INTAKE'])
        self.capture.rows[GROUP_A].append((3, 12, 1003, 'must not claim'))
        with patch.object(LocalReceipts, '_checkpoint', side_effect=OSError('synthetic commit failure')):
            with self.assertRaises(ReadError): result.poll(observe_saved=inspect)
        self.assertEqual(observed, ['CLASSREP_TEST_SYNTHETIC_INTAKE'])
    def test_failed_capture_cleanup_retains_owner_until_explicit_retry(self):
        result = self.receiver(); result.__enter__()
        self.capture.close = Mock(side_effect=[ReadError('SYNTHETIC_CLOSE_FAILED'), None, None])
        with self.assertRaisesRegex(ReadError, 'SYNTHETIC_CLOSE_FAILED'): result.close()
        with self.assertRaisesRegex(ReadError, 'NOT_OPEN'): result.poll()
        result.close()
        self.assertEqual(self.capture.close.call_count, 2)
    def test_unsupported_message_does_not_block_text_and_is_preserved_for_retry(self):
        import sqlite3, hashlib
        with self.receiver() as result:
            self.capture.rows[GROUP_A] += [(2, 11, 1002, 'unsupported'), (3, 12, 1003, 'normal text')]
            snapshot = image(self.capture.rows)
            db = sqlite3.connect(':memory:'); db.deserialize(snapshot)
            table = 'Msg_' + hashlib.md5(GROUP_A.encode()).hexdigest()
            db.execute(f'UPDATE "{table}" SET local_type=3 WHERE local_id=2'); db.commit()
            modified = db.serialize(); db.close()
            self.capture.capture = lambda: (shard(modified),)
            self.assertEqual(result.poll()['saved'], 2)
            sent = []
            def send(doc): sent.extend(doc['messages']); return ack(doc)
            self.assertEqual(result.deliver(names, send)['delivered'], 1)
            self.assertEqual(sent[0]['text'], 'normal text')
            self.assertEqual(result.status()['deferred'], 1)


if __name__ == '__main__': unittest.main()
