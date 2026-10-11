"""Contact file metadata for an owned identity and user-selected data root.

No account proof, process memory, database content, keys, chat or persistence.
Callers must obtain current identity before and after use; folder names are not
login evidence. This helper is not a public endpoint or an automatic scanner.
"""
from contextlib import ExitStack
from dataclasses import asdict
import math
import ntpath
import os
import re
import time

from catalog_probe import catalog_selection
from identity_discovery import KNOWN_PROFILES
from native import NativeFile, normal_path
from reader import ReadError


def contact_scope(*, data_root, account, process, module, sha256,
                  approve_metadata_read=False, max_entries=8192, max_seconds=5,
                  enumerate_directory=os.scandir, files=NativeFile, clock=time.monotonic):
    if approve_metadata_read is not True:
        raise ReadError('CONTACT_SCOPE_METADATA_CONSENT_REQUIRED')
    if (type(account) is not str or not re.fullmatch(r'wxid_[A-Za-z0-9_-]{1,120}', account)
            or type(data_root) is not str or ntpath.basename(normal_path(data_root)) != 'xwechat_files'):
        raise ReadError('CONTACT_SCOPE_SELECTION_INVALID')
    if (type(max_entries) is not int or not 1 <= max_entries <= 8192
            or type(max_seconds) not in (int, float) or not math.isfinite(max_seconds) or not 0 < max_seconds <= 5):
        raise ReadError('CONTACT_SCOPE_BUDGET_INVALID')
    if (process.version not in KNOWN_PROFILES or sha256 != KNOWN_PROFILES[process.version]
            or module.version != process.version):
        raise ReadError('CONTACT_SCOPE_PROFILE_UNSUPPORTED')
    root = normal_path(data_root)
    deadline = clock() + max_seconds
    def guard():
        if clock() >= deadline:
            raise ReadError('CONTACT_SCOPE_TIME_EXCEEDED')
    guard()
    with ExitStack() as stack:
        root_handle = stack.enter_context(files(root, directory=True))
        if root_handle.path != root:
            raise ReadError('CONTACT_SCOPE_ROOT_REDIRECTED')
        root_id = root_handle.identity()
        candidates = []
        with enumerate_directory(root) as entries:
            for count, entry in enumerate(entries, 1):
                guard()
                if count > max_entries:
                    raise ReadError('CONTACT_SCOPE_ENTRY_LIMIT')
                if re.fullmatch(re.escape(account) + r'_[0-9a-f]{4}', entry.name):
                    if not entry.is_dir(follow_symlinks=False) or entry.is_symlink():
                        raise ReadError('CONTACT_SCOPE_ACCOUNT_REDIRECTED')
                    candidates.append(entry.name)
                    if len(candidates) > 1:
                        raise ReadError('CONTACT_SCOPE_ACCOUNT_AMBIGUOUS')
        if not candidates:
            raise ReadError('CONTACT_SCOPE_ACCOUNT_NOT_FOUND')
        folder = candidates[0]
        account_path = ntpath.join(root, folder)
        db_root = ntpath.join(account_path, 'db_storage')
        paths = (account_path, db_root, ntpath.join(db_root, 'contact'), ntpath.join(db_root, 'contact', 'contact.db'))
        handles = []
        for index, path in enumerate(paths):
            guard()
            handle = stack.enter_context(files(path, directory=index < 3))
            if handle.path != normal_path(path):
                raise ReadError('CONTACT_SCOPE_ACCOUNT_REDIRECTED')
            handles.append((handle, handle.identity()))
        main, file_id = handles[-1]
        if not 0 < main.size() <= 16777216:
            raise ReadError('CONTACT_SCOPE_FILE_LIMIT')
        if root_handle.final_path() != root or root_handle.identity() != root_id:
            raise ReadError('CONTACT_SCOPE_ROOT_CHANGED')
        for handle, identity in handles:
            guard()
            if handle.final_path() != handle.path or handle.identity() != identity:
                raise ReadError('CONTACT_SCOPE_FILE_CHANGED')
            with files(handle.path, directory=handle is not main) as fresh:
                if fresh.path != handle.path or fresh.identity() != identity:
                    raise ReadError('CONTACT_SCOPE_FILE_CHANGED')
        metadata = dict(process=asdict(process), module=asdict(module), sha256=sha256,
            expected_account=account, account_folder=folder, root=normal_path(db_root), expected_file=asdict(file_id))
        catalog_selection(metadata)
        # Strings prevent JavaScript Number rounding before the private worker.
        metadata['process']['created'] = str(metadata['process']['created'])
        metadata['module']['base'] = str(metadata['module']['base'])
        for key in ('volume', 'index', 'created'):
            metadata['expected_file'][key] = str(metadata['expected_file'][key])
        guard()
        return metadata
