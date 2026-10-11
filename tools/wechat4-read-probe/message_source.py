"""Explicit selected-group source factory. Importing does not discover or read.

Only three ordinary message DBs, their WAL/SHM, and account-directory metadata.
contact_names() separately reads contact.db (username/nickname/remark only) so
senders can be shown by name. Full plaintext snapshots and keys remain owned by
the memory capture; contact names live only in worker memory.
"""
import ntpath
import time

from acquisition import CipherProfile, Consent
from canary import CaptureSession
from catalog import acquire_contact_names
from catalog_probe import inspect_entries
from catalog_scope import contact_scope
from catalog_worker import decode_metadata
from identity_discovery import discover_target
from identity_bound_capture import IdentityBoundCapture
from native import NativeFile, normal_path
from reader import ReadError, Scope
from snapshot import SQLITE_WINDOWS_PROFILE
from static_type_probe import inspect_program


def selected_capture(config):
    target = discover_target()
    if target.state != 'found': raise ReadError('MESSAGE_SOURCE_UNAVAILABLE')
    process, module, sha = target.process, target.module, target.sha256
    metadata = decode_metadata(contact_scope(data_root=config['data_root'], account=config['account'],
        process=process, module=module, sha256=sha, approve_metadata_read=True))
    report = inspect_program(path=module.path, expected_sha256=sha, expected_version=process.version,
        max_bytes=268435456, max_seconds=30, max_references=500000, max_functions=1000000)
    root, selected = metadata['root'], {}
    deadline = time.monotonic() + 5
    for index in range(3):
        if time.monotonic() >= deadline: raise ReadError('MESSAGE_SOURCE_METADATA_TIMEOUT')
        relative = 'message/message_' + str(index) + '.db'
        path = normal_path(ntpath.join(root, relative))
        with NativeFile(path) as handle:
            if handle.path != path or handle.final_path() != path:
                raise ReadError('MESSAGE_SOURCE_REDIRECTED')
            selected[relative] = (relative, handle.identity())
    if time.monotonic() >= deadline: raise ReadError('MESSAGE_SOURCE_METADATA_TIMEOUT')
    scope = Scope(config['account'], tuple(group['group_id'] for group in config['groups']))
    def session():
        return CaptureSession(scope, Consent(scope.account, True, True, True), process, CipherProfile(process.version, True),
            root=root, selected_databases=selected, vfs_profile=SQLITE_WINDOWS_PROFILE,
            scan_bytes=2147483648, scan_seconds=60, snapshot_bytes=402653184, snapshot_seconds=5)
    capture = IdentityBoundCapture(scope=scope, expected_process=process, expected_module=module, report=report,
        expected_sha256=sha, session_factory=session, approve_joint_read=True, accept_os_memory_limit=True)
    capture.contact_names = lambda: contact_names(metadata, report)
    return capture


def contact_names(metadata, report):
    """Sender display names from contact/contact.db, between two account identity checks.

    Same approved path as the group catalog; nothing is written to disk. Budgets are
    tighter than the catalog so a slow read cannot outlast the parent's tick timeout.
    """
    def acquire(**options):
        return acquire_contact_names(**{**options, 'max_groups': 200000, 'max_name_bytes': 1024,
            'snapshot_bytes': 67108864, 'scan_seconds': 25})
    return inspect_entries(metadata, report, acquire=acquire)
