"""Read-only window-class evidence, never a login or account authenticator.

No names, titles, children, text, screenshots, patterns, events, focus, process
writes or accessibility activation. Importing this module performs no I/O.
"""
from __future__ import annotations

import ctypes as C
import math
import re
import sys
import time
import uuid
from dataclasses import dataclass, field

from native import NativeProcess, ProcessIdentity, kernel, normal_path
from reader import ReadError


@dataclass(frozen=True, repr=False)
class WindowObservation:
    main_roots: int
    login_roots: int
    unknown_roots: int
    target_windows: int
    login_verified: bool = field(default=False, init=False)

    @property
    def evidence(self):
        if self.main_roots == 1 and self.login_roots == 0:
            return "main_class_observed"
        if self.login_roots == 1 and self.main_roots == 0:
            return "login_class_observed"
        return "unknown"


class QueryProcess(NativeProcess):
    """Identity metadata only: no PROCESS_VM_READ permission is requested."""
    def __init__(self, pid):
        if sys.platform != "win32" or C.sizeof(C.c_void_p) != 8:
            raise ReadError("WINDOWS_X64_REQUIRED")
        self.pid, self._api, self._handle = pid, kernel(), None
        self._handle = self._api.OpenProcess(0x1000, False, pid)
        if not self._handle:
            self._handle = None
            raise ReadError("PROCESS_QUERY_ACCESS_FAILED")

    def read(self, *_):
        raise ReadError("PROCESS_MEMORY_READ_NOT_ALLOWED")

    def regions(self):
        raise ReadError("PROCESS_MEMORY_READ_NOT_ALLOWED")


class NativeWindows:
    def __init__(self):
        if sys.platform != "win32" or C.sizeof(C.c_void_p) != 8:
            raise ReadError("WINDOWS_X64_REQUIRED")
        self.api = C.WinDLL("user32", use_last_error=True)
        self.callback_type = C.WINFUNCTYPE(C.c_int, C.c_void_p, C.c_ssize_t)
        signatures = {
            "EnumWindows": ([self.callback_type, C.c_ssize_t], C.c_int),
            "GetWindowThreadProcessId": ([C.c_void_p, C.POINTER(C.c_uint32)], C.c_uint32),
            "GetClassNameW": ([C.c_void_p, C.c_wchar_p, C.c_int], C.c_int),
        }
        for name, (args, result) in signatures.items():
            method = getattr(self.api, name)
            method.argtypes, method.restype = args, result

    def owner(self, handle):
        pid = C.c_uint32()
        if not self.api.GetWindowThreadProcessId(handle, C.byref(pid)) or not pid.value:
            raise ReadError("WINDOW_OWNER_UNAVAILABLE")
        return pid.value

    def class_name(self, handle):
        value = C.create_unicode_buffer(257)
        length = self.api.GetClassNameW(handle, value, len(value))
        if not 0 < length < len(value) - 1:
            raise ReadError("WINDOW_CLASS_UNAVAILABLE")
        return value.value

    def selected(self, pid, *, max_windows, guard):
        return self._selected(pid, max_windows=max_windows, guard=guard, classes=True)

    def handles(self, pid, *, max_windows, guard):
        """Native HWND/PID only; never query any window class or content."""
        return self._selected(pid, max_windows=max_windows, guard=guard, classes=False)

    def _selected(self, pid, *, max_windows, guard, classes):
        # Other applications: transient HWND/PID only, never class/name/text.
        found, errors, total = [], [], 0

        def visit(handle, _):
            nonlocal total
            try:
                guard()
                total += 1
                if total > 4096:
                    raise ReadError("DESKTOP_WINDOW_LIMIT")
                if self.owner(handle) == pid:
                    if len(found) >= max_windows:
                        raise ReadError("TARGET_WINDOW_LIMIT")
                    found.append((int(handle), self.class_name(handle)) if classes else int(handle))
                return 1
            except BaseException as error:
                errors.append(error)
                return 0

        callback = self.callback_type(visit)
        ok = self.api.EnumWindows(callback, 0)
        if errors:
            raise errors[0]
        if not ok:
            raise ReadError("WINDOW_ENUMERATION_FAILED")
        return tuple(found)


def _method(pointer, slot, result, *args):
    table = C.cast(pointer, C.POINTER(C.POINTER(C.c_void_p))).contents
    return C.WINFUNCTYPE(result, C.c_void_p, *args)(table[slot])


def _ok(result):
    if result < 0:
        raise ReadError("UIA_CLASS_QUERY_FAILED")


class NativeUIA:
    """Minimal IUIAutomation root-property getters; no tree traversal."""
    def __init__(self):
        if sys.platform != "win32" or C.sizeof(C.c_void_p) != 8:
            raise ReadError("WINDOWS_X64_REQUIRED")
        self.ole, self.strings = C.WinDLL("ole32"), C.WinDLL("oleaut32")
        self.pointer, self.initialized = C.c_void_p(), False
        self.ole.CoInitializeEx.argtypes, self.ole.CoInitializeEx.restype = [C.c_void_p, C.c_uint32], C.c_int32
        self.ole.CoUninitialize.argtypes, self.ole.CoUninitialize.restype = [], None
        self.ole.CoCreateInstance.argtypes = [C.c_void_p, C.c_void_p, C.c_uint32, C.c_void_p, C.POINTER(C.c_void_p)]
        self.ole.CoCreateInstance.restype = C.c_int32
        self.strings.SysStringLen.argtypes, self.strings.SysStringLen.restype = [C.c_void_p], C.c_uint32
        self.strings.SysFreeString.argtypes, self.strings.SysFreeString.restype = [C.c_void_p], None
        _ok(self.ole.CoInitializeEx(None, 0))  # MTA, no focus/event subscriptions.
        self.initialized = True
        try:
            clsid = (C.c_ubyte * 16).from_buffer_copy(uuid.UUID("ff48dba4-60ef-4201-aa87-54103eef594e").bytes_le)
            iid = (C.c_ubyte * 16).from_buffer_copy(uuid.UUID("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee").bytes_le)
            _ok(self.ole.CoCreateInstance(clsid, None, 1, iid, C.byref(self.pointer)))
            if not self.pointer:
                raise ReadError("UIA_CLASS_QUERY_FAILED")
        except BaseException:
            self.close()
            raise

    def root(self, handle):
        element = C.c_void_p()
        try:
            # Slots follow IUIAutomation/IUIAutomationElement in the Windows ABI.
            _ok(_method(self.pointer, 6, C.c_int32, C.c_void_p, C.POINTER(C.c_void_p))(
                self.pointer, handle, C.byref(element)))
            if not element:
                raise ReadError("UIA_CLASS_QUERY_FAILED")
            pid, native_handle, text = C.c_int32(), C.c_void_p(), C.c_void_p()
            _ok(_method(element, 20, C.c_int32, C.POINTER(C.c_int32))(element, C.byref(pid)))
            _ok(_method(element, 36, C.c_int32, C.POINTER(C.c_void_p))(element, C.byref(native_handle)))
            try:
                _ok(_method(element, 30, C.c_int32, C.POINTER(C.c_void_p))(element, C.byref(text)))
                length = self.strings.SysStringLen(text) if text else 0
                if not 0 < length <= 256:
                    raise ReadError("UIA_CLASS_QUERY_FAILED")
                class_name = C.wstring_at(text, length)
                if "\0" in class_name:
                    raise ReadError("UIA_CLASS_QUERY_FAILED")
            finally:
                if text:
                    self.strings.SysFreeString(text)
            return pid.value, native_handle.value, class_name
        finally:
            if element:
                _method(element, 2, C.c_uint32)(element)

    def close(self):
        try:
            if self.pointer:
                _method(self.pointer, 2, C.c_uint32)(self.pointer)
                self.pointer = C.c_void_p()
        finally:
            if self.initialized:
                self.ole.CoUninitialize()
                self.initialized = False

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def observe_windows(*, expected_process, approve_window_classes=False, max_windows, max_seconds,
                    process_factory=QueryProcess, windows_factory=NativeWindows, uia_factory=NativeUIA,
                    clock=time.monotonic):
    if approve_window_classes is not True:
        raise ReadError("WINDOW_CLASS_CONFIRMATION_REQUIRED")
    if (not isinstance(expected_process, ProcessIdentity) or type(expected_process.pid) is not int
            or not 0 < expected_process.pid <= 0xFFFFFFFF or type(expected_process.created) is not int
            or expected_process.created <= 0 or normal_path(expected_process.executable) != expected_process.executable
            or expected_process.executable.rsplit("\\", 1)[-1] != "weixin.exe"
            or not re.fullmatch(r"4\.\d+\.\d+\.\d+", expected_process.version)):
        raise ReadError("EXPLICIT_WINDOW_PROCESS_REQUIRED")
    if (type(max_windows) is not int or not 1 <= max_windows <= 32
            or type(max_seconds) not in (int, float) or not math.isfinite(max_seconds)
            or not 0 < max_seconds <= 5):
        raise ReadError("EXPLICIT_WINDOW_BUDGET_REQUIRED")
    deadline = clock() + max_seconds
    with process_factory(expected_process.pid) as process:
        def guard():
            if clock() >= deadline:
                raise ReadError("WINDOW_OBSERVATION_TIME_EXCEEDED")
            if process.identity() != expected_process:
                raise ReadError("PROCESS_IDENTITY_CHANGED")

        guard()
        windows = windows_factory()
        selected = windows.selected(expected_process.pid, max_windows=max_windows, guard=guard)
        if len(selected) > max_windows or len({item[0] for item in selected}) != len(selected):
            raise ReadError("TARGET_WINDOW_LIMIT_OR_DUPLICATE")
        counts = {"mmui::MainWindow": 0, "mmui::LoginWindow": 0, "unknown": 0}
        with uia_factory() as uia:
            for handle, native_class in selected:
                guard()
                if windows.owner(handle) != expected_process.pid or windows.class_name(handle) != native_class:
                    raise ReadError("WINDOW_IDENTITY_CHANGED")
                if native_class.startswith("Qt") or native_class in counts and native_class != "unknown":
                    owner, returned_handle, class_name = uia.root(handle)
                    guard()
                    if owner != expected_process.pid or returned_handle != handle:
                        raise ReadError("UIA_WINDOW_IDENTITY_CHANGED")
                    if windows.owner(handle) != owner or windows.class_name(handle) != native_class:
                        raise ReadError("WINDOW_IDENTITY_CHANGED")
                    counts[class_name if class_name in counts else "unknown"] += 1
                else:
                    counts["unknown"] += 1
        guard()
        after = windows.selected(expected_process.pid, max_windows=max_windows, guard=guard)
        if set(after) != set(selected):
            raise ReadError("WINDOW_SET_CHANGED")
        guard()
        return WindowObservation(counts["mmui::MainWindow"], counts["mmui::LoginWindow"],
                                 counts["unknown"], len(selected))
