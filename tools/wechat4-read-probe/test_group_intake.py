"""Artificial group snapshots/receipts only; no process or live DB reads."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import Mock

from group_intake import GroupMessageIntake, GroupPlan
from reader import ReadError, Scope
from test_reader import ACCOUNT, GROUP_A, GROUP_B
from test_selected_intake import Capture


class GroupIntakeTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='synthetic-group-intake-')
        self.addCleanup(self.folder.cleanup)
        self.scope = Scope(ACCOUNT, (GROUP_A, GROUP_B))
        self.rows = {GROUP_A: [(1, 1, 1001, 'old A')], GROUP_B: [(1, 1, 2001, 'old B')]}
        self.plans = tuple(GroupPlan(group, str(Path(self.folder.name) / (str(i) + '.wechat-receipts.sqlite3')),
            str(uuid.uuid4()), True, False) for i, group in enumerate(self.scope.groups))
    def create(self, plans=None, scope=None, ack=None):
        capture = Capture(scope or self.scope, self.rows)
        intake = GroupMessageIntake(scope=capture.scope, capture=capture, plans=plans or self.plans,
            destination='synthetic-space', approve_selected_storage=True, activation_committed=ack or Mock())
        self.addCleanup(intake.close)
        return intake, capture
    def test_two_groups_share_one_capture_per_poll_and_restart_uses_independent_progress(self):
        intake, capture = self.create()
        self.assertEqual(capture.captures, 0)
        with intake:
            self.assertEqual(capture.captures, 1)
            self.rows[GROUP_A].append((2, 2, 1002, 'new A'))
            self.rows[GROUP_B].append((2, 2, 2002, 'new B'))
            self.assertEqual([row['saved'] for row in intake.poll().values()], [1, 1])
            self.assertEqual(capture.captures, 2)
            self.assertEqual([row['saved'] for row in intake.poll().values()], [0, 0])
        self.rows[GROUP_A].append((3, 3, 1003, 'gap A'))
        plans = tuple(replace(plan, activation_pending=False, require_existing_progress=True) for plan in self.plans)
        resumed, _ = self.create(plans)
        with resumed:
            self.assertEqual([row['saved'] for row in resumed.poll().values()], [1, 0])
            self.assertEqual([row['pending'] for row in resumed.status().values()], [2, 1])
    def test_lost_state_ack_retry_does_not_reset_first_group_baseline(self):
        failed = Mock(side_effect=ReadError('SYNTHETIC_STATE_SAVE_FAILED'))
        intake, capture = self.create(ack=failed)
        with self.assertRaises(ReadError): intake.__enter__()
        self.assertTrue(capture.closed)
        self.rows[GROUP_A].append((2, 2, 1002, 'after baseline before registry ack'))
        retry, _ = self.create()
        with retry:
            self.assertEqual([row['saved'] for row in retry.poll().values()], [1, 0])
    def test_group_without_local_table_waits_without_stopping_existing_group(self):
        del self.rows[GROUP_B]
        intake, _ = self.create()
        with intake:
            self.assertEqual(set(intake.status()), {GROUP_A, GROUP_B})
            self.assertEqual([row['saved'] for row in intake.poll().values()], [0, 0])
            self.assertEqual(intake.refresh_history(GROUP_B, days=1, now_seconds=10, approve_history_read=True)['inserted'], 0)
            self.assertEqual(set(intake.status()), {GROUP_A, GROUP_B})
            self.rows[GROUP_A].append((2, 2, 1002, 'new A'))
            self.assertEqual([row['saved'] for row in intake.poll().values()], [1, 0])
            self.rows[GROUP_B] = [(1, 3, 2001, 'first B')]
            self.assertEqual([row['saved'] for row in intake.poll().values()], [0, 1])
            self.assertEqual([row['saved'] for row in intake.poll().values()], [0, 0])
        plans = tuple(replace(plan, activation_pending=False, require_existing_progress=True) for plan in self.plans)
        resumed, _ = self.create(plans)
        with resumed:
            self.assertEqual([row['saved'] for row in resumed.poll().values()], [0, 0])
            self.assertEqual([row['pending'] for row in resumed.status().values()], [1, 1])
    def test_cancel_one_group_does_not_reset_other_and_reenable_skips_only_cancelled_gap(self):
        intake, _ = self.create()
        with intake:
            self.rows[GROUP_A].append((2, 2, 1002, 'old pending A')); intake.poll()
        self.rows[GROUP_A].append((3, 3, 1003, 'disabled A'))
        self.rows[GROUP_B].append((2, 2, 2002, 'normal restart B'))
        plans = (replace(self.plans[0], activation_id=str(uuid.uuid4()), require_existing_progress=True),
            replace(self.plans[1], activation_pending=False, require_existing_progress=True))
        enabled, _ = self.create(plans)
        with enabled:
            self.assertEqual([row['saved'] for row in enabled.poll().values()], [0, 1])
            self.assertEqual([row['pending'] for row in enabled.status().values()], [1, 1])
    def test_duplicate_receipt_paths_refused_before_capture_is_opened(self):
        capture = Capture(self.scope, self.rows)
        with self.assertRaisesRegex(ReadError, 'PLAN_INVALID'):
            GroupMessageIntake(scope=self.scope, capture=capture,
                plans=(self.plans[0], replace(self.plans[1], receipt_path=self.plans[0].receipt_path)),
                destination='synthetic-space', approve_selected_storage=True, activation_committed=Mock())
        self.assertEqual(capture.captures, 0)


if __name__ == '__main__': unittest.main()
