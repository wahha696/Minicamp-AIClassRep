"""Cross-language fixture. Synthetic SQLite and memory only; not shipped."""
import io
import json
import sys
from dataclasses import asdict, replace
from types import SimpleNamespace

from catalog import read_groups
from catalog_probe import inspect_entries
from catalog_worker import serve
from reader import ReadError
from test_catalog import image
from test_catalog_probe import fixture


def main():
    # Keep the owned parent's nonce, but supply only our artificial process/file scope.
    request = json.loads(sys.stdin.readline(16385))
    force_failure = request.get('metadata', {}).get('synthetic_failure') is True
    supplied = request.get('metadata', {})
    metadata, process, observer, _ = fixture()
    metadata.pop('target_group')
    if 'process' in supplied:
        # Check a real >2^53 value against synthetic process identity, not a
        # second value obtained from the same potentially rounded request.
        if supplied['process'].get('created') != '134360728640232154':
            raise ReadError('CONTACT_PROBE_IDENTITIES_INVALID')
        process.current = replace(process.current, created=134360728640232154)
        metadata['process'] = {**asdict(process.current), 'created': supplied['process']['created']}
    if request['command'] == 'catalog_root':
        if request['selection']['expected_account'] != metadata['expected_account']:
            raise ReadError('CONTACT_PROBE_IDENTITIES_INVALID')
    else:
        request['metadata'] = metadata
    data = image((('wxid_private', 'PRIVATE_NICKNAME', 'PRIVATE_REMARK', 'PRIVATE_OWNER'),
        ('synthetic@chatroom', '人工群 😀', 'ignored', 'ignored')))
    def acquire_scope(metadata, report):
        if force_failure:
            raise ReadError('SNAPSHOT_SOURCE_CHANGED')
        return inspect_entries(metadata, report, observe=observer,
            acquire=lambda **_: read_groups(data, max_image_bytes=16777216, max_groups=10000, max_name_bytes=1024))
    return serve(input_stream=io.StringIO(json.dumps(request) + '\n'),
        emit=lambda item: print(json.dumps(item, ensure_ascii=False), flush=True),
        inspect=lambda **_: process.report, acquire=acquire_scope,
        discover=lambda: SimpleNamespace(state='found', process=process.current,
            module=process.current_module, sha256=metadata['sha256']),
        resolve=lambda **_: metadata)


if __name__ == '__main__':
    raise SystemExit(main())
