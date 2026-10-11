"""Cross-language test helper. Synthetic bytes only; NEVER a production worker."""
from dataclasses import asdict
import json
import sys
from unittest.mock import patch

from identity_snapshot import observe_identity_snapshot
from identity_worker import serve
from test_identity_snapshot import source
from test_managed_windows import PROCESS, MODULE, SHA, BASE, Windows


def main():
    p = source()
    calls = 0
    def observe(**options):
        nonlocal calls
        calls += 1
        if calls == 2:
            p.put(p.text, b'wxid_synthetic_changed')
        elif calls >= 3:
            p.pack(p.widget, '<Q', BASE + 0x2600)
        return observe_identity_snapshot(**options, process_factory=lambda _: p, windows_factory=Windows)
    metadata = dict(process=asdict(PROCESS), module=asdict(MODULE), sha256=SHA)
    with patch('identity_worker.read_json', return_value=metadata):
        return serve(metadata_path='synthetic-no-file', input_stream=sys.stdin,
            emit=lambda item: print(json.dumps(item), flush=True), inspect=lambda **_: p.report, observe=observe)


if __name__ == '__main__':
    raise SystemExit(main())
