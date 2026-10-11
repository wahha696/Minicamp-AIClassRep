"""Bounded, manually sampled calibration; idle periods never read WeChat."""
import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time

from identity_snapshot import observe_identity_snapshot
from native import ModuleIdentity, ProcessIdentity
from reader import ReadError
from static_type_probe import inspect_program


def read_json(path, limit):
    with open(path, 'r', encoding='utf-8-sig') as source:
        raw = source.read(limit + 1)
    if len(raw.encode('utf-8')) > limit:
        raise ReadError('CALIBRATION_INPUT_LIMIT')
    try:
        result = json.loads(raw)
    except (ValueError, TypeError):
        raise ReadError('CALIBRATION_INPUT_INVALID') from None
    if type(result) is not dict:
        raise ReadError('CALIBRATION_INPUT_INVALID')
    return result


@dataclass(repr=False)
class Calibration:
    """Location and comparison values are RAM-only; no login state is cached."""
    expected_account: str
    anchor: int | None = None
    previous: str | None = None

    def sample(self, seq, observe):
        reused = self.anchor is not None
        result = observe(self.anchor, 1024 * 1024 if reused else 256 * 1024 * 1024, 5 if reused else 15)
        account = result.account_id
        event = dict(stage='identity_sampled', seq=seq, state=result.state,
                     account_present=account is not None,
                     expected_account_matched=account == self.expected_account if account is not None else None,
                     changed_from_previous=account != self.previous if account is not None and self.previous is not None else None,
                     anchor_reused=reused, bytes_read=result.bytes_read, window_checks=result.window_checks,
                     login_verified=False)
        if result.anchor_rva is not None:
            self.anchor = result.anchor_rva
        if account is not None:
            self.previous = account  # Comparison only, never authentication.
        return event


class ManualControl:
    """A sequence cannot be reused for a different command, even while idle."""
    def __init__(self, max_samples):
        self.seq, self.command, self.maximum = 0, None, max_samples

    def take(self, document):
        if (type(document) is not dict or set(document) != {'seq', 'command'}
                or type(document['seq']) is not int or not 0 <= document['seq'] <= self.maximum + 1
                or document['command'] not in ('sample', 'stop')
                or document['seq'] == 0 and document['command'] != 'sample'):
            raise ReadError('CALIBRATION_CONTROL_INVALID')
        seq, command = document['seq'], document['command']
        if (seq < self.seq or seq > self.seq + 1
                or seq == self.seq and self.command not in (None, command)):
            raise ReadError('CALIBRATION_CONTROL_SEQUENCE_INVALID')
        if seq == self.seq:
            self.command = command
            return None
        self.seq, self.command = seq, command
        return seq, command


def worker(args):
    metadata = read_json(args.metadata, 16384)
    if (set(metadata) != {'process', 'module', 'sha256', 'expected_account'}
            or type(metadata['expected_account']) is not str
            or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{2,127}', metadata['expected_account'])):
        raise ReadError('CALIBRATION_METADATA_INVALID')
    process, module = ProcessIdentity(**metadata['process']), ModuleIdentity(**metadata['module'])
    report = inspect_program(path=module.path, expected_sha256=metadata['sha256'], expected_version=module.version,
        max_bytes=256 * 1024 * 1024, max_seconds=30, max_references=500000, max_functions=1000000)
    state = Calibration(metadata['expected_account'])
    deadline, samples = time.monotonic() + args.duration, 0
    controls = ManualControl(args.max_samples)
    def emit(event):
        print(json.dumps(event), flush=True)
    emit(dict(stage='calibration_ready', login_verified=False))
    def observe(anchor, budget, seconds):
        return observe_identity_snapshot(expected_process=process, expected_module=module,
            report=report, expected_sha256=metadata['sha256'], approve_joint_read=True,
            accept_os_memory_limit=True, anchor_rva=anchor, max_bytes=budget,
            max_seconds=min(seconds, max(0, deadline - time.monotonic())))
    while time.monotonic() < deadline:
        control = controls.take(read_json(args.control, 1024))
        if control is not None:
            seq, command = control
            if command == 'stop':
                break
            if samples >= args.max_samples:
                raise ReadError('CALIBRATION_SAMPLE_LIMIT')
            emit(dict(stage='sample_started', seq=seq, anchor_reused=state.anchor is not None, login_verified=False))
            emit(state.sample(seq, observe))
            samples += 1
        time.sleep(0.2)  # Control only. No process handles/reads while waiting.
    emit(dict(stage='calibration_finished', samples=samples, login_verified=False))
    return 0


def public_event(raw, max_samples):
    """Strict worker output boundary; no IDs, addresses, tokens or raw errors."""
    if type(raw) is not str or len(raw) > 2048:
        raise ReadError('CALIBRATION_WORKER_OUTPUT_INVALID')
    try:
        item = json.loads(raw)
    except (ValueError, TypeError):
        raise ReadError('CALIBRATION_WORKER_OUTPUT_INVALID') from None
    if type(item) is not dict or item.get('login_verified') is not False:
        raise ReadError('CALIBRATION_WORKER_OUTPUT_INVALID')
    stage = item.get('stage')
    if stage == 'calibration_ready' and set(item) == {'stage', 'login_verified'}:
        return item
    if (stage == 'sample_started' and set(item) == {'stage', 'seq', 'anchor_reused', 'login_verified'}
            and type(item['seq']) is int and 1 <= item['seq'] <= max_samples and type(item['anchor_reused']) is bool):
        return item
    if (stage == 'calibration_finished' and set(item) == {'stage', 'samples', 'login_verified'}
            and type(item['samples']) is int and 0 <= item['samples'] <= max_samples):
        return item
    if (stage == 'stopped' and set(item) == {'stage', 'reason', 'login_verified'}
            and type(item['reason']) is str and re.fullmatch('[A-Z][A-Z0-9_]{0,95}', item['reason'])):
        return item
    if stage == 'identity_sampled':
        expected = {'stage', 'seq', 'state', 'account_present', 'expected_account_matched',
                    'changed_from_previous', 'anchor_reused', 'bytes_read', 'window_checks', 'login_verified'}
        if (set(item) == expected and type(item['seq']) is int and 1 <= item['seq'] <= max_samples
                and item['state'] in ('main_and_account_observed', 'login_page_observed', 'unknown')
                and type(item['account_present']) is bool and type(item['anchor_reused']) is bool
                and all(item[key] is None or type(item[key]) is bool for key in ('expected_account_matched', 'changed_from_previous'))
                and type(item['bytes_read']) is int and 0 < item['bytes_read'] <= (1024 * 1024 if item['anchor_reused'] else 256 * 1024 * 1024)
                and type(item['window_checks']) is int and item['window_checks'] in (1, 2)
                and (item['state'] == 'main_and_account_observed') == item['account_present']
                and (item['state'] == 'main_and_account_observed') == (item['window_checks'] == 2)
                and (item['account_present'] or item['expected_account_matched'] is None and item['changed_from_previous'] is None)
                and (not item['account_present'] or type(item['expected_account_matched']) is bool)):
            return item
    raise ReadError('CALIBRATION_WORKER_OUTPUT_INVALID')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Joint identity calibration only; NOT production login proof.')
    parser.add_argument('--metadata', required=True)
    parser.add_argument('--control', required=True)
    parser.add_argument('--duration', type=int, required=True)
    parser.add_argument('--max-samples', type=int, required=True)
    parser.add_argument('--approve-joint-read', action='store_true', required=True)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not 1 <= args.duration <= 600 or not 1 <= args.max_samples <= 8:
        raise ReadError('EXPLICIT_CALIBRATION_BUDGET_REQUIRED')
    if args.worker:
        return worker(args)
    command = [sys.executable, '-u', '-B', str(Path(__file__).resolve()), '--worker', '--metadata', args.metadata,
               '--control', args.control, '--duration', str(args.duration), '--max-samples', str(args.max_samples), '--approve-joint-read']
    pending = queue.Queue(maxsize=args.max_samples * 2 + 4)
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding='utf-8', creationflags=0x08000000 if sys.platform == 'win32' else 0)
    def collect():
        try:
            for _ in range(args.max_samples * 2 + 3):
                line = process.stdout.readline(2049)
                if not line:
                    break
                pending.put_nowait(line)
        finally:
            try:
                pending.put_nowait(None)
            except queue.Full:
                pass
    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    deadline, finished, stopped = time.monotonic() + args.duration + 40, False, False
    active_deadline, last_seq, active_seq, ready = None, 0, None, False
    try:
        while time.monotonic() < deadline:
            if active_deadline is not None and time.monotonic() >= active_deadline:
                raise ReadError('CALIBRATION_SAMPLE_TIMEOUT')
            try:
                raw = pending.get(timeout=min(0.2, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if raw is None:
                break
            item = public_event(raw, args.max_samples)
            if item['stage'] == 'calibration_ready':
                if ready:
                    raise ReadError('CALIBRATION_WORKER_SEQUENCE_INVALID')
                ready = True
            elif item['stage'] == 'sample_started':
                if not ready or active_seq is not None or item['seq'] != last_seq + 1:
                    raise ReadError('CALIBRATION_WORKER_SEQUENCE_INVALID')
                active_seq = item['seq']
                active_deadline = time.monotonic() + (7 if item['anchor_reused'] else 17)
            elif item['stage'] == 'identity_sampled':
                if item['seq'] != active_seq:
                    raise ReadError('CALIBRATION_WORKER_SEQUENCE_INVALID')
                last_seq, active_seq, active_deadline = item['seq'], None, None
            elif item['stage'] == 'calibration_finished':
                if not ready or active_seq is not None or item['samples'] != last_seq:
                    raise ReadError('CALIBRATION_WORKER_SEQUENCE_INVALID')
            print(json.dumps(item), flush=True)
            if item['stage'] == 'calibration_finished':
                finished = True
            if item['stage'] == 'stopped':
                stopped = True
        if not finished and not stopped:
            raise ReadError('CALIBRATION_WORKER_TIMEOUT_OR_EXIT')
        try:
            code = process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            raise ReadError('CALIBRATION_WORKER_EXIT_TIMEOUT') from None
        return 0 if finished and code == 0 and not stopped else 2
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        reader.join(timeout=1)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(json.dumps(dict(stage='stopped', reason='USER_INTERRUPTED', login_verified=False)), flush=True)
        raise SystemExit(130)
    except Exception as error:
        reason = str(error) if isinstance(error, ReadError) else 'CALIBRATION_FAILED'
        if not re.fullmatch('[A-Z][A-Z0-9_]{0,95}', reason):
            reason = 'CALIBRATION_FAILED'
        print(json.dumps(dict(stage='stopped', reason=reason, login_verified=False)), flush=True)
        raise SystemExit(2)
