"""Private stdin/stdout identity evidence. No listener, chats, keys or UI actions.

Not enabled by the application yet. Parent owns the process and enforces read
watchdogs. Idle blocks on stdin without keeping a WeChat process handle open.
The caller must supply a freshly checked process/module and approved scope.
"""
import argparse
from dataclasses import asdict
import json
import re
import sys

from identity_calibration_probe import read_json
from identity_discovery import discover_target
from identity_snapshot import observe_identity_snapshot, require_account_snapshot
from native import ProcessIdentity, ModuleIdentity
from reader import ReadError
from static_type_probe import inspect_program


def request(stream, token=None, seq=0, initialize=False):
    raw = stream.readline(2049)
    if raw == '':
        return None
    if len(raw.encode('utf-8')) > 2048 or not raw.endswith('\n'):
        raise ReadError('IDENTITY_CHANNEL_REQUEST_INVALID')
    try:
        item = json.loads(raw)
    except ValueError:
        raise ReadError('IDENTITY_CHANNEL_REQUEST_INVALID') from None
    if (type(item) is not dict or set(item) != {'v', 'token', 'seq', 'command'}
            or type(item['v']) is not int or item['v'] != 1 or type(item['seq']) is not int
            or item['seq'] != seq or type(item['token']) is not str
            or not re.fullmatch('[a-f0-9]{64}', item['token'])
            or token is not None and item['token'] != token
            or item['command'] not in (('initialize',) if initialize else ('sample', 'stop'))):
        raise ReadError('IDENTITY_CHANNEL_REQUEST_INVALID')
    return item


def serve(*, metadata_path, input_stream, emit, inspect=inspect_program, observe=observe_identity_snapshot,
          discover=discover_target):
    first = request(input_stream, initialize=True)
    if first is None:
        return 0
    token = first['token']
    def send(kind, seq, **fields):
        emit(dict(v=1, token=token, seq=seq, kind=kind, **fields))
    if metadata_path is None:
        target = discover()
        if target.state != 'found':
            if target.state not in ('not_running', 'unsupported', 'ambiguous', 'main_process_unavailable'):
                raise ReadError('IDENTITY_CHANNEL_DISCOVERY_INVALID')
            send('unavailable', 0, reason=target.state)
            return 2
        metadata = dict(process=asdict(target.process), module=asdict(target.module), sha256=target.sha256)
    else:
        metadata = read_json(metadata_path, 16384)
    if set(metadata) != {'process', 'module', 'sha256'}:
        raise ReadError('IDENTITY_CHANNEL_METADATA_INVALID')
    process, module = ProcessIdentity(**metadata['process']), ModuleIdentity(**metadata['module'])
    report = inspect(path=module.path, expected_sha256=metadata['sha256'], expected_version=module.version,
        max_bytes=268435456, max_seconds=30, max_references=500000, max_functions=1000000)
    send('ready', 0)
    anchor, seq = None, 1
    while True:
        item = request(input_stream, token, seq)
        if item is None:
            return 0
        if item['command'] == 'stop':
            send('stopped', seq)
            return 0
        cached = anchor is not None
        result = observe(expected_process=process, expected_module=module, report=report,
            expected_sha256=metadata['sha256'], approve_joint_read=True, accept_os_memory_limit=True,
            anchor_rva=anchor, max_bytes=1048576 if cached else 268435456, max_seconds=5 if cached else 15)
        if result.state == 'main_and_account_observed':
            if type(result.account_id) is not str or not re.fullmatch(r'wxid_[A-Za-z0-9_-]{1,120}', result.account_id):
                raise ReadError('IDENTITY_CHANNEL_ACCOUNT_INVALID')
            anchor = require_account_snapshot(result, result.account_id, module.size, anchor)
        elif result.account_id is not None:
            raise ReadError('IDENTITY_CHANNEL_STATE_INVALID')
        send('observed', seq, state=result.state, account=result.account_id)
        seq += 1


def main(argv=None):
    parser = argparse.ArgumentParser(description='Private identity evidence worker; not a standalone login.')
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--metadata')
    selection.add_argument('--discover', action='store_true')
    parser.add_argument('--approve-identity-read', action='store_true', required=True)
    args = parser.parse_args(argv)
    def emit(item):
        print(json.dumps(item), flush=True)
    return serve(metadata_path=args.metadata, input_stream=sys.stdin, emit=emit)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        # No traceback or raw native failure crosses this private channel.
        raise SystemExit(2)
