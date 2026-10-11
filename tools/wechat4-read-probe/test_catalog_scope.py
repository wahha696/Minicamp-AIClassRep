from contextlib import nullcontext
from dataclasses import replace
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from catalog_scope import contact_scope
from catalog_worker import decode_metadata
from identity_discovery import KNOWN_PROFILES
from native import FileIdentity, normal_path
from reader import ReadError
from test_managed_windows import PROCESS, MODULE


class CatalogScopeTests(unittest.TestCase):
    def fixture(self, names=('wxid_synthetic_account_abcd',)):
        opened = []
        file_id = FileIdentity(1, (1 << 64) - 1, 134360728640232155)
        def files(path, directory=False):
            handle = SimpleNamespace(path=normal_path(path), identity=lambda: file_id,
                final_path=lambda: normal_path(path), size=lambda: 4096)
            opened.append((path, directory, handle))
            return nullcontext(handle)
        entries = [SimpleNamespace(name=name, is_dir=lambda **_: True, is_symlink=lambda: False) for name in names]
        enumerate_directory = Mock(side_effect=lambda _: nullcontext(iter(entries)))
        options = dict(data_root=r'C:\synthetic\xwechat_files', account='wxid_synthetic_account',
            process=replace(PROCESS, created=134360728640232154), module=MODULE,
            sha256=KNOWN_PROFILES[PROCESS.version], approve_metadata_read=True,
            enumerate_directory=enumerate_directory, files=files)
        return options, opened, enumerate_directory, entries

    def test_only_exact_owned_account_contact_metadata_and_lossless_wire_values_are_returned(self):
        options, opened, _, _ = self.fixture(('wxid_other_abcd', 'wxid_synthetic_account_abcd'))
        result = contact_scope(**options)
        self.assertEqual(result['account_folder'], 'wxid_synthetic_account_abcd')
        self.assertEqual(result['root'], r'c:\synthetic\xwechat_files\wxid_synthetic_account_abcd\db_storage')
        self.assertEqual(result['process']['created'], '134360728640232154')
        self.assertEqual(result['expected_file']['index'], '18446744073709551615')
        self.assertEqual(decode_metadata(result)['process']['created'], 134360728640232154)
        self.assertTrue(all('wxid_other' not in path for path, _, _ in opened))
        self.assertFalse(any('message' in path for path, _, _ in opened))

    def test_consent_invalid_root_account_profile_and_budgets_do_no_directory_access(self):
        for change in (dict(approve_metadata_read=False), dict(account='private'),
                       dict(data_root=r'C:\synthetic\other'), dict(sha256='bad'),
                       dict(max_entries=0), dict(max_seconds=float('nan'))):
            options, opened, enumerate_directory, _ = self.fixture()
            with self.subTest(change=change), self.assertRaises(ReadError):
                contact_scope(**{**options, **change})
            self.assertFalse(opened); enumerate_directory.assert_not_called()

    def test_missing_or_multiple_same_account_folders_require_resolution_instead_of_guessing(self):
        for names in (('wxid_other_abcd',), ('wxid_synthetic_account_abcd', 'wxid_synthetic_account_ef01')):
            options, opened, _, _ = self.fixture(names)
            with self.assertRaises(ReadError): contact_scope(**options)
            self.assertEqual(len(opened), 1)  # Root metadata only, no candidate's DB.

    def test_redirects_shortcuts_and_directory_budget_stop_before_contact_access(self):
        options, opened, _, entries = self.fixture()
        entries[0].is_symlink = lambda: True
        with self.assertRaisesRegex(ReadError, 'ACCOUNT_REDIRECTED'): contact_scope(**options)
        self.assertEqual(len(opened), 1)
        options, opened, _, _ = self.fixture(('wxid_other_abcd', 'wxid_synthetic_account_abcd'))
        with self.assertRaisesRegex(ReadError, 'ENTRY_LIMIT'): contact_scope(**{**options, 'max_entries': 1})
        self.assertEqual(len(opened), 1)
        options, _, _, _ = self.fixture()
        with self.assertRaisesRegex(ReadError, 'ROOT_REDIRECTED'):
            contact_scope(**{**options, 'files': lambda *_, **__: nullcontext(SimpleNamespace(path=r'c:\elsewhere'))})

    def test_file_replacement_reopen_is_detected_without_reading_content_and_all_handles_close(self):
        options, opened, _, _ = self.fixture()
        files = options['files']
        closed = []
        class Wrapper:
            def __init__(self, handle): self.handle = handle
            def __enter__(self): return self.handle
            def __exit__(self, *_): closed.append(self.handle)
        def replacing(path, directory=False):
            handle = files(path, directory).__enter__()
            if len(opened) == 9: handle.identity = lambda: FileIdentity(1, 2, 3)
            return Wrapper(handle)
        with self.assertRaisesRegex(ReadError, 'FILE_CHANGED'):
            contact_scope(**{**options, 'files': replacing})
        self.assertEqual(len(opened), len(closed))


if __name__ == '__main__':
    unittest.main()
