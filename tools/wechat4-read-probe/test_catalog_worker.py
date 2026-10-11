import io
import json
import unittest
from unittest.mock import Mock

from catalog import GroupEntry
from catalog_worker import serve, decode_metadata
from reader import ReadError
from test_catalog_probe import fixture


class PrivateCatalogWorkerTests(unittest.TestCase):
    def test_native_ticks_use_exact_decimal_strings_and_rounded_numbers_are_rejected(self):
        item, _ = self.request()
        metadata = item['metadata']
        metadata['process']['created'] = '134360728640232154'
        metadata['module']['base'] = '123456789012345'
        metadata['expected_file'] = dict(volume='1', index='18446744073709551615', created='134360728640232155')
        decoded = decode_metadata(metadata)
        self.assertEqual(decoded['process']['created'], 134360728640232154)
        self.assertEqual(decoded['expected_file']['created'], 134360728640232155)
        self.assertEqual(decoded['expected_file']['index'], (1 << 64) - 1)
        self.assertEqual(metadata['process']['created'], '134360728640232154')
        for invalid in (134360728640232154, 134360728640232160, True, 1.5, '01', '+1', '1e17', '-1', '18446744073709551616'):
            bad = {**metadata, 'process': {**metadata['process'], 'created': invalid}}
            with self.subTest(value=invalid), self.assertRaises(ReadError):
                decode_metadata(bad)

    def request(self, **changes):
        metadata, process, _, _ = fixture()
        metadata.pop('target_group')
        item = dict(v=1, token='a' * 64, seq=0, command='catalog', metadata=metadata)
        item.update(changes)
        return item, process

    def run_worker(self, item, *, entries=(GroupEntry('synthetic@chatroom', '人工群 😀'),)):
        inspect, acquire, emit = Mock(return_value=object()), Mock(return_value=entries), Mock()
        result = serve(input_stream=io.StringIO(json.dumps(item) + '\n'), emit=emit, inspect=inspect, acquire=acquire)
        return result, inspect, acquire, emit

    def test_one_owned_response_contains_only_groups_and_private_nonce(self):
        item, _ = self.request()
        result, inspect, acquire, emit = self.run_worker(item)
        self.assertEqual(result, 0)
        self.assertEqual(inspect.call_args.kwargs['max_bytes'], 268435456)
        self.assertEqual(acquire.call_args.args[0], item['metadata'])
        self.assertEqual(emit.call_args.args[0], dict(v=1, token='a' * 64, seq=0, kind='catalog',
            groups=[dict(group_id='synthetic@chatroom', name='人工群 😀')]))

    def test_invalid_protocol_or_metadata_does_no_file_inspection(self):
        for change in (dict(v=True), dict(seq=True), dict(seq=1), dict(token='b'), dict(command='messages'),
                       dict(body='private'), dict(metadata={})):
            item, _ = self.request(**change)
            inspect, acquire, emit = Mock(), Mock(), Mock()
            with self.subTest(change=change), self.assertRaises(ReadError):
                serve(input_stream=io.StringIO(json.dumps(item) + '\n'), emit=emit, inspect=inspect, acquire=acquire)
            inspect.assert_not_called(); acquire.assert_not_called(); emit.assert_not_called()

    def test_truncated_or_oversized_request_stops_before_inspection(self):
        item, _ = self.request()
        for raw in (json.dumps(item), 'x' * 16385 + '\n', 'not-json\n'):
            inspect = Mock()
            with self.assertRaises(ReadError):
                serve(input_stream=io.StringIO(raw), emit=Mock(), inspect=inspect)
            inspect.assert_not_called()

    def test_failed_capture_never_emits_partial_groups(self):
        item, _ = self.request()
        emit = Mock()
        result = serve(input_stream=io.StringIO(json.dumps(item) + '\n'), emit=emit, inspect=Mock(),
            acquire=Mock(side_effect=ReadError('SYNTHETIC_FAILURE private path / account')))
        self.assertEqual(result, 2)
        self.assertEqual(emit.call_args.args[0], dict(v=1, token='a' * 64, seq=0,
            kind='error', reason='CATALOG_CAPTURE_FAILED'))

    def test_only_known_error_constants_cross_the_owned_pipe(self):
        item, _ = self.request()
        for error in (ReadError('KEY_SCAN_BYTE_BUDGET_EXCEEDED'), OSError('private path / account')):
            emit = Mock()
            result = serve(input_stream=io.StringIO(json.dumps(item) + '\n'), emit=emit,
                inspect=Mock(), acquire=Mock(side_effect=error))
            self.assertEqual(result, 2)
            self.assertEqual(emit.call_args.args[0]['reason'], 'KEY_SCAN_BYTE_BUDGET_EXCEEDED'
                if isinstance(error, ReadError) else 'CATALOG_CAPTURE_FAILED')
            self.assertNotIn('private', json.dumps(emit.call_args.args[0]))
        emit = Mock()
        result = serve(input_stream=io.StringIO(json.dumps(item) + '\n'), emit=emit,
            inspect=Mock(side_effect=OSError('private dll')), acquire=Mock())
        self.assertEqual(result, 2)
        self.assertEqual(emit.call_args.args[0]['reason'], 'CATALOG_STATIC_ANALYSIS_FAILED')

    def test_private_contact_duplicate_and_oversized_names_are_rejected(self):
        item, _ = self.request()
        for entries in ((GroupEntry('wxid_private', 'private'),),
                (GroupEntry('a@chatroom', 'a'), GroupEntry('a@chatroom', 'b')),
                (GroupEntry('a@chatroom', '字' * 1000),)):
            with self.assertRaises(ReadError): self.run_worker(item, entries=entries)

    def test_empty_catalog_is_valid_not_a_failure(self):
        item, _ = self.request()
        result, _, _, emit = self.run_worker(item, entries=())
        self.assertEqual(result, 0); self.assertEqual(emit.call_args.args[0]['groups'], [])

    def test_owned_root_uses_fresh_discovery_and_exact_file_metadata_before_capture(self):
        item, _ = self.request()
        metadata = item.pop('metadata')
        item.update(command='catalog_root', selection=dict(data_root=r'C:\synthetic\xwechat_files',
            expected_account=metadata['expected_account']))
        discover = Mock(return_value=type('Target', (), dict(state='found', process=object(), module=object(), sha256='a' * 64))())
        resolve = Mock(return_value=metadata)
        acquire = Mock(return_value=())
        self.assertEqual(serve(input_stream=io.StringIO(json.dumps(item) + '\n'), emit=Mock(),
            inspect=Mock(), acquire=acquire, resolve=resolve, discover=discover), 0)
        discover.assert_called_once(); resolve.assert_called_once()
        self.assertEqual(resolve.call_args.kwargs['account'], 'wxid_synthetic_account')
        self.assertEqual(acquire.call_args.args[0], metadata)

    def test_invalid_root_requests_never_discover_or_open_files(self):
        for selection in ({}, dict(data_root=r'C:\private', expected_account='wxid_synthetic_account'),
                          dict(data_root=r'\\server\xwechat_files', expected_account='wxid_synthetic_account'),
                          dict(data_root=r'C:\xwechat_files', expected_account='wxid_synthetic_account', pid=1)):
            item, _ = self.request(); item.pop('metadata')
            item.update(command='catalog_root', selection=selection)
            discover, resolve = Mock(), Mock()
            with self.assertRaises(ReadError):
                serve(input_stream=io.StringIO(json.dumps(item) + '\n'), emit=Mock(), discover=discover, resolve=resolve)
            discover.assert_not_called(); resolve.assert_not_called()


if __name__ == '__main__':
    unittest.main()
