"""One approved contact catalog experiment, never a login or collector endpoint.

Metadata is explicit and bounded. Only fixed contact/contact.db + WAL/SHM are
decrypted in RAM, between two joint identity checks. Output is counts and target
presence only, with no group/account IDs, names, keys or private contact fields.
"""
import argparse
import json
import ntpath
from pathlib import Path
import re
import subprocess
import sys

from acquisition import CipherProfile, Consent
from catalog import acquire_groups
from identity_calibration_probe import read_json
from identity_snapshot import observe_identity_snapshot, require_account_snapshot
from managed_windows import validate_managed_profile
from native import FileIdentity, ModuleIdentity, ProcessIdentity, normal_path
from reader import ReadError
from snapshot import SQLITE_WINDOWS_PROFILE
from static_type_probe import inspect_program


def _selection(metadata, target_required):
    keys = {'process', 'module', 'sha256', 'expected_account', 'account_folder',
            'root', 'expected_file'}
    if target_required:
        keys.add('target_group')
    if type(metadata) is not dict or set(metadata) != keys:
        raise ReadError('CONTACT_PROBE_METADATA_INVALID')
    account, folder, root = (metadata[k] for k in ('expected_account', 'account_folder', 'root'))
    target = metadata.get('target_group') if target_required else None
    if (type(account) is not str or not re.fullmatch(r'wxid_[A-Za-z0-9_-]{1,120}', account)
            or type(folder) is not str or not re.fullmatch(re.escape(account) + r'_[0-9a-f]{4}', folder)
            or type(root) is not str or normal_path(root) != root
            or ntpath.basename(root) != 'db_storage'
            or ntpath.basename(ntpath.dirname(root)) != folder.lower()
            or target_required and (type(target) is not str or not target.strip() or '\0' in target or len(target.encode('utf-8')) > 1024)):
        raise ReadError('CONTACT_PROBE_SELECTION_INVALID')
    try:
        process = ProcessIdentity(**metadata['process'])
        module = ModuleIdentity(**metadata['module'])
        file = FileIdentity(**metadata['expected_file'])
    except (TypeError, ValueError):
        raise ReadError('CONTACT_PROBE_IDENTITIES_INVALID') from None
    if (any(type(v) is not int or v < 0 for v in (file.volume, file.index, file.created))
            or file.index == 0 or file.created == 0):
        raise ReadError('CONTACT_PROBE_IDENTITIES_INVALID')
    return process, module, file


def selection(metadata):
    return _selection(metadata, True)


def catalog_selection(metadata):
    return _selection(metadata, False)


def inspect_entries(metadata, report, *, observe=observe_identity_snapshot, acquire=acquire_groups):
    """Entries only for a private owned pipe; no CLI display or persistence."""
    process, module, file = catalog_selection(metadata)
    validate_managed_profile(expected_process=process, expected_module=module, report=report,
        expected_sha256=metadata['sha256'], approve_managed_read=True,
        max_windows=32, max_bytes=1048576, max_nodes=4096, max_seconds=5)
    options = dict(expected_process=process, expected_module=module, report=report,
        expected_sha256=metadata['sha256'], approve_joint_read=True, accept_os_memory_limit=True)
    before = observe(**options, max_bytes=268435456, max_seconds=15)
    anchor = require_account_snapshot(before, metadata['expected_account'], module.size)
    entries = acquire(account=metadata['account_folder'], root=metadata['root'], expected_process=process,
        expected_file=file, consent=Consent(metadata['account_folder'], True, True, True),
        cipher_profile=CipherProfile(process.version, True), vfs_profile=SQLITE_WINDOWS_PROFILE,
        approve_contact_metadata=True, scan_bytes=2147483648, scan_seconds=60, scan_hits=1024,
        snapshot_bytes=16777216, snapshot_seconds=5, max_groups=10000, max_name_bytes=1024)
    after = observe(**options, anchor_rva=anchor, max_bytes=1048576, max_seconds=5)
    require_account_snapshot(after, metadata['expected_account'], module.size, anchor)
    return entries


def inspect_catalog(metadata, report, *, observe=observe_identity_snapshot, acquire=acquire_groups):
    selection(metadata)
    entries = inspect_entries({key: value for key, value in metadata.items() if key != 'target_group'},
        report, observe=observe, acquire=acquire)
    matches = sum(entry.name == metadata['target_group'] for entry in entries)
    return dict(stage='contact_catalog_observed', group_count=len(entries), target_matches=matches,
        target_unique=matches == 1, identity_checks=2, login_verified=False)


def worker(metadata_path):
    metadata = read_json(metadata_path, 32768)
    process, module, _ = selection(metadata)
    report = inspect_program(path=module.path, expected_sha256=metadata['sha256'], expected_version=process.version,
        max_bytes=268435456, max_seconds=30, max_references=500000, max_functions=1000000)
    print(json.dumps(inspect_catalog(metadata, report)), flush=True)
    return 0


def public_result(result):
    try:
        if len(result.stdout) > 2048:
            raise ValueError()
        item = json.loads(result.stdout)
        if type(item) is not dict or item.get('login_verified') is not False:
            raise ValueError()
        if (result.returncode == 2 and set(item) == {'stage', 'reason', 'login_verified'}
                and item['stage'] == 'stopped' and type(item['reason']) is str
                and re.fullmatch('[A-Z][A-Z0-9_]{0,95}', item['reason'])):
            return item
        if (result.returncode == 0 and set(item) == {'stage', 'group_count', 'target_matches',
                'target_unique', 'identity_checks', 'login_verified'}
                and item['stage'] == 'contact_catalog_observed'
                and type(item['group_count']) is int and 0 <= item['group_count'] <= 10000
                and type(item['target_matches']) is int and 0 <= item['target_matches'] <= item['group_count']
                and type(item['target_unique']) is bool and item['target_unique'] == (item['target_matches'] == 1)
                and type(item['identity_checks']) is int and item['identity_checks'] == 2):
            return item
    except (ValueError, TypeError):
        pass
    return dict(stage='stopped', reason='CONTACT_PROBE_WORKER_FAILED', login_verified=False)


def main(argv=None, *, run=subprocess.run):
    parser = argparse.ArgumentParser(description='Explicit contact-catalog experiment; NOT login proof.')
    parser.add_argument('--metadata', required=True)
    for flag in ('--approve-account-read', '--approve-key-read', '--approve-contact-read', '--accept-os-memory-limit'):
        parser.add_argument(flag, action='store_true', required=True)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.worker:
        return worker(args.metadata)
    command = [sys.executable, '-B', str(Path(__file__).resolve()), '--worker', '--metadata', args.metadata,
        '--approve-account-read', '--approve-key-read', '--approve-contact-read', '--accept-os-memory-limit']
    try:
        result = run(command, capture_output=True, text=True, encoding='utf-8', timeout=120, check=False,
            creationflags=0x08000000 if sys.platform == 'win32' else 0)
        item = public_result(result)
    except subprocess.TimeoutExpired:
        item = dict(stage='stopped', reason='CONTACT_PROBE_WORKER_TIMEOUT', login_verified=False)
    print(json.dumps(item), flush=True)
    return 0 if item['stage'] == 'contact_catalog_observed' else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(json.dumps(dict(stage='stopped', reason='USER_INTERRUPTED', login_verified=False)), flush=True)
        raise SystemExit(130)
    except Exception as error:
        reason = str(error) if isinstance(error, ReadError) else 'CONTACT_PROBE_FAILED'
        if not re.fullmatch('[A-Z][A-Z0-9_]{0,95}', reason):
            reason = 'CONTACT_PROBE_FAILED'
        print(json.dumps(dict(stage='stopped', reason=reason, login_verified=False)), flush=True)
        raise SystemExit(2)
