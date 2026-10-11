import contextlib
import ctypes as C
import io
import json
import os
import subprocess
import sys
import unittest
from dataclasses import replace
from unittest.mock import Mock, patch

from native import ProcessIdentity, normal_path
from reader import ReadError
from window_class_probe import main
from window_observation import NativeUIA, QueryProcess, WindowObservation, observe_windows

PROCESS = ProcessIdentity(1234, r"c:\synthetic\weixin.exe", 123456, "4.1.15.50")


class Process:
    def __init__(self):
        self.current, self.closed = PROCESS, False

    def identity(self):
        return self.current

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


class Windows:
    def __init__(self):
        self.entries, self.pid, self.after = ((100, "Qt51514QWindowIcon"),), PROCESS.pid, None

    def selected(self, pid, *, max_windows, guard):
        guard()
        if self.after is not None:
            return self.after
        result = self.entries
        self.after = result
        return result

    def owner(self, _):
        return self.pid

    def class_name(self, handle):
        return dict(self.entries)[handle]


class UIA:
    def __init__(self, name="mmui::MainWindow"):
        self.name, self.calls, self.closed, self.hook = name, [], False, None

    def root(self, handle):
        self.calls.append(handle)
        if self.hook:
            return self.hook(handle)
        return PROCESS.pid, handle, self.name

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


def observe(process=None, windows=None, uia=None, **options):
    values = dict(expected_process=PROCESS, approve_window_classes=True, max_windows=8, max_seconds=5,
                  process_factory=lambda _: process or Process(), windows_factory=lambda: windows or Windows(),
                  uia_factory=lambda: uia or UIA())
    values.update(options)
    return observe_windows(**values)


class WindowTests(unittest.TestCase):
    def test_main_login_and_cold_shell_never_authenticate(self):
        for name, evidence in (("mmui::MainWindow", "main_class_observed"),
                               ("mmui::LoginWindow", "login_class_observed"),
                               ("Qt51514QWindowIcon", "unknown"), ("unexpected private text", "unknown")):
            with self.subTest(name=name):
                process, uia = Process(), UIA(name)
                result = observe(process, uia=uia)
                self.assertEqual(result.evidence, evidence)
                self.assertFalse(result.login_verified)
                self.assertNotIn(name, repr(result))
                self.assertTrue(process.closed)
                self.assertTrue(uia.closed)

    def test_absence_duplicates_and_conflicting_classes_remain_unknown(self):
        self.assertEqual(WindowObservation(0, 0, 0, 0).evidence, "unknown")
        self.assertEqual(WindowObservation(2, 0, 0, 2).evidence, "unknown")
        windows, uia = Windows(), UIA()
        windows.entries = ((100, "Qt51514QWindowIcon"), (200, "Qt51514QWindowIcon"))
        uia.hook = lambda handle: (PROCESS.pid, handle, "mmui::MainWindow" if handle == 100 else "mmui::LoginWindow")
        result = observe(windows=windows, uia=uia)
        self.assertEqual(result.evidence, "unknown")
        self.assertFalse(result.login_verified)

    def test_invalid_scope_and_budget_perform_no_io(self):
        factory = Mock()
        for change in (dict(approve_window_classes=False), dict(max_windows=33), dict(max_seconds=6),
                       dict(max_seconds=float("nan")), dict(expected_process=replace(PROCESS, pid=0)),
                       dict(expected_process=replace(PROCESS, executable=r"c:\other.exe"))):
            with self.subTest(change=change), self.assertRaises(ReadError):
                observe(process_factory=factory, **change)
        factory.assert_not_called()

    def test_process_change_prevents_window_access(self):
        process, factory = Process(), Mock()
        process.current = replace(PROCESS, created=1)
        with self.assertRaisesRegex(ReadError, "PROCESS_IDENTITY_CHANGED"):
            observe(process, windows_factory=factory)
        factory.assert_not_called()
        self.assertTrue(process.closed)

    def test_reused_window_handle_rejected_before_uia(self):
        windows, uia = Windows(), UIA()
        windows.pid = PROCESS.pid + 1
        with self.assertRaisesRegex(ReadError, "WINDOW_IDENTITY_CHANGED"):
            observe(windows=windows, uia=uia)
        self.assertEqual(uia.calls, [])
        self.assertTrue(uia.closed)

    def test_uia_wrong_owner_or_handle_never_accepted(self):
        for owner, handle in ((PROCESS.pid + 1, 100), (PROCESS.pid, 999)):
            uia = UIA()
            uia.hook = lambda _: (owner, handle, "mmui::MainWindow")
            with self.assertRaisesRegex(ReadError, "UIA_WINDOW_IDENTITY_CHANGED"):
                observe(uia=uia)
            self.assertTrue(uia.closed)

    def test_process_or_window_change_during_query_rejects_batch(self):
        for mutate_process in (True, False):
            process, windows, uia = Process(), Windows(), UIA()
            def change(handle):
                if mutate_process:
                    process.current = replace(PROCESS, created=987)
                else:
                    windows.after = ()
                return PROCESS.pid, handle, "mmui::MainWindow"
            uia.hook = change
            with self.assertRaisesRegex(ReadError, "PROCESS_IDENTITY_CHANGED|WINDOW_SET_CHANGED"):
                observe(process, windows, uia)
            self.assertTrue(process.closed)

    def test_unknown_native_classes_do_not_query_uia_or_titles(self):
        windows, uia = Windows(), UIA()
        windows.entries = ((100, "SyntheticHelper"),)
        result = observe(windows=windows, uia=uia)
        self.assertEqual(uia.calls, [])
        self.assertEqual(result.unknown_roots, 1)
        self.assertEqual(result.evidence, "unknown")

    def test_time_limit_and_provider_errors_close_handles(self):
        process = Process()
        times = iter((0, 6))
        with self.assertRaisesRegex(ReadError, "TIME_EXCEEDED"):
            observe(process, clock=lambda: next(times))
        self.assertTrue(process.closed)
        process, uia = Process(), UIA()
        uia.hook = Mock(side_effect=ReadError("SYNTHETIC_PROVIDER_FAILURE"))
        with self.assertRaisesRegex(ReadError, "SYNTHETIC_PROVIDER_FAILURE"):
            observe(process, uia=uia)
        self.assertTrue(process.closed)
        self.assertTrue(uia.closed)

    def test_overflow_or_duplicate_window_handles_fail_without_partial_result(self):
        for entries in (((100, "Qt"),) * 2, tuple((i, "Qt") for i in range(9))):
            windows, uia = Windows(), UIA()
            windows.entries = entries
            with self.assertRaisesRegex(ReadError, "WINDOW_LIMIT_OR_DUPLICATE"):
                observe(windows=windows, uia=uia)
            self.assertEqual(uia.calls, [])

    def test_worker_timeout_and_bad_output_never_leak_data(self):
        args = ["--metadata", "synthetic.json", "--max-windows", "8", "--approve-window-classes"]
        for outcome in (subprocess.TimeoutExpired("synthetic", 8),
                        subprocess.CompletedProcess([], 0, '{"private":"must not leak"}', "secret"),
                        subprocess.CompletedProcess([], 1, "secret failure", "secret")):
            run = Mock(side_effect=outcome) if isinstance(outcome, Exception) else Mock(return_value=outcome)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(main(args, run=run), 2)
            self.assertNotIn("secret", output.getvalue())
            self.assertNotIn("private", output.getvalue())
            self.assertFalse(json.loads(output.getvalue())["login_verified"])
            self.assertEqual(run.call_args.kwargs["timeout"], 8)
            self.assertNotIn("shell", run.call_args.kwargs)

    def test_worker_accepts_only_bounded_sanitized_observation(self):
        output = {"stage": "window_class_observed", "evidence": "main_class_observed", "main_roots": 1,
                  "login_roots": 0, "unknown_roots": 0, "target_windows": 1, "login_verified": False}
        run = Mock(return_value=subprocess.CompletedProcess([], 0, json.dumps(output), ""))
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = main(["--metadata", "synthetic.json", "--max-windows", "8", "--approve-window-classes"], run=run)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue()), output)
        # A contradictory worker summary must not be shown as valid evidence.
        output["evidence"] = "login_class_observed"
        run.return_value = subprocess.CompletedProcess([], 0, json.dumps(output), "")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--metadata", "synthetic.json", "--max-windows", "8",
                                   "--approve-window-classes"], run=run), 2)

    @unittest.skipUnless(sys.platform == "win32", "native query needs Windows")
    def test_query_handle_requests_only_metadata_access_and_blocks_memory(self):
        with QueryProcess(os.getpid()) as process:
            identity = process.identity()
            self.assertEqual(identity.pid, os.getpid())
            self.assertEqual(identity.executable, normal_path(sys.executable))
            with self.assertRaisesRegex(ReadError, "MEMORY_READ_NOT_ALLOWED"):
                process.read(0x10000, 8)
        api = Mock()
        api.OpenProcess.return_value = 123
        with patch("window_observation.kernel", return_value=api), QueryProcess(1234):
            api.OpenProcess.assert_called_once_with(0x1000, False, 1234)

    @unittest.skipUnless(sys.platform == "win32", "COM ABI test needs Windows")
    def test_com_root_getters_use_only_three_properties_and_release_bstr_and_element(self):
        # Controlled COM vtable, not a real application's UI tree.
        pointer_type = C.c_void_p
        table, calls, callbacks = (pointer_type * 37)(), [], []
        value = C.create_unicode_buffer("mmui::MainWindow")
        def make(slot, result_type, argument_type, action):
            callback = C.WINFUNCTYPE(result_type, pointer_type, argument_type)(action)
            callbacks.append(callback)
            table[slot] = C.cast(callback, pointer_type).value
        def integer(slot, number, kind):
            def action(_, result):
                calls.append(slot)
                result[0] = number
                return 0
            make(slot, C.c_int32, C.POINTER(kind), action)
        integer(20, PROCESS.pid, C.c_int32)
        integer(36, 100, pointer_type)
        integer(30, C.addressof(value), pointer_type)
        release = C.WINFUNCTYPE(C.c_uint32, pointer_type)(lambda _: calls.append(2) or 0)
        callbacks.append(release)
        table[2] = C.cast(release, pointer_type).value
        instance = pointer_type(C.addressof(table))
        element_pointer = C.addressof(instance)
        automation_table = (pointer_type * 7)()
        def element(_, handle, result):
            calls.append(6)
            result[0] = element_pointer
            return 0
        callback = C.WINFUNCTYPE(C.c_int32, pointer_type, pointer_type, C.POINTER(pointer_type))(element)
        callbacks.append(callback)
        automation_table[6] = C.cast(callback, pointer_type).value
        automation_instance = pointer_type(C.addressof(automation_table))
        host = NativeUIA.__new__(NativeUIA)
        host.pointer = pointer_type(C.addressof(automation_instance))
        host.strings = Mock()
        host.strings.SysStringLen.return_value = len("mmui::MainWindow")
        self.assertEqual(host.root(100), (PROCESS.pid, 100, "mmui::MainWindow"))
        self.assertEqual(calls, [6, 20, 36, 30, 2])
        host.strings.SysFreeString.assert_called_once()

    @unittest.skipUnless(sys.platform == "win32", "COM initialization needs Windows")
    def test_native_com_initialization_and_release_without_reading_any_application(self):
        host = NativeUIA()
        self.assertTrue(host.pointer)
        host.close()
        self.assertFalse(host.pointer)
        self.assertFalse(host.initialized)
        host.close()


if __name__ == "__main__":
    unittest.main()
