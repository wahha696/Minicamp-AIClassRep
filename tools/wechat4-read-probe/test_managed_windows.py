import contextlib
from dataclasses import replace
import io
import json
import struct
import subprocess
import unittest
from unittest.mock import Mock

from managed_window_probe import main
from managed_windows import observe_managed_windows
from native import ModuleIdentity, ProcessIdentity
from reader import ReadError
from static_types import CLASSES, QtAccessor, StaticReport, StaticType
from test_window_map import BASE, Memory
from window_observation import NativeWindows

PROCESS = ProcessIdentity(1234, r"c:\synthetic\weixin.exe", 123456, "4.1.15.50")
MODULE = ModuleIdentity(BASE, 0x4000, r"c:\synthetic\weixin.dll", "4.1.15.50")
SHA = 'a' * 64


class Process(Memory):
    def __init__(self):
        super().__init__()
        self.current, self.current_module, self.closed = PROCESS, MODULE, False
        types = []
        for name, getter, meta, table, call in ((CLASSES[0], 0x1010, 0x2200, 0x2280, 0x1050),
                                              (CLASSES[1], 0x1110, 0x2580, 0x2600, 0x1150)):
            body = (b'\x48\x8b\x49\x08\x48\x83\x79\x28\0\x0f\x85'
                    + struct.pack('<i', 0x1300 - getter - 15) + b'\x48\x8d\x05'
                    + struct.pack('<i', meta - getter - 22) + b'\xc3')
            self.put(BASE + getter, body)
            methods = (getter, call, call + 16)
            self.pack(BASE + table, '<3Q', *(BASE + r for r in methods))
            accessor = QtAccessor(getter, 0x1300, (table,), ((table, methods),))
            types.append(StaticType(name, 0x2100, 0x20E0, meta, 0x2150, call, (), (), (accessor,)))
        self.report = StaticReport(SHA, 0x1200, 0x4000, tuple(types), (self.mapper,))

    def identity(self):
        return self.current

    def module(self, path):
        assert path == MODULE.path
        return self.current_module

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


class Windows:
    def __init__(self):
        self.entries, self.pid, self.calls, self.after = (0x1234,), PROCESS.pid, 0, None

    def handles(self, pid, *, max_windows, guard):
        assert pid == PROCESS.pid
        guard()
        self.calls += 1
        return self.after if self.calls > 1 and self.after is not None else self.entries

    def owner(self, _):
        return self.pid


def observe(process=None, windows=None, **options):
    process = process or Process()
    args = dict(expected_process=PROCESS, expected_module=MODULE, report=process.report, expected_sha256=SHA,
                approve_managed_read=True, max_windows=32, max_bytes=1024 * 1024, max_nodes=4096,
                max_seconds=5, process_factory=lambda _: process, windows_factory=lambda: windows or Windows())
    args.update(options)
    return observe_managed_windows(**args)


class ManagedWindowTests(unittest.TestCase):
    def test_full_native_adapter_contract_with_synthetic_memory_closes_handle(self):
        process = Process()
        result = observe(process)
        self.assertEqual((result.main_windows, result.target_windows), (1, 1))
        self.assertFalse(result.login_verified)
        self.assertTrue(process.closed)
        self.assertEqual(result.bytes_read, sum(n for _, n in process.reads))

    def test_scope_or_profile_errors_never_open_process(self):
        factory = Mock()
        p = Process()
        for change in (dict(approve_managed_read=False), dict(max_windows=33), dict(max_bytes=1048577),
                       dict(max_nodes=4097), dict(max_seconds=float('nan')),
                       dict(expected_process=replace(PROCESS, pid=0)),
                       dict(expected_module=replace(MODULE, base=BASE + 8)),
                       dict(expected_module=replace(MODULE, version='4.1.16.1')),
                       dict(expected_sha256='b' * 64),
                       dict(report=replace(p.report, window_mapper_candidates=())),
                       dict(report=replace(p.report, window_mapper_candidates=(p.mapper, p.mapper)))):
            with self.subTest(change=change), self.assertRaises(ReadError):
                observe(p, process_factory=factory, **change)
        factory.assert_not_called()

    def test_changed_identity_or_module_stops_before_memory_reads(self):
        for key, new in (('current', replace(PROCESS, created=1)),
                         ('current_module', replace(MODULE, base=BASE + 65536))):
            p, factory = Process(), Mock()
            setattr(p, key, new)
            with self.assertRaisesRegex(ReadError, 'PROCESS_OR_MODULE_CHANGED'):
                observe(p, windows_factory=factory)
            factory.assert_not_called()
            self.assertEqual(p.reads, [])
            self.assertTrue(p.closed)

    def test_initial_window_owner_mismatch_prevents_memory_read(self):
        p, w = Process(), Windows()
        w.pid += 1
        with self.assertRaisesRegex(ReadError, 'OWNER_CHANGED'):
            observe(p, w)
        self.assertEqual(p.reads, [])
        self.assertTrue(p.closed)

    def test_runtime_table_and_accessor_modification_rejected(self):
        for address in (BASE + 0x2280, BASE + 0x1010):
            p = Process()
            p.put(address, bytes(24))
            with self.assertRaisesRegex(ReadError, 'RUNTIME_PROFILE_CHANGED'):
                observe(p)
            self.assertTrue(p.closed)

    def test_final_window_set_and_process_identity_checked(self):
        p, w = Process(), Windows()
        w.after = (0x5678,)
        with self.assertRaisesRegex(ReadError, 'WINDOW_SET_CHANGED'):
            observe(p, w)
        self.assertTrue(p.closed)
        p = Process()
        def mutate(at, n):
            if at == p.private + 0x130:
                p.current = replace(PROCESS, created=1)
        p.hook = mutate
        with self.assertRaisesRegex(ReadError, 'PROCESS_OR_MODULE_CHANGED'):
            observe(p)
        self.assertTrue(p.closed)

    def test_final_runtime_table_modification_rejected(self):
        p = Process()
        def mutate(at, n):
            if at == p.private + 0x130:
                p.pack(BASE + 0x2280, '<Q', BASE + 0x999)
        p.hook = mutate
        with self.assertRaisesRegex(ReadError, 'RUNTIME_PROFILE_CHANGED'):
            observe(p)
        self.assertTrue(p.closed)

    def test_all_reads_including_runtime_fingerprints_share_byte_budget(self):
        p = Process()
        result = observe(p)
        with self.assertRaises(ReadError):
            observe(max_bytes=result.bytes_read - 1)
        self.assertEqual(observe(max_bytes=result.bytes_read).bytes_read, result.bytes_read)

    def test_snapshot_failure_and_time_limit_close_process(self):
        p = Process()
        p.pack(p.private + 0x130, '<I', 0x40000)
        with self.assertRaisesRegex(ReadError, 'DESTROYING'):
            observe(p)
        self.assertTrue(p.closed)
        p = Process()
        ticks = iter((0, 6))
        with self.assertRaisesRegex(ReadError, 'TIME_EXCEEDED'):
            observe(p, clock=lambda: next(ticks))
        self.assertTrue(p.closed)

    def test_native_handle_enumeration_never_reads_classes_or_other_ui(self):
        windows = NativeWindows.__new__(NativeWindows)
        windows.callback_type = lambda callback: callback
        def enumerate_windows(callback, _):
            return all(callback(h, 0) for h in (100, 200, 300))
        windows.api = Mock(EnumWindows=enumerate_windows)
        windows.owner = lambda handle: PROCESS.pid if handle == 200 else 999
        windows.class_name = Mock(side_effect=AssertionError('content access prohibited'))
        self.assertEqual(windows.handles(PROCESS.pid, max_windows=32, guard=lambda: None), (200,))
        windows.class_name.assert_not_called()


ARGS = ['--metadata', 'synthetic.json', '--max-windows', '32', '--max-read-bytes', '1048576',
        '--max-nodes', '4096', '--approve-managed-read']


class ManagedWorkerTests(unittest.TestCase):
    def invoke(self, result=None, error=None):
        run, output = Mock(return_value=result, side_effect=error), io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(ARGS, run=run)
        return code, json.loads(output.getvalue()), run

    def test_worker_timeout_is_bounded_and_no_shell(self):
        code, output, run = self.invoke(error=subprocess.TimeoutExpired('x', 40))
        self.assertEqual(code, 2)
        self.assertEqual(output['reason'], 'MANAGED_WORKER_TIMEOUT')
        self.assertEqual(run.call_args.kwargs['timeout'], 40)
        self.assertNotIn('shell', run.call_args.kwargs)

    def test_only_consistent_counts_and_false_auth_can_leave_worker(self):
        valid = dict(stage='managed_windows_observed', main_windows=1, login_windows=0, unknown_windows=0,
                     absent_windows=0, target_windows=1, bytes_read=999, nodes_read=1, login_verified=False)
        result = subprocess.CompletedProcess([], 0, json.dumps(valid), '')
        self.assertEqual(self.invoke(result)[0], 0)
        for change in (dict(login_verified=True), dict(main_windows=True), dict(target_windows=2),
                       dict(bytes_read=1048577), dict(nodes_read=4097), dict(private='secret')):
            modified = {**valid, **change}
            code, output, _ = self.invoke(subprocess.CompletedProcess([], 0, json.dumps(modified), 'secret'))
            self.assertEqual(code, 2)
            self.assertNotIn('secret', json.dumps(output))

    def test_failure_payload_and_nonjson_output_are_sanitized(self):
        for stdout, expected in ((json.dumps(dict(stage='stopped', reason='PROCESS_SHORT_READ', login_verified=False)),
                                  'PROCESS_SHORT_READ'),
                                 ('private chat', 'MANAGED_WORKER_FAILED'),
                                 ('x' * 2049, 'MANAGED_WORKER_FAILED'),
                                 (json.dumps(dict(stage='stopped', reason='private chat', login_verified=False)),
                                  'MANAGED_WORKER_FAILED')):
            code, output, _ = self.invoke(subprocess.CompletedProcess([], 2, stdout, 'private chat'))
            self.assertEqual(code, 2)
            self.assertEqual(output['reason'], expected)
            self.assertFalse(output['login_verified'])


if __name__ == '__main__':
    unittest.main()
