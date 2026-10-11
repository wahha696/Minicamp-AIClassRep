"""One opt-in contact catalog through an owned pipe; no listener or disk cache.

Parent must enforce 120-second timeout and cancel on its identity-source change.
Account/module/file metadata comes from the owned connection, never an HTTP wxid.
"""
import argparse
import json
import ntpath
import re
import sys

from catalog_probe import catalog_selection, inspect_entries
from catalog import AccountCatalog, acquire_groups
from reader import ReadError
from cng import CryptoError
from catalog_scope import contact_scope
from identity_discovery import discover_target
from native import normal_path
from static_type_probe import inspect_program

# Exact known constants only; never forward exception text or a traceback.
FAILURE_REASONS = frozenset((
    'ACCOUNT_ANCHOR_AMBIGUOUS',
    'ACCOUNT_ANCHOR_CHANGED',
    'ACCOUNT_ANCHOR_NOT_FOUND',
    'ACCOUNT_ANCHOR_OUTSIDE_MODULE',
    'ACCOUNT_MISMATCH',
    'ACCOUNT_OBSERVATION_BYTE_BUDGET_EXCEEDED',
    'ACCOUNT_OBSERVATION_TIME_EXCEEDED',
    'ACCOUNT_POINTER_INVALID',
    'ACCOUNT_ROOT_CHANGED',
    'ACCOUNT_ROOT_MISMATCH',
    'ACCOUNT_ROOT_REDIRECTED',
    'ACCOUNT_STRING_INVALID',
    'ACCOUNT_STRING_LAYOUT_UNSUPPORTED',
    'ACCOUNT_VALUE_CHANGED',
    'AES256_KEY_LENGTH',
    'AES_BLOCK_LENGTH',
    'AES_OUTPUT_LENGTH',
    'BATCH_LIMIT',
    'BATCH_NOT_ACKNOWLEDGED',
    'CATALOG_CAPTURE_FAILED',
    'CATALOG_STATIC_ANALYSIS_FAILED',
    'CIPHER_MARKER_NOT_FOUND',
    'CONTACT_CAPTURE_SCOPE_MISMATCH',
    'CONTACT_CATALOG_GROUP_LIMIT',
    'CONTACT_CATALOG_QUERY_FAILED',
    'CONTACT_GROUP_ID_INVALID_OR_DUPLICATE',
    'CONTACT_GROUP_NAME_INVALID_OR_LIMIT',
    'CONTACT_IMAGE_BUDGET_OR_TYPE_INVALID',
    'CONTACT_METADATA_CONFIRMATION_REQUIRED',
    'CONTACT_PROBE_IDENTITIES_INVALID',
    'CONTACT_PROBE_METADATA_INVALID',
    'CONTACT_PROBE_SELECTION_INVALID',
    'CONTACT_SCHEMA_UNSUPPORTED',
    'CONTACT_SCOPE_ACCOUNT_AMBIGUOUS',
    'CONTACT_SCOPE_ACCOUNT_NOT_FOUND',
    'CONTACT_SCOPE_ACCOUNT_REDIRECTED',
    'CONTACT_SCOPE_BUDGET_INVALID',
    'CONTACT_SCOPE_ENTRY_LIMIT',
    'CONTACT_SCOPE_FILE_CHANGED',
    'CONTACT_SCOPE_FILE_LIMIT',
    'CONTACT_SCOPE_METADATA_CONSENT_REQUIRED',
    'CONTACT_SCOPE_PROFILE_UNSUPPORTED',
    'CONTACT_SCOPE_ROOT_CHANGED',
    'CONTACT_SCOPE_ROOT_REDIRECTED',
    'CONTACT_SCOPE_SELECTION_INVALID',
    'CONTACT_SCOPE_TIME_EXCEEDED',
    'CURSOR_INVALID',
    'DB_FINAL_PATH_MISMATCH',
    'DB_GENERATION_CHANGED',
    'DECODED_PAGE_SIZE',
    'EXPLICIT_ACCOUNT_OBSERVATION_BUDGET_REQUIRED',
    'EXPLICIT_ACCOUNT_PROFILE_AND_IDENTITIES_REQUIRED',
    'EXPLICIT_ACCOUNT_REQUIRED',
    'EXPLICIT_ACCOUNT_SELECTION_REQUIRED',
    'EXPLICIT_ALL_CURSORS_REQUIRED',
    'EXPLICIT_CONTACT_CATALOG_BUDGET_REQUIRED',
    'EXPLICIT_CONTACT_IDENTITIES_REQUIRED',
    'EXPLICIT_DATABASE_IDENTITIES_AND_VFS_REQUIRED',
    'EXPLICIT_EXPERIMENTAL_CIPHER_PROFILE_REQUIRED',
    'EXPLICIT_JOINT_ANCHOR_REQUIRED',
    'EXPLICIT_JOINT_IDENTITY_BUDGET_REQUIRED',
    'EXPLICIT_MANAGED_PROCESS_REQUIRED',
    'EXPLICIT_MANAGED_WINDOW_BUDGET_REQUIRED',
    'EXPLICIT_MODULE_AMBIGUOUS',
    'EXPLICIT_MODULE_MISSING',
    'EXPLICIT_PID_REQUIRED',
    'EXPLICIT_RELATIVE_DB_REQUIRED',
    'EXPLICIT_SCAN_BUDGET_REQUIRED',
    'EXPLICIT_SELECTED_FIRST_PAGES_REQUIRED',
    'EXPLICIT_SHARD_MANIFEST_REQUIRED',
    'EXPLICIT_UNIQUE_GROUPS_REQUIRED',
    'EXPLICIT_VERIFIED_PROCESS_IDENTITY_REQUIRED',
    'EXPLICIT_VFS_PROFILE_REQUIRED',
    'EXPLICIT_WINDOW_MAPPER_REQUIRED',
    'EXPLICIT_WINDOW_MAP_BUDGET_REQUIRED',
    'EXPLICIT_WINDOW_MAP_TARGETS_REQUIRED',
    'FILE_CLOSE_FAILED',
    'FILE_METADATA_FAILED',
    'FILE_OPEN_READ_FAILED',
    'FILE_OR_DIRECTORY_TYPE_MISMATCH',
    'FILE_READ_BOUNDS',
    'FILE_SEEK_FAILED',
    'FILE_SHORT_READ',
    'FINAL_PATH_FAILED',
    'IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT',
    'IMMUTABLE_SNAPSHOT_REQUIRED',
    'JOINT_ACCOUNT_CHANGED',
    'JOINT_IDENTITY_BYTE_LIMIT',
    'JOINT_IDENTITY_CONFIRMATION_REQUIRED',
    'JOINT_IDENTITY_TIME_EXCEEDED',
    'JOINT_PROCESS_OR_MODULE_CHANGED',
    'JOINT_WINDOW_STATE_CHANGED',
    'KEY_CLOSED',
    'KEY_MARKER_HIT_LIMIT',
    'KEY_PENDING_REFERENCE_LIMIT',
    'KEY_REFERENCE_HIT_LIMIT',
    'KEY_SCAN_BYTE_BUDGET_EXCEEDED',
    'KEY_SCAN_CANDIDATE_LIMIT',
    'KEY_SCAN_TIME_EXCEEDED',
    'LOCAL_ABSOLUTE_PATH_REQUIRED',
    'MAIN_SIZE_OR_BUDGET',
    'MANAGED_PROCESS_OR_MODULE_CHANGED',
    'MANAGED_RUNTIME_PROFILE_CHANGED',
    'MANAGED_STATIC_PROFILE_INVALID',
    'MANAGED_TARGET_WINDOW_SET_INVALID',
    'MANAGED_WINDOW_BUDGET_EXCEEDED',
    'MANAGED_WINDOW_BYTE_LIMIT',
    'MANAGED_WINDOW_CONFIRMATION_REQUIRED',
    'MANAGED_WINDOW_OWNER_CHANGED',
    'MANAGED_WINDOW_SET_CHANGED',
    'MANAGED_WINDOW_SHORT_READ',
    'MANAGED_WINDOW_TIME_EXCEEDED',
    'MESSAGE_CURSOR_NOT_UNIQUE',
    'MESSAGE_SCHEMA_UNSUPPORTED',
    'MESSAGE_TABLE_UNSUPPORTED',
    'NATIVE_FILE_IDENTITY_REQUIRED',
    'NO_CIPHER_CANDIDATES',
    'PAGE_AUTHENTICATION_FAILED',
    'PAGE_SIZE_OR_NUMBER',
    'PROCESS_CHANGED_OR_EXITED',
    'PROCESS_CLOSE_FAILED',
    'PROCESS_IDENTITY_CHANGED',
    'PROCESS_MODULE_CLOSE_FAILED',
    'PROCESS_MODULE_IDENTITY_CHANGED',
    'PROCESS_MODULE_METADATA_FAILED',
    'PROCESS_PATH_OR_VERSION_MISMATCH',
    'PROCESS_READ_ACCESS_FAILED',
    'PROCESS_READ_BOUNDS',
    'PROCESS_REGION_ENUMERATION_FAILED',
    'PROCESS_REGION_INVALID',
    'PROCESS_SHORT_READ',
    'PROCESS_VERSION_FAILED',
    'READ_ALREADY_RUNNING',
    'REAL_READ_SCOPE_CONFIRMATION_REQUIRED',
    'RUNTIME_ACCOUNT_READ_CONFIRMATION_REQUIRED',
    'SELECTED_DB_KEY_MISSING_OR_AMBIGUOUS',
    'SELECTED_GROUP_NOT_FOUND',
    'SHARD_GENERATION_CHANGED',
    'SHARD_MANIFEST_MISMATCH',
    'SNAPSHOT_LIMIT',
    'SNAPSHOT_LOCK_BUSY',
    'SNAPSHOT_MISSING_PAGE',
    'SNAPSHOT_SIZE_OR_BUDGET',
    'SNAPSHOT_SOURCE_CHANGED',
    'SNAPSHOT_TIME_EXCEEDED',
    'SNAPSHOT_TIME_LIMIT',
    'SNAPSHOT_TOTAL_BUDGET_EXCEEDED',
    'SNAPSHOT_UNLOCK_FAILED',
    'SOURCE_WAL_MODE_REQUIRED',
    'SQLITE_CLOSED',
    'SQLITE_DESERIALIZE_REQUIRED',
    'SQLITE_HEADER_UNSUPPORTED',
    'SQLITE_INTEGRITY_FAILED',
    'SQLITE_MODE_UNSUPPORTED',
    'SQLITE_QUERY_FAILED',
    'SQLITE_SNAPSHOT_OPEN_FAILED',
    'TARGET_X64_REQUIRED',
    'UNSUPPORTED_CIPHER_LAYOUT',
    'UNSUPPORTED_PLAINTEXT_HEADER',
    'WAL_CHECKSUM_INPUT',
    'WAL_COMMIT_BOUNDS',
    'WAL_COMMIT_INDEX_MISMATCH',
    'WAL_FORMAT_UNSUPPORTED',
    'WAL_FRAME_CHECKSUM',
    'WAL_GENERATION_MISMATCH',
    'WAL_HEADER_CHECKSUM',
    'WAL_INDEX_BUSY_OR_INVALID',
    'WAL_INDEX_CHECKSUM',
    'WAL_INDEX_GENERATION_MISMATCH',
    'WAL_INDEX_UNSUPPORTED',
    'WAL_PAGE_BOUNDS',
    'WAL_PARTIAL_FRAME',
    'WAL_SIZE',
    'WINDOWS_CNG_FAILED',
    'WINDOWS_CNG_REQUIRED',
    'WINDOWS_X64_REQUIRED',
    'WINDOW_MAP_BYTE_LIMIT',
    'WINDOW_MAP_CHANGED',
    'WINDOW_MAP_CODE_CHANGED',
    'WINDOW_MAP_CYCLE_OR_ALIAS',
    'WINDOW_MAP_DUPLICATE_KEY',
    'WINDOW_MAP_DUPLICATE_OBJECT',
    'WINDOW_MAP_HASH_INVALID',
    'WINDOW_MAP_HWND_MISMATCH',
    'WINDOW_MAP_LAYOUT_INVALID',
    'WINDOW_MAP_NODE_LIMIT',
    'WINDOW_MAP_OBJECT_DESTROYING',
    'WINDOW_MAP_OBJECT_OWNERSHIP_INVALID',
    'WINDOW_MAP_POINTER_INVALID',
    'WINDOW_MAP_SHORT_READ',
    'WINDOW_MAP_TIME_EXCEEDED',
))


def decode_metadata(metadata):
    if type(metadata) is not dict:
        raise ReadError('CONTACT_PROBE_IDENTITIES_INVALID')
    output = dict(metadata)
    for name, fields in (('process', ('created',)), ('module', ('base',)),
                         ('expected_file', ('volume', 'index', 'created'))):
        source = output.get(name)
        if type(source) is not dict:
            raise ReadError('CONTACT_PROBE_IDENTITIES_INVALID')
        row = dict(source)
        for field in fields:
            value = row.get(field)
            if type(value) is str and re.fullmatch(r'(?:0|[1-9][0-9]{0,19})', value) and int(value) <= (1 << 64) - 1:
                row[field] = int(value)
            elif type(value) is not int or not 0 <= value <= (1 << 53) - 1:
                raise ReadError('CONTACT_PROBE_IDENTITIES_INVALID')
        output[name] = row
    return output


def inspect_account_catalog(metadata, report):
    def acquire(**options):
        return acquire_groups(**options, own_account=metadata['expected_account'])
    return inspect_entries(metadata, report, acquire=acquire)


def serve(*, input_stream, emit, inspect=inspect_program, acquire=inspect_account_catalog,
          resolve=contact_scope, discover=discover_target):
    raw = input_stream.readline(16385)
    if not raw.endswith('\n') or len(raw.encode('utf-8')) > 16384:
        raise ReadError('CATALOG_CHANNEL_REQUEST_INVALID')
    try:
        item = json.loads(raw)
    except ValueError:
        raise ReadError('CATALOG_CHANNEL_REQUEST_INVALID') from None
    if (type(item) is not dict
            or set(item) not in ({'v', 'token', 'seq', 'command', 'metadata'}, {'v', 'token', 'seq', 'command', 'selection'})
            or type(item['v']) is not int or item['v'] != 1 or type(item['seq']) is not int or item['seq'] != 0
            or item['command'] not in ('catalog', 'catalog_root') or type(item['token']) is not str
            or not re.fullmatch('[a-f0-9]{64}', item['token'])):
        raise ReadError('CATALOG_CHANNEL_REQUEST_INVALID')
    def stopped(reason):
        emit(dict(v=1, token=item['token'], seq=0, kind='error', reason=reason))
        return 2
    if item['command'] == 'catalog':
        if 'metadata' not in item: raise ReadError('CATALOG_CHANNEL_REQUEST_INVALID')
        metadata = decode_metadata(item['metadata'])
    else:
        selected = item.get('selection')
        if (type(selected) is not dict or set(selected) != {'data_root', 'expected_account'}
                or type(selected['expected_account']) is not str
                or not re.fullmatch(r'wxid_[A-Za-z0-9_-]{1,120}', selected['expected_account'])
                or type(selected['data_root']) is not str
                or ntpath.basename(normal_path(selected['data_root'])) != 'xwechat_files'):
            raise ReadError('CATALOG_CHANNEL_REQUEST_INVALID')
        try:
            target = discover()
            if target.state != 'found': raise ReadError('CONTACT_SCOPE_PROFILE_UNSUPPORTED')
            metadata = decode_metadata(resolve(data_root=selected['data_root'], account=selected['expected_account'],
                process=target.process, module=target.module, sha256=target.sha256, approve_metadata_read=True))
        except Exception as error:
            reason = str(error) if isinstance(error, ReadError) else ''
            return stopped(reason if reason in FAILURE_REASONS else 'CATALOG_CAPTURE_FAILED')
    process, module, _ = catalog_selection(metadata)
    try:
        report = inspect(path=module.path, expected_sha256=metadata['sha256'], expected_version=process.version,
            max_bytes=268435456, max_seconds=30, max_references=500000, max_functions=1000000)
    except Exception:
        return stopped('CATALOG_STATIC_ANALYSIS_FAILED')
    try:
        entries = acquire(metadata, report)
    except Exception as error:
        reason = str(error) if isinstance(error, (ReadError, CryptoError)) else ''
        return stopped(reason if reason in FAILURE_REASONS else 'CATALOG_CAPTURE_FAILED')
    nickname = None
    has_profile = isinstance(entries, AccountCatalog)
    if has_profile:
        nickname, entries = entries.nickname, entries.groups
    if type(entries) is not tuple or len(entries) > 10000:
        raise ReadError('CATALOG_CHANNEL_RESULT_INVALID')
    groups, seen = [], set()
    for entry in entries:
        if (type(entry.group_id) is not str or not re.fullmatch(r'[\w-]+@chatroom', entry.group_id)
                or entry.group_id in seen or entry.name is not None and (type(entry.name) is not str
                    or len(entry.name.encode('utf-8')) > 1024)):
            raise ReadError('CATALOG_CHANNEL_RESULT_INVALID')
        seen.add(entry.group_id)
        groups.append(dict(group_id=entry.group_id, name=entry.name))
    response = dict(v=1, token=item['token'], seq=0, kind='catalog', groups=groups)
    if has_profile:
        response['nickname'] = nickname
    if len(json.dumps(response, ensure_ascii=False).encode('utf-8')) + 1 > 1048576:
        raise ReadError('CATALOG_CHANNEL_RESULT_LIMIT')
    emit(response)  # Private pipe only. Never print names/IDs from a public probe.
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description='Private selected-account group catalog worker.')
    for flag in ('--approve-identity-read', '--approve-key-read', '--approve-contact-read'):
        parser.add_argument(flag, required=True, action='store_true')
    parser.parse_args(argv)
    return serve(input_stream=sys.stdin, emit=lambda item: print(json.dumps(item, ensure_ascii=False), flush=True))


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception:
        # Even an error must not dump paths, keys, entries or traceback to logs.
        raise SystemExit(2)
