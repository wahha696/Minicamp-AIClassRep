"""Synthetic bounded history, no live files/process/AI access."""
from dataclasses import replace
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from history import history_page
from reader import Cursor, ReadError, Scope
from receipts import LocalReceipts, SUFFIX
from selected_intake import SelectedMessageIntake
from test_reader import ACCOUNT, GROUP_A, GROUP_B, image, shard
from test_selected_intake import Capture

SCOPE = Scope(ACCOUNT, (GROUP_A,))
MANIFEST = {'shard_A': 'generation_A'}
NOW = 1700000000


def snapshots():
    db = sqlite3.connect(':memory:')
    db.deserialize(image({GROUP_A: [(i, i, 1000 + i, 'history ' + str(i)) for i in range(1, 6)], GROUP_B: [(1, 1, 9001, 'private never selected')]}))
    table = 'Msg_' + hashlib.md5(GROUP_A.encode()).hexdigest()
    timestamps = [NOW - 30 * 86400 - 1, NOW - 30 * 86400, NOW - 7 * 86400, NOW - 86400, NOW + 1]
    for i, ts in enumerate(timestamps, 1): db.execute(f'UPDATE "{table}" SET create_time=? WHERE local_id=?', (ts, i))
    db.commit(); result = (shard(db.serialize()),); db.close()
    return result


class HistoryTests(unittest.TestCase):
    def test_1_7_30_windows_include_boundary_exclude_older_future_and_unselected(self):
        for days, ids in [(1, [4]), (7, [3, 4]), (30, [2, 3, 4])]:
            with self.subTest(days=days):
                page, progress, more = history_page(SCOPE, MANIFEST, snapshots(), days=days, now_seconds=NOW)
                self.assertEqual([message.cursor.local_id for message in page], ids)
                self.assertFalse(more)
                self.assertEqual(progress[('shard_A', GROUP_A)], Cursor(4, 4))
    def test_paginated_refresh_is_complete_without_duplicates(self):
        values = snapshots(); progress = None; ids = []
        for _ in range(5):
            page, progress, more = history_page(SCOPE, MANIFEST, values, days=30, now_seconds=NOW, after=progress, limit=1)
            ids.extend(message.cursor.local_id for message in page)
            if not more: break
        self.assertEqual(ids, [2, 3, 4]); self.assertFalse(more)
    def test_accounts_manifest_generation_and_missing_group_fail_before_any_partial_page(self):
        for source, message in [((replace(snapshots()[0], account='other'),), 'ACCOUNT_MISMATCH'),
            ((replace(snapshots()[0], generation='other'),), 'GENERATION_CHANGED'),
            ((shard(image({GROUP_B: []})),), 'GROUP_NOT_FOUND')]:
            with self.subTest(message=message), self.assertRaisesRegex(ReadError, message):
                history_page(SCOPE, MANIFEST, source, days=1, now_seconds=NOW)
    def test_import_is_idempotent_keeps_live_progress_and_rolls_back_conflicts(self):
        with tempfile.TemporaryDirectory(prefix='synthetic-history-') as folder:
            path = Path(folder) / ('synthetic' + SUFFIX)
            with LocalReceipts(path, SCOPE, MANIFEST, allow_selected_message_storage=True) as store:
                base = {('shard_A', GROUP_A): Cursor(99, 99)}; store.initialize(base)
                page, _, _ = history_page(SCOPE, MANIFEST, snapshots(), days=30, now_seconds=NOW)
                with self.assertRaisesRegex(ReadError, 'HISTORY_APPROVAL_REQUIRED'): store.import_history(page)
                self.assertEqual(store.import_history(page, approve_history_read=True), 3)
                self.assertEqual(store.import_history(page, approve_history_read=True), 0)
                self.assertEqual(store.restore_reader().cursors, base)
                changed = (replace(page[0], content='conflicting old body'),)
                with self.assertRaisesRegex(ReadError, 'EVENT_CONFLICT'): store.import_history(changed, approve_history_read=True)
                self.assertEqual(len(store.stored_messages(limit=100)), 3)
                self.assertEqual(store.restore_reader().cursors, base)
    def test_disk_failure_rolls_back_history_without_touching_live_cursor(self):
        with tempfile.TemporaryDirectory(prefix='synthetic-history-') as folder:
            with LocalReceipts(Path(folder) / ('synthetic' + SUFFIX), SCOPE, MANIFEST, allow_selected_message_storage=True) as store:
                base = {('shard_A', GROUP_A): Cursor(99, 99)}; store.initialize(base)
                page, _, _ = history_page(SCOPE, MANIFEST, snapshots(), days=30, now_seconds=NOW)
                with patch.object(store, '_checkpoint', side_effect=OSError('synthetic')):
                    with self.assertRaises(OSError): store.import_history(page, approve_history_read=True)
                self.assertEqual(store.stored_messages(limit=100), ()); self.assertEqual(store.restore_reader().cursors, base)
    def test_invalid_history_request_does_not_capture_or_open_database(self):
        with tempfile.TemporaryDirectory(prefix='synthetic-history-') as folder:
            capture = Capture(SCOPE, {GROUP_A: []})
            intake = SelectedMessageIntake(scope=SCOPE, capture=capture, receipt_path=Path(folder) / ('synthetic' + SUFFIX), destination='synthetic', approve_selected_storage=True)
            for args in [dict(days=2, now_seconds=NOW), dict(days=True, now_seconds=NOW), dict(days=1, now_seconds=float('nan')),
                dict(days=1, now_seconds=NOW, limit=0), dict(days=1, now_seconds=NOW, approve_history_read=False)]:
                with self.subTest(args=args), self.assertRaises(ReadError):
                    intake.refresh_history(**{'approve_history_read': True, **args})
            self.assertEqual(capture.captures, 0)
    def test_integrated_history_import_keeps_restart_progress_and_identity_failure_closes(self):
        with tempfile.TemporaryDirectory(prefix='synthetic-history-') as folder:
            capture = Capture(SCOPE, {GROUP_A: []}); capture.capture = snapshots
            intake = SelectedMessageIntake(scope=SCOPE, capture=capture, receipt_path=Path(folder) / ('synthetic' + SUFFIX), destination='synthetic', approve_selected_storage=True)
            with intake:
                outcome = intake.refresh_history(days=30, now_seconds=NOW, approve_history_read=True)
                self.assertEqual(outcome['inserted'], 3)
                self.assertEqual(intake.poll()['saved'], 0)
                capture.failing_check = capture.checks + 1
                with self.assertRaisesRegex(ReadError, 'ACCOUNT_NOT_CURRENT'):
                    intake.refresh_history(days=1, now_seconds=NOW, approve_history_read=True)
                self.assertTrue(capture.closed)
                with self.assertRaisesRegex(ReadError, 'NOT_OPEN'): intake.status()


if __name__ == '__main__': unittest.main()
