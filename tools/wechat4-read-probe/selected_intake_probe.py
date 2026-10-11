"""One separately authorized durable selected-group experiment, not a service.

Only counts/stages leave the child. Selected new raw messages are intentionally
stored in an explicitly named isolated local receipt file; full decrypted source
images and keys are not saved. No business DB, delivery, AI or network access.
"""
import argparse
import json
import ntpath
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from acquisition import CipherProfile, Consent
from canary import CaptureSession, MarkerReceipt
from catalog_probe import inspect_entries
from catalog_scope import contact_scope
from catalog_worker import FAILURE_REASONS, decode_metadata
from identity_calibration_probe import read_json
from identity_discovery import discover_target
from identity_bound_capture import IdentityBoundCapture
from native import NativeFile, normal_path
from reader import ReadError, Scope
from selected_intake import IntakeSinkError, SelectedMessageIntake, SINK_FAILURE_REASONS
from snapshot import SQLITE_WINDOWS_PROFILE
from static_type_probe import inspect_program

MESSAGE_FILES = tuple('message/message_' + str(i) + '.db' for i in range(3))
MARKER = 'CLASSREP_TEST_20261010_INTAKE_A'
RESUME_MARKER = 'CLASSREP_TEST_20261010_RESTART_A'
phase = 'prepare'
SAFE_FAILURES = FAILURE_REASONS | frozenset((
    'INTAKE_PROBE_SELECTION_INVALID', 'INTAKE_PROBE_RECEIPT_INVALID', 'INTAKE_PROBE_DIRECTORY_CHANGED',
    'INTAKE_PROBE_TARGET_AMBIGUOUS', 'INTAKE_PROBE_SOURCE_REDIRECTED', 'INTAKE_PROBE_METADATA_TIMEOUT',
    'LOCAL_RECEIPT_OPEN_FAILED', 'LOCAL_RECEIPT_WRITE_FAILED', 'LOCAL_RECEIPT_BINDING_MISMATCH',
    'LOCAL_RECEIPT_CURSORS_INVALID', 'LOCAL_RECEIPT_INTEGRITY_FAILED', 'LOCAL_RECEIPT_FORMAT_MISMATCH',
    'LOCAL_RECEIPT_SCHEMA_MISMATCH', 'SELECTED_INTAKE_NOT_OPEN', 'IDENTITY_CAPTURE_SESSION_NOT_OPEN',
    'LOCAL_RECEIPT_NOT_INITIALIZED',
    'INTAKE_PROBE_WECHAT_NOT_RUNNING', 'INTAKE_PROBE_VERSION_UNSUPPORTED', 'INTAKE_PROBE_MULTIPLE_CLIENTS',
    'INTAKE_PROBE_MAIN_PROCESS_UNAVAILABLE',
))


def failure(error):
    reason = str(error) if isinstance(error, ReadError) and str(error) in SAFE_FAILURES else 'INTAKE_PROBE_FAILED'
    result = {'stage': 'stopped', 'phase': phase, 'reason': reason, 'login_verified': False}
    if type(error) is IntakeSinkError:
        result.update(
            sink_phase=error.sink_phase if error.sink_phase in ('identity_recheck', 'receipt_commit') else 'unknown',
            sink_reason=error.sink_reason if error.sink_reason in SINK_FAILURE_REASONS else 'SELECTED_INTAKE_SINK_FAILED')
    return result


def selection(metadata):
    if type(metadata) is not dict or set(metadata) != {'expected_account', 'account_folder', 'root', 'target_group'}:
        raise ReadError('INTAKE_PROBE_SELECTION_INVALID')
    account, folder, root, target = (metadata[key] for key in ('expected_account', 'account_folder', 'root', 'target_group'))
    if (type(account) is not str or not re.fullmatch(r'wxid_[A-Za-z0-9_-]{1,120}', account)
            or type(folder) is not str or not re.fullmatch(re.escape(account) + r'_[0-9a-f]{4}', folder)
            or type(root) is not str or ntpath.basename(normal_path(root)) != 'xwechat_files'
            or type(target) is not str or not target.strip() or len(target.encode('utf-8')) > 1024 or '\0' in target):
        raise ReadError('INTAKE_PROBE_SELECTION_INVALID')
    return account, folder, root, target


def observe_intake(intake, *, window_seconds=180, poll_seconds=3, clock=time.monotonic, sleep=time.sleep,
                   emit=None, resume_existing=False):
    """Bounded artificial seam; only aggregate counts, never message fields."""
    if emit is None: emit = lambda item: print(json.dumps(item), flush=True)
    if window_seconds != 180 or poll_seconds != 3 or type(resume_existing) is not bool:
        raise ReadError('INTAKE_PROBE_BUDGET_INVALID')
    saved, polls = 0, 0
    marker = MarkerReceipt(RESUME_MARKER if resume_existing else MARKER)
    with intake:
        deadline = clock() + window_seconds
        emit({'stage': 'selected_intake_ready', 'window_seconds': window_seconds,
              'historical_bodies_selected': False, 'resumed_saved_progress': resume_existing,
              'login_verified': False})
        while clock() < deadline and polls < 60:
            result = intake.poll(limit=100, observe_saved=lambda batch: marker(batch, {}))
            saved += result['saved']; polls += 1
            if result['saved']:
                summary = marker.summary()
                emit({'stage': 'selected_intake_observed', 'saved_new_messages': saved,
                      'persisted_marker_count': summary['marker_count'],
                      'marker_timestamps': summary['message_timestamps'], 'login_verified': False})
            sleep(max(0, min(poll_seconds, deadline - clock())))
        status = intake.status()
    return {'stage': 'selected_intake_closed', 'saved_new_messages': saved,
            'pending_messages': status['pending'], 'persisted_marker_count': marker.summary()['marker_count'],
            'polls': polls, 'worker_closed': True, 'login_verified': False}


def worker(args):
    global phase
    metadata = read_json(args.metadata, 16384)
    account, folder, data_root, target = selection(metadata)
    resume = getattr(args, 'approve_existing_receipt_resume', False)
    receipt = Path(args.receipt)
    if (type(resume) is not bool or not re.fullmatch(r'[^/\\]+\.wechat-receipts\.sqlite3', receipt.name)
            or not receipt.is_absolute() or receipt.is_symlink()
            or (not receipt.is_file() if resume else receipt.exists())):
        raise ReadError('INTAKE_PROBE_RECEIPT_INVALID')
    phase = 'identity_discovery'
    discovered = discover_target()
    if discovered.state != 'found':
        code = {'not_running': 'INTAKE_PROBE_WECHAT_NOT_RUNNING',
                'unsupported': 'INTAKE_PROBE_VERSION_UNSUPPORTED',
                'ambiguous': 'INTAKE_PROBE_MULTIPLE_CLIENTS'}.get(discovered.state, 'INTAKE_PROBE_MAIN_PROCESS_UNAVAILABLE')
        raise ReadError(code)
    process, module, sha = discovered.process, discovered.module, discovered.sha256
    phase = 'contact_scope'
    contact_metadata = contact_scope(data_root=data_root, account=account, process=process, module=module,
        sha256=sha, approve_metadata_read=True)
    contact_metadata = decode_metadata(contact_metadata)
    if contact_metadata['account_folder'] != folder:
        raise ReadError('INTAKE_PROBE_DIRECTORY_CHANGED')
    report = inspect_program(path=module.path, expected_sha256=sha, expected_version=process.version,
        max_bytes=268435456, max_seconds=30, max_references=500000, max_functions=1000000)
    phase = 'contact_catalog'
    groups = inspect_entries(contact_metadata, report)
    matching = [group for group in groups if group.name == target]
    if len(matching) != 1:
        raise ReadError('INTAKE_PROBE_TARGET_AMBIGUOUS')
    scope = Scope(account, (matching[0].group_id,))
    del groups, matching
    root = contact_metadata['root']
    selected = {}
    phase = 'message_metadata'
    # Exact three ordinary message files only; no archive/private DB enumeration.
    metadata_deadline = time.monotonic() + 5
    for relative in MESSAGE_FILES:
        if time.monotonic() >= metadata_deadline:
            raise ReadError('INTAKE_PROBE_METADATA_TIMEOUT')
        path = normal_path(ntpath.join(root, relative))
        with NativeFile(path) as handle:
            if handle.path != path or handle.final_path() != path:
                raise ReadError('INTAKE_PROBE_SOURCE_REDIRECTED')
            selected[relative] = (relative, handle.identity())
    if time.monotonic() >= metadata_deadline:
        raise ReadError('INTAKE_PROBE_METADATA_TIMEOUT')
    def session_factory():
        return CaptureSession(scope, Consent(account, True, True, True), process, CipherProfile(process.version, True),
            root=root, selected_databases=selected, vfs_profile=SQLITE_WINDOWS_PROFILE,
            scan_bytes=2147483648, scan_seconds=60, snapshot_bytes=402653184, snapshot_seconds=5)
    capture = IdentityBoundCapture(scope=scope, expected_process=process, expected_module=module, report=report,
        expected_sha256=sha, session_factory=session_factory, approve_joint_read=True, accept_os_memory_limit=True)
    intake = SelectedMessageIntake(scope=scope, capture=capture, receipt_path=args.receipt,
        destination='isolated-intake-probe', approve_selected_storage=True, require_existing_progress=resume)
    phase = 'selected_intake'
    print(json.dumps(observe_intake(intake, resume_existing=True) if resume else observe_intake(intake)), flush=True)
    return 0


def main(argv=None, *, run=subprocess.run):
    parser = argparse.ArgumentParser(description='One explicit 180-second durable selected-group experiment. NOT a service.')
    parser.add_argument('--metadata', required=True)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--approve-existing-receipt-resume', action='store_true',
        help='Separately authorized restart experiment: require saved progress, never create a new baseline.')
    for flag in ('--approve-identity-read', '--approve-key-read', '--approve-contact-read', '--approve-message-read',
                 '--approve-selected-storage', '--accept-os-memory-limit'):
        parser.add_argument(flag, action='store_true', required=True)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not all(getattr(args, name) is True for name in ('approve_identity_read', 'approve_key_read', 'approve_contact_read',
                                                       'approve_message_read', 'approve_selected_storage', 'accept_os_memory_limit')):
        raise ReadError('INTAKE_PROBE_APPROVAL_REQUIRED')
    if args.worker: return worker(args)
    # Parent is an independent fixed watchdog; raw native failures/paths are not printed.
    command = [sys.executable, '-I', '-X', 'utf8', '-B', '-u', '-c',
        'import os,runpy,sys;sys.argv=sys.argv[1:];sys.path.insert(0,os.path.dirname(sys.argv[0]));runpy.run_path(sys.argv[0],run_name="__main__")',
        str(Path(__file__).resolve()), '--worker', '--metadata', args.metadata, '--receipt', args.receipt,
        '--approve-identity-read', '--approve-key-read', '--approve-contact-read', '--approve-message-read',
        '--approve-selected-storage', '--accept-os-memory-limit']
    if args.approve_existing_receipt_resume:
        command.append('--approve-existing-receipt-resume')
    # Inherit stdout for the ready prompt and bounded stages only. No stderr or chat output.
    try:
        result = run(command, stderr=subprocess.DEVNULL, timeout=420, check=False,
            env={key: value for key, value in os.environ.items() if key.lower() in ('systemroot', 'windir', 'temp', 'tmp')},
            creationflags=0x08000000 if sys.platform == 'win32' else 0)
        return 0 if result.returncode == 0 else 2
    except subprocess.TimeoutExpired:
        print(json.dumps({'stage': 'stopped', 'reason': 'INTAKE_PROBE_TIMEOUT', 'login_verified': False}), flush=True)
        return 2


if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception as error:
        print(json.dumps(failure(error)), flush=True)
        raise SystemExit(2)
