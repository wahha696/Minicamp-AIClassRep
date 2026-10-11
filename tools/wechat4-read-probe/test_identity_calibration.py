import contextlib
import io
import json
import subprocess
import unittest
from unittest.mock import Mock, patch

from identity_calibration_probe import Calibration, ManualControl, main, public_event
from identity_snapshot import IdentitySnapshot
from reader import ReadError


class CalibrationTests(unittest.TestCase):
    def test_control_repeated_poll_does_not_repeat_sample_and_stop_is_explicit(self):
        control = ManualControl(8)
        self.assertIsNone(control.take(dict(seq=0, command='sample')))
        self.assertEqual(control.take(dict(seq=1, command='sample')), (1, 'sample'))
        self.assertIsNone(control.take(dict(seq=1, command='sample')))
        self.assertEqual(control.take(dict(seq=2, command='stop')), (2, 'stop'))

    def test_control_rejects_reused_sequence_changed_command_and_jumps(self):
        for document in (dict(seq=1, command='stop'), dict(seq=0, command='sample'), dict(seq=3, command='sample')):
            control = ManualControl(8)
            control.take(dict(seq=1, command='sample'))
            with self.subTest(document=document), self.assertRaises(ReadError):
                control.take(document)

    def test_control_rejects_invalid_schema_and_zero_stop(self):
        for document in ({}, dict(seq=True, command='sample'), dict(seq=0, command='stop'),
                         dict(seq=10, command='sample'), dict(seq=1, command='other')):
            with self.subTest(document=document), self.assertRaises(ReadError):
                ManualControl(8).take(document)

    def test_comparison_only_learns_location_and_rechecks_new_account(self):
        state = Calibration('wxid_synthetic_original')
        observe = Mock(side_effect=[
            IdentitySnapshot('main_and_account_observed', 'wxid_synthetic_original', 0x3000, 99999, 2),
            IdentitySnapshot('login_page_observed', None, None, 999, 1),
            IdentitySnapshot('main_and_account_observed', 'wxid_synthetic_other', 0x3000, 999, 2),
            IdentitySnapshot('main_and_account_observed', 'wxid_synthetic_original', 0x3000, 999, 2)])
        first, logged_out, changed, restored = [state.sample(i, observe) for i in range(1, 5)]
        self.assertTrue(first['expected_account_matched'])
        self.assertIsNone(logged_out['expected_account_matched'])
        self.assertIsNone(logged_out['changed_from_previous'])
        self.assertFalse(changed['expected_account_matched'])
        self.assertTrue(changed['changed_from_previous'])
        self.assertTrue(restored['expected_account_matched'])
        self.assertTrue(restored['changed_from_previous'])
        self.assertEqual(observe.call_args_list[0].args, (None, 268435456, 15))
        self.assertEqual(observe.call_args_list[1].args, (0x3000, 1048576, 5))
        for event in (first, logged_out, changed, restored):
            self.assertFalse(event['login_verified'])
            self.assertNotIn('wxid_', json.dumps(event))
            self.assertEqual(public_event(json.dumps(event), 8), event)

    def test_failed_sample_never_returns_previous_account(self):
        state = Calibration('wxid_synthetic_original', 0x3000, 'wxid_synthetic_original')
        with self.assertRaises(ReadError):
            state.sample(1, Mock(side_effect=ReadError('PROCESS_CHANGED')))
        self.assertEqual(state.anchor, 0x3000)  # Comparison data does not become a result.

    def test_worker_output_rejects_text_addresses_auth_and_inconsistent_evidence(self):
        valid = Calibration('wxid_synthetic_original').sample(1, Mock(return_value=IdentitySnapshot(
            'main_and_account_observed', 'wxid_synthetic_original', 0x3000, 99999, 2)))
        for change in (dict(login_verified=True), dict(account_id='wxid_secret'), dict(seq=True),
                       dict(state='login_page_observed'), dict(window_checks=1), dict(bytes_read=268435457),
                       dict(expected_account_matched=None), dict(bytes_read=True)):
            with self.subTest(change=change), self.assertRaises(ReadError):
                public_event(json.dumps({**valid, **change}), 8)
        for raw in ('private chat', 'x' * 2049, '[]', json.dumps(dict(stage='stopped', reason='private chat', login_verified=False))):
            with self.assertRaises(ReadError):
                public_event(raw, 8)


ARGS = ['--metadata', 'synthetic.json', '--control', 'synthetic-control.json',
        '--duration', '600', '--max-samples', '8', '--approve-joint-read']


class ParentTests(unittest.TestCase):
    def process(self, events):
        p = Mock()
        p.stdout = io.StringIO(''.join(json.dumps(e) + '\n' for e in events))
        p.poll.return_value = None
        p.wait.return_value = 0
        return p

    def test_parent_forwards_only_complete_ordered_events_and_closes_child(self):
        state = Calibration('wxid_synthetic_original')
        sample = state.sample(1, Mock(return_value=IdentitySnapshot('main_and_account_observed', 'wxid_synthetic_original', 0x3000, 999, 2)))
        events = [dict(stage='calibration_ready', login_verified=False),
                  dict(stage='sample_started', seq=1, anchor_reused=False, login_verified=False), sample,
                  dict(stage='calibration_finished', samples=1, login_verified=False)]
        p, output = self.process(events), io.StringIO()
        with patch('identity_calibration_probe.subprocess.Popen', return_value=p) as spawn, contextlib.redirect_stdout(output):
            self.assertEqual(main(ARGS), 0)
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], events)
        self.assertNotIn('shell', spawn.call_args.kwargs)
        p.kill.assert_called_once()
        self.assertTrue(p.stdout.closed)

    def test_bad_or_unfinished_worker_is_killed_and_reaped(self):
        for events in ([], [dict(stage='calibration_ready', login_verified=False)],
                       [dict(stage='calibration_finished', samples=0, login_verified=False)],
                       [dict(stage='identity_sampled', login_verified=True)]):
            p = self.process(events)
            with self.subTest(events=events), patch('identity_calibration_probe.subprocess.Popen', return_value=p), \
                    contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ReadError):
                main(ARGS)
            p.kill.assert_called_once()
            p.wait.assert_called()
            self.assertTrue(p.stdout.closed)

    def test_invalid_budgets_never_spawn_worker(self):
        args = list(ARGS)
        args[args.index('--duration') + 1] = '601'
        with patch('identity_calibration_probe.subprocess.Popen') as spawn, self.assertRaises(ReadError):
            main(args)
        spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
