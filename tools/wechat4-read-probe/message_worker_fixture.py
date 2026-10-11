"""Synthetic private-pipe fixture. Never discover/open any real WeChat source."""
import json
import sys
from dataclasses import replace

from message_worker import serve
from reader import Scope
from test_reader import GROUP_B
from test_selected_intake import Capture
from test_textdecode import raw_frame


def create_capture(config):
    class SyntheticCapture(Capture):
        def capture(self):
            if self.captures == 1:
                for group in self.scope.groups:
                    self.rows[group].append((2, 2, 1002, raw_frame('明天提交人工测试作业 😀'.encode('utf-8'))))
            return tuple(replace(shard, account=self.scope.account) for shard in super().capture())
    groups = tuple(group['group_id'] for group in config['groups'])
    rows = {group: [(1, 1, 1001, 'old history')] for group in groups}
    rows[GROUP_B] = [(1, 1, 9999, 'PRIVATE_UNSELECTED')]
    return SyntheticCapture(Scope(config['account'], groups), rows)


if __name__ == '__main__':
    try:
        raise SystemExit(serve(input_stream=sys.stdin,
            emit=lambda value: print(json.dumps(value, ensure_ascii=False), flush=True), create_capture=create_capture))
    except Exception: raise SystemExit(2)
