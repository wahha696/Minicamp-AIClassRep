import contextlib
from dataclasses import asdict
import io
import json
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from catalog import GroupEntry, read_groups
from catalog_probe import inspect_catalog, main, public_result
from identity_snapshot import observe_identity_snapshot
from native import FileIdentity
from reader import ReadError
from test_catalog import image
from test_identity_snapshot import source
from test_managed_windows import PROCESS, MODULE, SHA, BASE, Windows


def fixture():
    process = source()
    metadata = dict(process=asdict(PROCESS), module=asdict(MODULE), sha256=SHA,
        expected_account='wxid_synthetic_account', account_folder='wxid_synthetic_account_abcd',
        root=r'c:\synthetic\wxid_synthetic_account_abcd\db_storage',
        expected_file=asdict(FileIdentity(1, 2, 3)), target_group='人工测试群')
    observer = Mock(side_effect=lambda **options: observe_identity_snapshot(**options,
        process_factory=lambda _: process, windows_factory=Windows))
    acquire = Mock(return_value=(GroupEntry('synthetic@chatroom', '人工测试群'),))
    return metadata, process, observer, acquire


class CatalogProbeTests(unittest.TestCase):
    def test_exact_catalog_scope_between_fresh_identity_checks_and_private_output(self):
        metadata, process, observer, acquire = fixture()
        result = inspect_catalog(metadata, process.report, observe=observer, acquire=acquire)
        self.assertEqual(observer.call_count, 2)
        self.assertEqual(observer.call_args_list[1].kwargs['anchor_rva'], process.anchor)
        request = acquire.call_args.kwargs
        self.assertEqual(request['account'], metadata['account_folder'])
        self.assertEqual(request['root'], metadata['root'])
        self.assertEqual(request['scan_bytes'], 2147483648)
        self.assertEqual(request['snapshot_bytes'], 16777216)
        self.assertEqual(result, dict(stage='contact_catalog_observed', group_count=1,
            target_matches=1, target_unique=True, identity_checks=2, login_verified=False))
        self.assertNotIn('wxid_', json.dumps(result))
        self.assertNotIn('@chatroom', json.dumps(result))
        self.assertNotIn('人工', json.dumps(result, ensure_ascii=False))

    def test_selection_and_profile_invalid_before_any_identity_or_contact_read(self):
        changes = (dict(account_folder='wxid_another_abcd'), dict(expected_account='other'),
            dict(root=r'c:\synthetic\other\db_storage'), dict(expected_file={}),
            dict(target_group='\0private'), dict(sha256='b' * 64))
        for change in changes:
            metadata, process, observer, acquire = fixture()
            with self.subTest(change=change), self.assertRaises(ReadError):
                inspect_catalog({**metadata, **change}, process.report, observe=observer, acquire=acquire)
            observer.assert_not_called()
            acquire.assert_not_called()

    def test_logged_out_or_other_account_prevents_key_and_database_access(self):
        for logout in (False, True):
            metadata, process, observer, acquire = fixture()
            if logout:
                process.pack(process.widget, '<Q', BASE + 0x2600)
            else:
                process.put(process.text, b'wxid_synthetic_changed')
            with self.subTest(logout=logout), self.assertRaises(ReadError):
                inspect_catalog(metadata, process.report, observe=observer, acquire=acquire)
            acquire.assert_not_called()

    def test_change_during_catalog_capture_discards_all_entries(self):
        for logout in (False, True):
            metadata, process, observer, acquire = fixture()
            def capture(**_):
                if logout:
                    process.pack(process.widget, '<Q', BASE + 0x2600)
                else:
                    process.put(process.text, b'wxid_synthetic_changed')
                return (GroupEntry('synthetic@chatroom', '人工测试群'),)
            acquire.side_effect = capture
            with self.subTest(logout=logout), self.assertRaises(ReadError):
                inspect_catalog(metadata, process.report, observe=observer, acquire=acquire)

    def test_contact_failure_is_not_an_empty_success(self):
        metadata, process, observer, acquire = fixture()
        acquire.side_effect = ReadError('SYNTHETIC_CAPTURE_FAILED')
        with self.assertRaisesRegex(ReadError, 'SYNTHETIC_CAPTURE_FAILED'):
            inspect_catalog(metadata, process.report, observe=observer, acquire=acquire)

    def test_unknown_or_duplicate_target_is_reported_without_choosing_first(self):
        for entries, matches in (((), 0), ((GroupEntry('a@chatroom', None),), 0),
                ((GroupEntry('a@chatroom', '人工测试群'), GroupEntry('b@chatroom', '人工测试群')), 2)):
            metadata, process, observer, acquire = fixture()
            acquire.return_value = entries
            result = inspect_catalog(metadata, process.report, observe=observer, acquire=acquire)
            self.assertEqual(result['target_matches'], matches)
            self.assertFalse(result['target_unique'])

    def test_synthetic_contact_query_filters_private_contacts_before_output(self):
        metadata, process, observer, acquire = fixture()
        data = image((('wxid_private', 'PRIVATE', 'REMARK', 'OWNER'),
                      ('synthetic@chatroom', '人工测试群', 'REMARK', 'OWNER')))
        acquire.side_effect = lambda **_: read_groups(data, max_image_bytes=1048576, max_groups=20, max_name_bytes=1024)
        result = inspect_catalog(metadata, process.report, observe=observer, acquire=acquire)
        self.assertEqual(result['group_count'], 1)
        self.assertNotIn('PRIVATE', json.dumps(result))


ARGS = ['--metadata', 'synthetic.json', '--approve-account-read', '--approve-key-read',
        '--approve-contact-read', '--accept-os-memory-limit']


class CatalogParentTests(unittest.TestCase):
    def result(self, **changes):
        item = dict(stage='contact_catalog_observed', group_count=1, target_matches=1,
            target_unique=True, identity_checks=2, login_verified=False)
        item.update(changes)
        return SimpleNamespace(returncode=0, stdout=json.dumps(item), stderr='')

    def test_parent_has_explicit_timeout_hidden_worker_and_filtered_result(self):
        run = Mock(return_value=self.result())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(ARGS, run=run), 0)
        self.assertEqual(run.call_args.kwargs['timeout'], 120)
        self.assertIn('--worker', run.call_args.args[0])
        self.assertNotIn('shell', run.call_args.kwargs)
        self.assertEqual(json.loads(output.getvalue())['identity_checks'], 2)

    def test_parent_timeout_does_not_report_success_or_leak_error(self):
        run = Mock(side_effect=subprocess.TimeoutExpired(['private'], 120))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(main(ARGS, run=run), 2)
        self.assertEqual(json.loads(output.getvalue())['reason'], 'CONTACT_PROBE_WORKER_TIMEOUT')
        self.assertNotIn('private', output.getvalue())

    def test_bad_private_inconsistent_or_verified_output_is_rejected(self):
        for changes in (dict(account_id='wxid_secret'), dict(login_verified=True), dict(target_unique=False),
                dict(group_count=True), dict(target_matches=2), dict(identity_checks=True)):
            with self.subTest(changes=changes):
                result = public_result(self.result(**changes))
                self.assertEqual(result['stage'], 'stopped')
                self.assertNotIn('wxid_', json.dumps(result))

    def test_missing_scope_confirmation_does_not_spawn_or_open_metadata(self):
        for flag in ARGS[2:]:
            with patch('builtins.open') as opened, contextlib.redirect_stderr(io.StringIO()):
                run = Mock()
                with self.subTest(flag=flag), self.assertRaises(SystemExit):
                    main([a for a in ARGS if a != flag], run=run)
                run.assert_not_called()
                opened.assert_not_called()


if __name__ == '__main__':
    unittest.main()
