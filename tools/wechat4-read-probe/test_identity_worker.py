from dataclasses import asdict
import io
import json
import unittest
from unittest.mock import Mock, patch

from identity_snapshot import IdentitySnapshot
from identity_worker import request, serve
from identity_discovery import Discovery
from reader import ReadError
from test_managed_windows import PROCESS, MODULE, SHA

TOKEN = 'a' * 64


def command(seq, name='sample', **changes):
    return json.dumps({**dict(v=1, token=TOKEN, seq=seq, command=name), **changes}) + '\n'


class WorkerTests(unittest.TestCase):
    def test_automatic_discovery_uses_current_metadata_without_saved_account_or_pid(self):
        events = []
        inspect, observe = Mock(return_value='profile'), Mock()
        target = Discovery('found', PROCESS, MODULE, SHA)
        with patch('identity_worker.read_json') as read:
            code = serve(metadata_path=None, input_stream=io.StringIO(command(0, 'initialize')),
                emit=events.append, inspect=inspect, observe=observe, discover=Mock(return_value=target))
        self.assertEqual(code, 0)
        read.assert_not_called(); observe.assert_not_called()
        self.assertEqual(events[0]['kind'], 'ready')

    def test_unavailable_discovery_does_not_inspect_file_or_read_account(self):
        for state in ('not_running', 'unsupported', 'ambiguous', 'main_process_unavailable'):
            inspect, observe, events = Mock(), Mock(), []
            code = serve(metadata_path=None, input_stream=io.StringIO(command(0, 'initialize')),
                emit=events.append, inspect=inspect, observe=observe, discover=Mock(return_value=Discovery(state)))
            self.assertEqual(code, 2)
            self.assertEqual(events[0]['reason'], state)
            inspect.assert_not_called(); observe.assert_not_called()

    def run_worker(self, stream, observe):
        events = []
        metadata = dict(process=asdict(PROCESS), module=asdict(MODULE), sha256=SHA)
        with patch('identity_worker.read_json', return_value=metadata):
            code = serve(metadata_path='synthetic', input_stream=io.StringIO(stream), emit=events.append,
                inspect=Mock(return_value='synthetic-profile'), observe=observe)
        return code, events

    def test_idle_initialization_and_eof_never_read_process_memory(self):
        observe = Mock()
        code, events = self.run_worker(command(0, 'initialize'), observe)
        self.assertEqual(code, 0)
        self.assertEqual([e['kind'] for e in events], ['ready'])
        observe.assert_not_called()

    def test_samples_read_fresh_accounts_and_only_cache_location(self):
        observe = Mock(side_effect=[IdentitySnapshot('main_and_account_observed', 'wxid_synthetic_first', 0x3000, 999, 2),
            IdentitySnapshot('login_page_observed', None, None, 999, 1),
            IdentitySnapshot('main_and_account_observed', 'wxid_synthetic_other', 0x3000, 999, 2)])
        stream = command(0, 'initialize') + ''.join(command(i) for i in range(1, 4)) + command(4, 'stop')
        code, events = self.run_worker(stream, observe)
        self.assertEqual(code, 0)
        self.assertEqual([e.get('account') for e in events[1:-1]], ['wxid_synthetic_first', None, 'wxid_synthetic_other'])
        self.assertEqual([e['seq'] for e in events], list(range(5)))
        self.assertEqual(observe.call_args_list[0].kwargs['max_bytes'], 268435456)
        self.assertEqual(observe.call_args_list[1].kwargs['max_bytes'], 1048576)
        self.assertTrue(all(e['token'] == TOKEN for e in events))
        self.assertNotIn('0x3000', json.dumps(events))

    def test_scan_failure_is_not_an_old_success(self):
        observe = Mock(side_effect=ReadError('SYNTHETIC_PROCESS_CHANGED'))
        with self.assertRaises(ReadError):
            self.run_worker(command(0, 'initialize') + command(1), observe)

    def test_invalid_token_sequence_or_shape_is_rejected(self):
        for raw in (command(2), command(1, token='b' * 64), command(1, v=True),
                    command(1, private='body'), '{}\n', 'x' * 2049):
            with self.subTest(raw=raw[:50]), self.assertRaises(ReadError):
                request(io.StringIO(raw), TOKEN, 1)

    def test_malformed_or_contradictory_account_evidence_does_not_escape(self):
        for result in (IdentitySnapshot('main_and_account_observed', 'private text', 0x3000, 999, 2),
                       IdentitySnapshot('unknown', 'wxid_synthetic_first', None, 999, 1),
                       IdentitySnapshot('main_and_account_observed', 'wxid_synthetic_first', None, 999, 2)):
            with self.subTest(state=result.state), self.assertRaises(ReadError):
                self.run_worker(command(0, 'initialize') + command(1), Mock(return_value=result))


if __name__ == '__main__':
    unittest.main()
