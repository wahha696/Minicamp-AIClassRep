"""Synthetic sources, disposable receipts, and in-memory pipes only."""
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from dataclasses import replace
from unittest.mock import Mock

from message_worker import serve
from reader import ReadError, Scope
from test_delivery import ack
from test_reader import GROUP_A
from test_selected_intake import Capture


class Input:
    def __init__(self): self.lines = []
    def append(self, value): self.lines.append(json.dumps(value) + '\n')
    def readline(self, limit): return self.lines.pop(0) if self.lines else ''


class MessageWorkerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='synthetic-message-pipe-')
        self.addCleanup(self.folder.cleanup)
        self.input, self.output = Input(), []
        self.config = dict(account='wxid_synthetic_pipe', data_root='C:\\synthetic\\xwechat_files',
            destination='synthetic-space', groups=[dict(group_id=GROUP_A, name='人工群 😀',
            receipt_path=str(Path(self.folder.name) / 'synthetic.wechat-receipts.sqlite3'),
            activation_id=str(uuid.uuid4()), activation_pending=True, require_existing_progress=False)])
        class SyntheticCapture(Capture):
            def capture(self):
                return tuple(replace(shard, account=self.scope.account) for shard in super().capture())
        self.capture = SyntheticCapture(Scope(self.config['account'], (GROUP_A,)), {GROUP_A: [(1, 1, 1001, 'old')]})
        self.factory = Mock(return_value=self.capture)
        self.input.append(dict(v=1, token='a'*64, seq=0, command='initialize', config=self.config))
    def command(self, seq, name, args=None):
        self.input.append(dict(v=1, token='a'*64, seq=seq, command=name, request=args or {}))
    def emit(self, value):
        self.output.append(value)
        if value['kind'] in ('activation', 'delivery'):
            payload = {'accepted': True} if value['kind'] == 'activation' else ack(value['payload'])
            self.input.append(dict(v=1, token=value['token'], seq=value['seq'], command=value['kind']+'_ack',
                mid=value['mid'], payload=payload))
        elif value['kind'] == 'ready':
            self.capture.rows[GROUP_A].append((2, 2, 1002, 'new selected 😀'))
            self.command(1, 'tick')
        elif value['kind'] == 'result': self.command(value['seq']+1, 'stop')
    def test_private_delivery_ack_after_actual_receipt_commit_and_first_baseline(self):
        self.assertEqual(serve(input_stream=self.input, emit=self.emit, create_capture=self.factory, create_decoder=lambda:None), 0)
        self.assertEqual([v['kind'] for v in self.output], ['activation', 'ready', 'delivery', 'result', 'stopped'])
        delivered = self.output[2]['payload']['messages']
        self.assertEqual([m['text'] for m in delivered], ['new selected 😀'])
        self.assertEqual(self.output[3]['result']['status'][GROUP_A], {'pending': 0, 'deferred': 0})
        self.assertTrue(self.capture.closed)
    def test_slow_history_sends_private_pipe_heartbeat_and_uses_saved_window(self):
        pulse = threading.Event()
        reading_history = [False]
        original_capture = self.capture.capture
        def capture():
            if reading_history[0]:
                self.assertTrue(pulse.wait(2), 'long snapshot must retain a live pipe heartbeat')
            return original_capture()
        self.capture.capture = capture
        def emit(value):
            if value['kind'] == 'ready':
                self.output.append(value)
                reading_history[0] = True
                self.command(1, 'history_start', dict(group_id=GROUP_A, days=1,
                    approve_history_read=True, now_seconds=1700000001))
            elif value['kind'] == 'heartbeat':
                self.output.append(value)
                self.assertEqual(set(value), {'v', 'token', 'seq', 'kind'})
                pulse.set()
            else: self.emit(value)
        self.assertEqual(serve(input_stream=self.input, emit=emit, create_capture=self.factory,
            create_decoder=lambda: None, clock=lambda: 1800000000, heartbeat_seconds=0.005), 0)
        kinds = [value['kind'] for value in self.output]
        self.assertIn('heartbeat', kinds)
        self.assertEqual(kinds[-1], 'stopped')
        # The requested original window includes the synthetic old row; current
        # wall time would exclude it and break resume after an app restart.
        result = next(value['result'] for value in self.output if value['kind'] == 'result')
        self.assertEqual(result['inserted'], 1)
    def test_sender_names_come_from_contacts_with_rate_limited_refresh_and_id_fallback(self):
        lookup = Mock(side_effect=[OSError('synthetic contact read failed'), {'wxid_member': '班长备注', self.config['account']: '自己'}])
        self.capture.contact_names = lookup
        def emit(value):
            if value['kind'] == 'ready':
                self.output.append(value)
                self.capture.rows[GROUP_A].extend([(2, 2, 1002, 'wxid_member:\n明天考试'), (3, 3, 1003, '我发的')])
                self.command(1, 'tick'); return
            self.emit(value)
        clock = iter([0, 1, 700, 701, 702])
        self.assertEqual(serve(input_stream=self.input, emit=emit, create_capture=self.factory, create_decoder=lambda: None,
            monotonic=lambda: next(clock)), 0)
        first = [(m['sender_name'], m['text']) for m in self.output[2]['payload']['messages']]
        # 第一次读联系人失败：退回发信人 ID / 「我」，10 分钟内不重复读
        self.assertCountEqual(first, [('wxid_member', '明天考试'), ('我', '我发的')])
        self.assertEqual(lookup.call_count, 1)
    def test_sender_names_resolved_once_from_contacts(self):
        lookup = Mock(return_value={'wxid_member': '班长备注', self.config['account']: '自己'})
        self.capture.contact_names = lookup
        def emit(value):
            if value['kind'] == 'ready':
                self.output.append(value)
                self.capture.rows[GROUP_A].extend([(2, 2, 1002, 'wxid_member:\n明天考试'), (3, 3, 1003, '我发的')])
                self.command(1, 'tick'); return
            self.emit(value)
        self.assertEqual(serve(input_stream=self.input, emit=emit, create_capture=self.factory, create_decoder=lambda: None), 0)
        self.assertCountEqual([(m['sender_name'], m['text']) for m in self.output[2]['payload']['messages']],
                         [('班长备注', '明天考试'), ('自己', '我发的')])
        self.assertEqual(lookup.call_count, 1)
    def test_wrong_nested_ack_stops_without_losing_durable_pending(self):
        def emit(value):
            if value['kind'] == 'delivery':
                self.output.append(value)
                self.input.append(dict(v=1, token='b'*64, seq=value['seq'], command='delivery_ack', mid=value['mid'], payload={}))
            else: self.emit(value)
        self.assertEqual(serve(input_stream=self.input, emit=emit, create_capture=self.factory, create_decoder=lambda:None), 2)
        self.assertEqual(self.output[-1]['reason'], 'DELIVERY_NOT_ACKNOWLEDGED')
        self.assertTrue(self.capture.closed)
        self.assertIn(b'new selected', Path(self.config['groups'][0]['receipt_path']).read_bytes())
    def test_manual_history_import_keeps_live_progress_and_requires_explicit_request(self):
        def emit(value):
            if value['kind'] == 'ready':
                self.output.append(value)
                self.command(1, 'history_start', dict(group_id=GROUP_A, days=1, approve_history_read=True))
            else: self.emit(value)
        self.assertEqual(serve(input_stream=self.input, emit=emit, create_capture=self.factory, create_decoder=lambda:None, clock=lambda:1700000001), 0)
        self.assertEqual(self.output[2]['kind'], 'delivery')
        self.assertEqual(self.output[3]['result'], {'inserted': 1, 'has_more': False})
        self.assertTrue(self.capture.closed)
    def test_long_history_is_delivered_between_pages_and_live_cursor_remains_independent(self):
        self.capture.rows[GROUP_A] = [(i, i, 1000 + i, 'history ' + str(i)) for i in range(1, 1002)]
        historical_ids, results = set(), []
        def emit(value):
            if value['kind'] == 'ready':
                self.output.append(value)
                self.command(1, 'history_start', dict(group_id=GROUP_A, days=1, approve_history_read=True))
            elif value['kind'] == 'delivery':
                historical_ids.update(message['event_id'] for message in value['payload']['messages'])
                self.emit(value)
            elif value['kind'] == 'result' and 'inserted' in value['result']:
                self.output.append(value)
                results.append(value['result'])
                # Every completed history page is already visible to the business sink.
                self.assertEqual(len(historical_ids), sum(page['inserted'] for page in results))
                if value['result']['has_more']:
                    self.command(value['seq'] + 1, 'history_next')
                else:
                    self.capture.rows[GROUP_A].append((1002, 1002, 2002, 'live after history'))
                    self.command(value['seq'] + 1, 'tick')
            else:
                self.emit(value)
        self.assertEqual(serve(input_stream=self.input, emit=emit, create_capture=self.factory,
            create_decoder=lambda: None, clock=lambda: 1700000001), 0)
        self.assertEqual(results, [{'inserted': 1000, 'has_more': True}, {'inserted': 1, 'has_more': False}])
        self.assertEqual(len(historical_ids), 1002)
        live = [value['result'] for value in self.output if value['kind'] == 'result' and 'saved' in value['result']]
        self.assertEqual(live[0]['saved'][GROUP_A]['saved'], 1)
        self.assertEqual(live[0]['status'][GROUP_A]['pending'], 0)
        self.assertEqual(self.capture.captures, 4)  # baseline, two history pages, one live tick

    def test_history_delivery_ack_failure_does_not_report_complete_or_lose_receipt(self):
        def emit(value):
            self.output.append(value)
            if value['kind'] == 'activation':
                self.input.append(dict(v=1, token=value['token'], seq=value['seq'], command='activation_ack',
                    mid=value['mid'], payload={'accepted': True}))
            elif value['kind'] == 'ready':
                self.command(1, 'history_start', dict(group_id=GROUP_A, days=1, approve_history_read=True))
            elif value['kind'] == 'delivery':
                self.input.append(dict(v=1, token=value['token'], seq=value['seq'], command='delivery_ack',
                    mid=value['mid'], payload={}))
        self.assertEqual(serve(input_stream=self.input, emit=emit, create_capture=self.factory,
            create_decoder=lambda: None, clock=lambda: 1700000001), 2)
        self.assertEqual(self.output[-1]['reason'], 'DELIVERY_ACK_MISMATCH')
        self.assertFalse(any(value['kind'] == 'result' for value in self.output))
        from receipts import LocalReceipts
        with LocalReceipts(Path(self.config['groups'][0]['receipt_path']), self.capture.scope,
                {'shard_A': 'generation_A'}, allow_selected_message_storage=True) as store:
            self.assertEqual(store.delivery_status(self.config['destination'])['pending'], 1)
            self.assertEqual(len(store.stored_messages(limit=100)), 1)

    def test_history_continues_bounded_delivery_without_recapturing_finished_source(self):
        # Simulate pre-existing pending receipts or large texts that fill the byte
        # limit before 100 messages. Draining must remain bounded and resumable.
        intake = Mock()
        intake.__enter__ = Mock(return_value=intake)
        intake.__exit__ = Mock(return_value=False)
        intake.status.return_value = {GROUP_A: {'pending': 1200, 'deferred': 0}}
        intake.refresh_history.return_value = {'inserted': 1, 'next': {}, 'has_more': False}
        intake.deliver.side_effect = [{'has_more': True}] * 11 + [{'has_more': False}]
        results = []
        def emit(value):
            self.output.append(value)
            if value['kind'] == 'ready':
                self.command(1, 'history_start', dict(group_id=GROUP_A, days=1, approve_history_read=True))
            elif value['kind'] == 'result':
                results.append(value['result'])
                if value['result']['has_more']:
                    self.assertEqual(intake.deliver.call_count, 10)
                    self.command(value['seq'] + 1, 'history_next')
                else:
                    self.command(value['seq'] + 1, 'stop')
        self.assertEqual(serve(input_stream=self.input, emit=emit, create_capture=self.factory,
            create_intake=lambda **kwargs: intake, create_decoder=lambda: None), 0)
        self.assertEqual(results, [{'inserted': 1, 'has_more': True}, {'inserted': 0, 'has_more': False}])
        intake.refresh_history.assert_called_once()
        self.assertEqual(intake.deliver.call_count, 12)

    def test_invalid_config_does_not_discover_source_or_create_files(self):
        self.config['groups'][0]['group_id'] = 'wxid_private'
        self.input.lines.clear()
        self.input.append(dict(v=1, token='a'*64, seq=0, command='initialize', config=self.config))
        with self.assertRaises(ReadError): serve(input_stream=self.input, emit=self.emit, create_capture=self.factory)
        self.factory.assert_not_called()
        self.assertEqual(list(Path(self.folder.name).iterdir()), [])
    def test_unexpected_exception_does_not_expose_account_body_or_path(self):
        self.factory.side_effect = RuntimeError('PRIVATE_ACCOUNT_BODY_PATH')
        self.assertEqual(serve(input_stream=self.input, emit=self.emit, create_capture=self.factory, create_decoder=lambda:None), 2)
        self.assertEqual(self.output[-1]['reason'], 'MESSAGE_WORKER_FAILED')
        self.assertNotIn('PRIVATE_ACCOUNT_BODY_PATH', json.dumps(self.output))


if __name__ == '__main__': unittest.main()
