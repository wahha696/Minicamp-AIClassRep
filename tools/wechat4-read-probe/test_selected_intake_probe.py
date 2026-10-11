"""Artificial orchestration only, never real account/contact/message reads."""
from argparse import Namespace
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from contextlib import nullcontext
from types import SimpleNamespace
from dataclasses import replace

from reader import ReadError
from selected_intake_probe import MARKER, RESUME_MARKER, failure, main, observe_intake, selection, worker
from reader import Cursor, Message, message_event_id
from test_reader import ACCOUNT, GROUP_A
from identity_discovery import Discovery
from native import FileIdentity, normal_path
from test_managed_windows import PROCESS, MODULE, SHA
from catalog import GroupEntry
from test_reader import Scope, image, shard
from test_selected_intake import Capture
from receipts import SUFFIX
from selected_intake import IntakeSinkError, SINK_FAILURE_REASONS

APPROVALS = ['--approve-identity-read', '--approve-key-read', '--approve-contact-read', '--approve-message-read',
             '--approve-selected-storage', '--accept-os-memory-limit']


class FakeIntake:
    def __init__(self): self.closed, self.polls = False, 0
    def __enter__(self): return self
    def poll(self, **_): self.polls += 1; return {'saved': 1 if self.polls == 1 else 0, 'may_have_more': False}
    def status(self): return {'pending': 1, 'deferred': 0}
    def __exit__(self, *_): self.closed = True


class ProbeTests(unittest.TestCase):
    def test_every_confirmation_required_before_metadata_or_discovery(self):
        for absent in APPROVALS:
            with self.subTest(absent=absent), patch('selected_intake_probe.read_json') as read, patch('selected_intake_probe.discover_target') as discover:
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    main(['--metadata', 'not-opened.json', '--receipt', 'not-created.wechat-receipts.sqlite3', *[flag for flag in APPROVALS if flag != absent]], run=Mock())
                read.assert_not_called(); discover.assert_not_called()
    def test_watchdog_uses_isolated_hidden_child_minimal_environment_and_no_stderr(self):
        run = Mock(return_value=Namespace(returncode=0))
        with patch.dict('selected_intake_probe.os.environ', {'AI_API_KEY': 'never pass', 'PYTHONPATH': 'never pass', 'SystemRoot': 'C:\\Windows'}, clear=True):
            self.assertEqual(main(['--metadata', 'synthetic.json', '--receipt', 'synthetic.wechat-receipts.sqlite3', *APPROVALS], run=run), 0)
        args, kwargs = run.call_args
        self.assertIn('-I', args[0]); self.assertIn('utf8', args[0]); self.assertIn('--worker', args[0])
        self.assertEqual(kwargs['timeout'], 420)
        self.assertEqual({key.lower(): value for key, value in kwargs['env'].items()}, {'systemroot': 'C:\\Windows'})
        self.assertNotIn('stdout', kwargs)
    def test_bounded_window_outputs_aggregate_stages_only_and_releases_intake(self):
        intake = FakeIntake(); output = []; clock = [0]
        def sleep(seconds): clock[0] += seconds
        result = observe_intake(intake, clock=lambda: clock[0], sleep=sleep, emit=output.append)
        self.assertEqual(result['polls'], 60); self.assertEqual(result['saved_new_messages'], 1)
        self.assertTrue(intake.closed); self.assertEqual(clock[0], 180)
        self.assertEqual([item['stage'] for item in output], ['selected_intake_ready', 'selected_intake_observed'])
        self.assertFalse(result['login_verified'])
        for item in output:
            self.assertFalse(any(key in item for key in ('account', 'group', 'text', 'body', 'key')))
    def test_failure_during_poll_closes_intake_and_no_final_success(self):
        intake = FakeIntake(); intake.poll = Mock(side_effect=ReadError('synthetic'))
        with self.assertRaises(ReadError): observe_intake(intake, emit=Mock())
        self.assertTrue(intake.closed)
    def test_marker_count_comes_from_committed_selected_batch_not_other_chat_count(self):
        intake = FakeIntake(); output = []; clock = [0]
        event = Message(message_event_id(ACCOUNT, GROUP_A, 'shard_A', 'generation_A', 1001, 1), ACCOUNT, GROUP_A,
            'shard_A', Cursor(1, 1), 1001, 1, 7, 1700000000, MARKER, None)
        def poll(*, observe_saved, **_):
            intake.polls += 1
            observe_saved((event,) if intake.polls == 1 else ())
            return {'saved': 1 if intake.polls == 1 else 0}
        intake.poll = poll
        def sleep(seconds): clock[0] += seconds
        result = observe_intake(intake, clock=lambda: clock[0], sleep=sleep, emit=output.append)
        self.assertEqual(result['persisted_marker_count'], 1)
        self.assertEqual(output[1]['marker_timestamps'], [1700000000])
        self.assertNotIn(MARKER, json.dumps(output)); self.assertNotIn(ACCOUNT, json.dumps(output))
    def test_marker_observer_never_crashes_on_saved_sqlite_compressed_field_types(self):
        from canary import MarkerReceipt
        marker = MarkerReceipt(MARKER)
        for i, value in enumerate(('', 'unsupported', 0, 0.0, 9, b'unknown', None), 1):
            event = Message(message_event_id(ACCOUNT, GROUP_A, 'shard_A', 'generation_A', 1000 + i, i),
                ACCOUNT, GROUP_A, 'shard_A', Cursor(i, i), 1000 + i, 1, 7, 1700000000, MARKER, value)
            self.assertTrue(marker((event,), {}))
        self.assertEqual(marker.summary()['marker_count'], 7)
        self.assertEqual(marker.summary()['undecoded_fields'], 5)
    def test_selection_rejects_extra_fields_wrong_folder_and_bad_root(self):
        data = {'expected_account': 'wxid_synthetic', 'account_folder': 'wxid_synthetic_abcd', 'root': 'E:\\synthetic\\xwechat_files', 'target_group': '人工测试群'}
        self.assertEqual(selection(data)[0], 'wxid_synthetic')
        for change in ({'pid': 1}, {'account_folder': 'wxid_other_abcd'}, {'root': 'E:\\other'}, {'target_group': ''}):
            with self.subTest(change=change), self.assertRaises(ReadError): selection({**data, **change})
    def test_failure_codes_are_allowlisted_and_never_reflect_unknown_native_text(self):
        self.assertEqual(failure(ReadError('SHARD_GENERATION_CHANGED'))['reason'], 'SHARD_GENERATION_CHANGED')
        for error in (ReadError('private account/path'), RuntimeError('SHARD_GENERATION_CHANGED')):
            self.assertEqual(failure(error)['reason'], 'INTAKE_PROBE_FAILED')
    def test_sink_failure_reports_only_fixed_phase_and_allowlisted_reason(self):
        for reason in SINK_FAILURE_REASONS:
            output = failure(IntakeSinkError('receipt_commit', ReadError(reason)))
            self.assertEqual(output['reason'], 'BATCH_NOT_ACKNOWLEDGED')
            self.assertEqual(output['sink_reason'], reason)
            self.assertEqual(output['sink_phase'], 'receipt_commit')
        for error in (ReadError('private path/chat'), OSError('private path/chat'), RuntimeError('LOCAL_RECEIPT_WRITE_FAILED')):
            output = failure(IntakeSinkError('private stage', error))
            self.assertEqual(output['sink_phase'], 'unknown')
            self.assertEqual(output['sink_reason'], 'SELECTED_INTAKE_SINK_FAILED')
            self.assertNotIn('private', json.dumps(output))
        altered = IntakeSinkError('receipt_commit', ReadError('LOCAL_RECEIPT_WRITE_FAILED'))
        altered.sink_phase = altered.sink_reason = 'private path/chat'
        self.assertNotIn('private', json.dumps(failure(altered)))
    def test_existing_receipt_rejected_before_any_wechat_read(self):
        data = {'expected_account': 'wxid_synthetic', 'account_folder': 'wxid_synthetic_abcd', 'root': 'E:\\synthetic\\xwechat_files', 'target_group': '人工测试群'}
        with tempfile.TemporaryDirectory(prefix='synthetic-intake-probe-') as folder:
            receipt = Path(folder) / 'synthetic.wechat-receipts.sqlite3'; receipt.write_bytes(b'do not touch')
            with patch('selected_intake_probe.read_json', return_value=data), patch('selected_intake_probe.discover_target') as discover:
                with self.assertRaisesRegex(ReadError, 'RECEIPT_INVALID'): worker(Namespace(metadata='synthetic', receipt=str(receipt)))
                discover.assert_not_called(); self.assertEqual(receipt.read_bytes(), b'do not touch')
    def test_resume_missing_receipt_rejected_before_any_wechat_read(self):
        data = {'expected_account': 'wxid_synthetic', 'account_folder': 'wxid_synthetic_abcd', 'root': 'E:\\synthetic\\xwechat_files', 'target_group': '人工测试群'}
        with tempfile.TemporaryDirectory(prefix='synthetic-resume-probe-') as folder:
            receipt = Path(folder) / ('missing' + SUFFIX)
            with patch('selected_intake_probe.read_json', return_value=data), patch('selected_intake_probe.discover_target') as discover:
                with self.assertRaisesRegex(ReadError, 'RECEIPT_INVALID'):
                    worker(Namespace(metadata='synthetic', receipt=str(receipt), approve_existing_receipt_resume=True))
                discover.assert_not_called(); self.assertFalse(receipt.exists())
    def test_parent_forwards_resume_only_when_explicitly_requested(self):
        for flags in ([], ['--approve-existing-receipt-resume']):
            run = Mock(return_value=Namespace(returncode=0))
            self.assertEqual(main(['--metadata', 'synthetic.json', '--receipt', 'synthetic' + SUFFIX, *APPROVALS, *flags], run=run), 0)
            self.assertEqual('--approve-existing-receipt-resume' in run.call_args.args[0], bool(flags))
    def test_resume_observer_reports_only_new_restart_marker_not_previous_test_marker(self):
        intake = FakeIntake(); output = []; clock = [0]
        events = tuple(Message(message_event_id(ACCOUNT, GROUP_A, 'shard_A', 'generation_A', 1000 + i, i),
            ACCOUNT, GROUP_A, 'shard_A', Cursor(i, i), 1000 + i, 1, 7, 1700000000, value, '')
            for i, value in enumerate((MARKER, RESUME_MARKER), 1))
        def poll(*, observe_saved, **_):
            intake.polls += 1; batch = events if intake.polls == 1 else ()
            observe_saved(batch); return {'saved': len(batch)}
        intake.poll = poll
        def sleep(seconds): clock[0] += seconds
        result = observe_intake(intake, resume_existing=True, clock=lambda: clock[0], sleep=sleep, emit=output.append)
        self.assertTrue(output[0]['resumed_saved_progress']); self.assertEqual(result['persisted_marker_count'], 1)
        self.assertEqual(result['saved_new_messages'], 2); self.assertTrue(intake.closed)
    def test_full_worker_handles_real_discovery_result_and_saves_only_postbaseline_rows(self):
        account = 'wxid_synthetic_probe'
        group = 'synthetic@chatroom'
        selected = {'expected_account': account, 'account_folder': account + '_abcd',
            'root': 'E:\\synthetic\\xwechat_files', 'target_group': '人工测试群'}
        captured = Capture(Scope(account, (group,)), {group: [(1, 1, 1001, 'old text')]})
        def snapshot():
            return (replace(shard(image(captured.rows)), account=account),)
        captured.capture = snapshot
        scopes, files = [], []
        def resolve(**kwargs):
            scopes.append(kwargs)
            return {'account_folder': selected['account_folder'], 'root': normal_path(selected['root'] + '\\' + selected['account_folder'] + '\\db_storage')}
        def file(path):
            files.append(path)
            return nullcontext(SimpleNamespace(path=path, final_path=lambda: path, identity=lambda: FileIdentity(1, 2, 3)))
        def observe(intake, resume_existing=False):
            with intake:
                i = 3 if resume_existing else 2
                self.assertEqual(intake._require_existing, resume_existing)
                captured.rows[group].append((i, i, 1000 + i, RESUME_MARKER if resume_existing else MARKER))
                self.assertEqual(intake.poll()['saved'], 1)
                self.assertEqual(intake.poll()['saved'], 0)
                self.assertEqual(intake.status()['pending'], 2 if resume_existing else 1)
            return {'stage': 'synthetic-completed', 'login_verified': False}
        with tempfile.TemporaryDirectory(prefix='synthetic-full-intake-') as folder:
            receipt = Path(folder) / ('synthetic' + SUFFIX)
            output = io.StringIO()
            with patch('selected_intake_probe.read_json', return_value=selected), \
                 patch('selected_intake_probe.discover_target', return_value=Discovery('found', PROCESS, MODULE, SHA)), \
                 patch('selected_intake_probe.contact_scope', side_effect=resolve), \
                 patch('selected_intake_probe.decode_metadata', side_effect=lambda value: value), \
                 patch('selected_intake_probe.inspect_program', return_value=object()), \
                 patch('selected_intake_probe.inspect_entries', return_value=(GroupEntry(group, selected['target_group']),)), \
                 patch('selected_intake_probe.NativeFile', side_effect=file), \
                 patch('selected_intake_probe.IdentityBoundCapture', return_value=captured), \
                 patch('selected_intake_probe.observe_intake', side_effect=observe), redirect_stdout(output):
                self.assertEqual(worker(Namespace(metadata='synthetic', receipt=str(receipt))), 0)
                self.assertEqual(worker(Namespace(metadata='synthetic', receipt=str(receipt), approve_existing_receipt_resume=True)), 0)
            self.assertEqual(scopes[0]['process'], PROCESS); self.assertEqual(scopes[0]['module'], MODULE)
            self.assertEqual(len(files), 6)
            self.assertTrue(all('message_' in path for path in files))
            self.assertTrue(captured.closed); self.assertNotIn(account, output.getvalue())
            self.assertNotIn(b'old text', receipt.read_bytes()); self.assertIn(MARKER.encode(), receipt.read_bytes())
    def test_discovery_failure_states_stop_before_contacts_or_files(self):
        selected = {'expected_account': 'wxid_synthetic', 'account_folder': 'wxid_synthetic_abcd',
            'root': 'E:\\synthetic\\xwechat_files', 'target_group': '人工测试群'}
        with tempfile.TemporaryDirectory(prefix='synthetic-discovery-') as folder:
            for state in ('not_running', 'unsupported', 'ambiguous', 'main_process_unavailable'):
                with self.subTest(state=state), patch('selected_intake_probe.read_json', return_value=selected), \
                     patch('selected_intake_probe.discover_target', return_value=Discovery(state)), \
                     patch('selected_intake_probe.contact_scope') as contacts, patch('selected_intake_probe.NativeFile') as files:
                    with self.assertRaisesRegex(ReadError, 'INTAKE_PROBE_'):
                        worker(Namespace(metadata='synthetic', receipt=str(Path(folder) / ('synthetic' + SUFFIX))))
                    contacts.assert_not_called(); files.assert_not_called()


if __name__ == '__main__': unittest.main()
