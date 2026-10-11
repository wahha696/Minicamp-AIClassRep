"""Owned local pipes only. Parent enforces timeouts, identity and destination.

No listener, AI, uploads, implicit launch or public diagnostics containing data.
Selected receipt storage is intentional; keys/full source images are not saved.
"""
import argparse
import json
import ntpath
import re
import sys
import time

from catalog_worker import FAILURE_REASONS
from cng import CryptoError
from group_intake import GroupMessageIntake, GroupPlan
from message_source import selected_capture
from reader import ReadError
from receipts import LocalReceipts
from selected_intake import IntakeSinkError, SINK_FAILURE_REASONS
from zstd_package import PackagedZstdDecoder

LIMIT = 8388608
SAFE_FAILURES = FAILURE_REASONS | SINK_FAILURE_REASONS | frozenset((
    'MESSAGE_SOURCE_UNAVAILABLE', 'MESSAGE_SOURCE_METADATA_TIMEOUT', 'MESSAGE_SOURCE_REDIRECTED',
    'MESSAGE_CHANNEL_REQUEST_INVALID', 'MESSAGE_CHANNEL_ACK_INVALID', 'MESSAGE_CHANNEL_LIMIT',
    'LOCAL_RECEIPT_ACTIVATION_MISMATCH', 'LOCAL_RECEIPT_NOT_INITIALIZED', 'LOCAL_RECEIPT_BINDING_MISMATCH',
    'LOCAL_RECEIPT_OPEN_FAILED', 'LOCAL_RECEIPT_FORMAT_MISMATCH', 'LOCAL_RECEIPT_SCHEMA_MISMATCH',
    'LOCAL_RECEIPT_INTEGRITY_FAILED', 'DELIVERY_ACK_MISMATCH', 'DELIVERY_NOT_ACKNOWLEDGED',
    'ZSTD_PACKAGE_UNAVAILABLE', 'ZSTD_PACKAGE_VERSION_UNSUPPORTED',
))


def read(stream):
    raw = stream.readline(LIMIT + 1)
    if raw == '': return None
    if not raw.endswith('\n') or len(raw.encode('utf-8')) > LIMIT:
        raise ReadError('MESSAGE_CHANNEL_LIMIT')
    try: return json.loads(raw)
    except ValueError: raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID') from None


def configuration(value):
    if (type(value) is not dict or set(value) != {'account', 'data_root', 'destination', 'groups'}
            or type(value['account']) is not str or not re.fullmatch(r'wxid_[A-Za-z0-9_-]{1,120}', value['account'])
            or type(value['data_root']) is not str or len(value['data_root']) > 4096
            or '\0' in value['data_root'] or not re.match(r'^[A-Za-z]:[\\/]', value['data_root'])
            or ntpath.basename(ntpath.normpath(value['data_root'])).lower() != 'xwechat_files'
            or type(value['groups']) is not list or not 1 <= len(value['groups']) <= 10000):
        raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
    LocalReceipts._destination(value['destination'])
    ids, paths = set(), set()
    for group in value['groups']:
        if (type(group) is not dict or set(group) != {'group_id', 'name', 'receipt_path', 'activation_id',
                'activation_pending', 'require_existing_progress'}
                or type(group['group_id']) is not str or not re.fullmatch(r'[A-Za-z0-9_-]+@chatroom', group['group_id'])
                or type(group['name']) is not str or len(group['name'].encode('utf-8')) > 4096
                or type(group['receipt_path']) is not str or not ntpath.isabs(group['receipt_path'])
                or group['receipt_path'].startswith('\\\\') or '\0' in group['receipt_path']
                or not group['receipt_path'].endswith('.wechat-receipts.sqlite3')
                or type(group['activation_pending']) is not bool or type(group['require_existing_progress']) is not bool):
            raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
        LocalReceipts._activation(group['activation_id'])
        path = ntpath.normcase(ntpath.normpath(group['receipt_path']))
        if group['group_id'] in ids or path in paths: raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
        ids.add(group['group_id']); paths.add(path)
    return value


def envelope(value, token, seq, keys):
    if (type(value) is not dict or set(value) != {'v', 'token', 'seq', *keys}
            or type(value['v']) is not int or value['v'] != 1
            or type(value['seq']) is not int or value['seq'] != seq
            or type(value['token']) is not str or not re.fullmatch('[a-f0-9]{64}', value['token'])
            or token is not None and value['token'] != token):
        raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')


NAME_REFRESH_SECONDS = 600  # Unknown senders re-read contact.db at most this often.
HISTORY_PAGE_LIMIT = 1000
DELIVERY_TURNS = 10  # Bound each command, including draining pre-existing receipts.


def serve(*, input_stream, emit, create_capture=selected_capture, create_intake=GroupMessageIntake,
          create_decoder=PackagedZstdDecoder, clock=time.time, monotonic=time.monotonic):
    first = read(input_stream)
    if first is None: return 0
    envelope(first, None, 0, {'command', 'config'})
    if first['command'] != 'initialize': raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
    config, token, seq, mid = configuration(first['config']), first['token'], 0, 0
    intake = None
    def send(kind, **fields):
        value = dict(v=1, token=token, seq=seq, kind=kind, **fields)
        if len(json.dumps(value, ensure_ascii=False).encode('utf-8')) + 1 > LIMIT:
            raise ReadError('MESSAGE_CHANNEL_LIMIT')
        emit(value)
    def exchange(kind, payload):
        nonlocal mid
        mid += 1
        send(kind, mid=mid, payload=payload)
        ack = read(input_stream)
        envelope(ack, token, seq, {'command', 'mid', 'payload'})
        if ack['command'] != kind + '_ack' or type(ack['mid']) is not int or ack['mid'] != mid:
            raise ReadError('MESSAGE_CHANNEL_ACK_INVALID')
        return ack['payload']
    def activated(group, activation):
        result = exchange('activation', dict(group_id=group, activation_id=activation))
        if result != {'accepted': True} or type(result.get('accepted')) is not bool:
            raise ReadError('MESSAGE_CHANNEL_ACK_INVALID')
    try:
        zstd = create_decoder()  # Only after validated explicit parent consent.
        capture = create_capture(config)
        try:
            plans = tuple(GroupPlan(**{key: row[key] for key in ('group_id', 'receipt_path', 'activation_id',
                'activation_pending', 'require_existing_progress')}) for row in config['groups'])
            intake = create_intake(scope=capture.scope, capture=capture, plans=plans, destination=config['destination'],
                approve_selected_storage=True, activation_committed=activated)
        except BaseException:
            capture.close()
            raise
        names = {row['group_id']: row['name'] for row in config['groups']}
        contacts, loaded_at = {}, None
        def refresh_contacts():
            nonlocal contacts, loaded_at
            loaded_at = monotonic()
            lookup = getattr(capture, 'contact_names', None)
            if lookup is None: return
            try: found = lookup()
            except Exception: return  # Names are optional; delivery falls back to the sender ID.
            if type(found) is dict and all(type(k) is str and type(v) is str for k, v in found.items()):
                contacts = found
        def resolve(group, sender):
            own = sender is None
            username = config['account'] if own else sender
            if username not in contacts and (loaded_at is None or monotonic() - loaded_at >= NAME_REFRESH_SECONDS):
                refresh_contacts()
            return names[group], contacts.get(username) or ('我' if own else username)
        def drain(group):
            for _ in range(DELIVERY_TURNS):
                result = intake.deliver(group, resolve,
                    lambda document: exchange('delivery', document), zstd=zstd)
                if not result['has_more']:
                    return False
            return True
        history, source_done = None, False
        with intake:
            send('ready', status=intake.status())
            seq = 1
            while True:
                command = read(input_stream)
                if command is None: return 0
                envelope(command, token, seq, {'command', 'request'})
                name, args, mid = command['command'], command['request'], 0
                if type(args) is not dict: raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
                if name == 'stop' and not args:
                    send('stopped'); return 0
                if name == 'tick' and not args:
                    saved = intake.poll(limit=100)
                    delivered = {group: intake.deliver(group, resolve,
                        lambda document: exchange('delivery', document), zstd=zstd) for group in names}
                    send('result', result=dict(saved=saved, delivered=delivered, status=intake.status()))
                elif name in ('history_start', 'history_next'):
                    if name == 'history_start':
                        if (set(args) != {'group_id', 'days', 'approve_history_read'} or args['group_id'] not in names
                                or type(args['days']) is not int or args['days'] not in (1, 7, 30)
                                or args['approve_history_read'] is not True): raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
                        history = dict(group=args['group_id'], days=args['days'], now_seconds=clock(), after=None)
                        source_done = False
                    elif args or history is None: raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
                    inserted = 0
                    if not source_done:
                        page = intake.refresh_history(**history, limit=HISTORY_PAGE_LIMIT, approve_history_read=True)
                        history['after'] = page['next']
                        source_done, inserted = not page['has_more'], page['inserted']
                    # History is complete only after business ingestion acknowledges
                    # the selected receipts. Continue draining without recapturing
                    # source databases when the history cursor has reached its end.
                    delivery_pending = drain(history['group'])
                    has_more = not source_done or delivery_pending
                    if not has_more: history = None
                    send('result', result=dict(inserted=inserted, has_more=has_more))
                elif name in ('issues', 'retry_issues'):
                    keys = {'group_id'} if name == 'issues' else {'group_id', 'event_ids'}
                    if set(args) != keys or args['group_id'] not in names: raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
                    group = args['group_id']
                    if name == 'issues':
                        result = list(intake.issues(group, limit=100))
                    else:
                        ids = args['event_ids']
                        if (type(ids) is not list or not 1 <= len(ids) <= 100 or len(set(ids)) != len(ids)
                                or any(type(event) is not str or not re.fullmatch('[a-f0-9]{64}', event) for event in ids)):
                            raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
                        intake.retry_issues(group, tuple(ids)); result = intake.status()
                    send('result', result=result)
                elif name == 'status' and not args: send('result', result=intake.status())
                else: raise ReadError('MESSAGE_CHANNEL_REQUEST_INVALID')
                seq += 1
    except Exception as error:
        reason = str(error) if isinstance(error, (ReadError, CryptoError)) and str(error) in SAFE_FAILURES else 'MESSAGE_WORKER_FAILED'
        fields = {}
        if type(error) is IntakeSinkError: fields = dict(sink_phase=error.sink_phase, sink_reason=error.sink_reason)
        send('error', reason=reason, **fields)
        return 2
    finally:
        if intake is not None: intake.close()


def main():
    parser = argparse.ArgumentParser(description='Owned selected-group message worker.')
    for flag in ('--approve-identity-read', '--approve-key-read', '--approve-message-read', '--approve-selected-storage'):
        parser.add_argument(flag, action='store_true', required=True)
    parser.parse_args()
    return serve(input_stream=sys.stdin, emit=lambda value: print(json.dumps(value, ensure_ascii=False), flush=True))


if __name__ == '__main__':
    try: raise SystemExit(main())
    except KeyboardInterrupt: raise SystemExit(130)
    except Exception: raise SystemExit(2)  # Never print raw exceptions or tracebacks.
