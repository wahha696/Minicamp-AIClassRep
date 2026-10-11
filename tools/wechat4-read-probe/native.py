"""Windows read/query handles and shared locks; no writes or privilege changes.

Importing this module does not open any process/file. Callers must gate access.
"""
from __future__ import annotations

import ctypes as C
import ntpath
import sys
from contextlib import contextmanager
from dataclasses import dataclass

from reader import ReadError

DWORD, HANDLE, SIZE_T = C.c_uint32, C.c_void_p, C.c_size_t


class FileTime(C.Structure):
    _fields_ = [("low", DWORD), ("high", DWORD)]

    @property
    def ticks(self):
        return (self.high << 32) | self.low


class FileInfo(C.Structure):
    _fields_ = [("attributes", DWORD), ("created", FileTime), ("accessed", FileTime),
                ("written", FileTime), ("volume", DWORD), ("size_high", DWORD),
                ("size_low", DWORD), ("links", DWORD), ("index_high", DWORD), ("index_low", DWORD)]


class Overlapped(C.Structure):
    _fields_ = [("internal", SIZE_T), ("internal_high", SIZE_T),
                ("offset", DWORD), ("offset_high", DWORD), ("event", HANDLE)]


class MemoryInfo(C.Structure):
    _fields_ = [("base", HANDLE), ("allocation", HANDLE), ("allocation_protect", DWORD),
                ("alignment", DWORD), ("size", SIZE_T), ("state", DWORD),
                ("protect", DWORD), ("kind", DWORD), ("alignment2", DWORD)]


class ModuleEntry(C.Structure):
    _fields_ = [("size", DWORD), ("module_id", DWORD), ("pid", DWORD),
                ("global_uses", DWORD), ("process_uses", DWORD), ("base", HANDLE),
                ("image_size", DWORD), ("module", HANDLE),
                ("name", C.c_wchar * 256), ("path", C.c_wchar * 260)]


class ProcessEntry(C.Structure):
    _fields_ = [("size", DWORD), ("uses", DWORD), ("pid", DWORD), ("heap", SIZE_T),
                ("module_id", DWORD), ("threads", DWORD), ("parent", DWORD),
                ("priority", C.c_int32), ("flags", DWORD), ("executable", C.c_wchar * 260)]


@dataclass(frozen=True, repr=False)
class FileIdentity:
    volume: int
    index: int
    created: int


@dataclass(frozen=True, repr=False)
class ProcessIdentity:
    pid: int
    executable: str
    created: int
    version: str


@dataclass(frozen=True, repr=False)
class ModuleIdentity:
    base: int
    size: int
    path: str
    version: str


def normal_path(path: str):
    if path.startswith("\\\\?\\"):
        path = path[4:]
    drive, tail = ntpath.splitdrive(path)
    if len(drive) != 2 or drive[1] != ":" or not tail.startswith("\\") or ":" in tail:
        raise ReadError("LOCAL_ABSOLUTE_PATH_REQUIRED")
    return ntpath.normcase(ntpath.normpath(path))


def kernel():
    if sys.platform != "win32" or C.sizeof(HANDLE) != 8:
        raise ReadError("WINDOWS_X64_REQUIRED")
    api = C.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateFileW": ([C.c_wchar_p, DWORD, DWORD, HANDLE, DWORD, DWORD, HANDLE], HANDLE),
        "CloseHandle": ([HANDLE], C.c_int),
        "GetFileInformationByHandle": ([HANDLE, C.POINTER(FileInfo)], C.c_int),
        "GetFinalPathNameByHandleW": ([HANDLE, C.c_wchar_p, DWORD, DWORD], DWORD),
        "SetFilePointerEx": ([HANDLE, C.c_int64, C.POINTER(C.c_int64), DWORD], C.c_int),
        "ReadFile": ([HANDLE, HANDLE, DWORD, C.POINTER(DWORD), HANDLE], C.c_int),
        "LockFileEx": ([HANDLE, DWORD, DWORD, DWORD, DWORD, C.POINTER(Overlapped)], C.c_int),
        "UnlockFileEx": ([HANDLE, DWORD, DWORD, DWORD, C.POINTER(Overlapped)], C.c_int),
        "OpenProcess": ([DWORD, C.c_int, DWORD], HANDLE),
        "QueryFullProcessImageNameW": ([HANDLE, DWORD, C.c_wchar_p, C.POINTER(DWORD)], C.c_int),
        "GetProcessTimes": ([HANDLE, C.POINTER(FileTime), C.POINTER(FileTime), C.POINTER(FileTime), C.POINTER(FileTime)], C.c_int),
        "GetExitCodeProcess": ([HANDLE, C.POINTER(DWORD)], C.c_int),
        "ReadProcessMemory": ([HANDLE, HANDLE, HANDLE, SIZE_T, C.POINTER(SIZE_T)], C.c_int),
        "VirtualQueryEx": ([HANDLE, HANDLE, C.POINTER(MemoryInfo), SIZE_T], SIZE_T),
        "IsWow64Process": ([HANDLE, C.POINTER(C.c_int)], C.c_int),
        "CreateToolhelp32Snapshot": ([DWORD, DWORD], HANDLE),
        "Module32FirstW": ([HANDLE, C.POINTER(ModuleEntry)], C.c_int),
        "Module32NextW": ([HANDLE, C.POINTER(ModuleEntry)], C.c_int),
        "Process32FirstW": ([HANDLE, C.POINTER(ProcessEntry)], C.c_int),
        "Process32NextW": ([HANDLE, C.POINTER(ProcessEntry)], C.c_int),
    }
    for name, (args, result) in signatures.items():
        fn = getattr(api, name)
        fn.argtypes, fn.restype = args, result
    return api


class NativeFile:
    def __init__(self, path: str, *, directory=False):
        self._api, self._handle = kernel(), None
        self._handle = self._api.CreateFileW(path, 0x80000000, 7, None, 3,
                                            0x02000000 if directory else 0x80, None)
        if self._handle in (None, C.c_void_p(-1).value):
            self._handle = None
            raise ReadError("FILE_OPEN_READ_FAILED")
        try:
            if bool(self._info().attributes & 0x10) != directory:
                raise ReadError("FILE_OR_DIRECTORY_TYPE_MISMATCH")
            self.path = self.final_path()
        except BaseException:
            self.close()
            raise

    def _info(self):
        info = FileInfo()
        if not self._handle or not self._api.GetFileInformationByHandle(self._handle, C.byref(info)):
            raise ReadError("FILE_METADATA_FAILED")
        return info

    def identity(self):
        info = self._info()
        return FileIdentity(info.volume, (info.index_high << 32) | info.index_low, info.created.ticks)

    def size(self):
        info = self._info()
        return (info.size_high << 32) | info.size_low

    def final_path(self):
        output = C.create_unicode_buffer(32768)
        count = self._api.GetFinalPathNameByHandleW(self._handle, output, len(output), 0)
        if not 0 < count < len(output):
            raise ReadError("FINAL_PATH_FAILED")
        return normal_path(output.value)

    def read(self, offset: int, count: int):
        if offset < 0 or not 0 < count <= 1024 * 1024:
            raise ReadError("FILE_READ_BOUNDS")
        if not self._api.SetFilePointerEx(self._handle, offset, None, 0):
            raise ReadError("FILE_SEEK_FAILED")
        buffer, actual = C.create_string_buffer(count), DWORD()
        if not self._api.ReadFile(self._handle, buffer, count, C.byref(actual), None) or actual.value != count:
            raise ReadError("FILE_SHORT_READ")
        return buffer.raw

    @contextmanager
    def shared_lock(self, offset: int, count: int):
        overlap = Overlapped()
        overlap.offset, overlap.offset_high = offset & 0xFFFFFFFF, offset >> 32
        if not self._api.LockFileEx(self._handle, 1, 0, count, 0, C.byref(overlap)):
            raise ReadError("SNAPSHOT_LOCK_BUSY")
        try:
            yield
        finally:
            if not self._api.UnlockFileEx(self._handle, 0, count, 0, C.byref(overlap)):
                # Closing the handle releases remaining locks; no handle leak.
                self.close()
                raise ReadError("SNAPSHOT_UNLOCK_FAILED")

    def close(self):
        if self._handle is not None:
            if not self._api.CloseHandle(self._handle):
                raise ReadError("FILE_CLOSE_FAILED")
            self._handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def executable_version(path: str):
    api = C.WinDLL("version", use_last_error=True)
    api.GetFileVersionInfoSizeW.argtypes, api.GetFileVersionInfoSizeW.restype = [C.c_wchar_p, C.POINTER(DWORD)], DWORD
    api.GetFileVersionInfoW.argtypes, api.GetFileVersionInfoW.restype = [C.c_wchar_p, DWORD, DWORD, HANDLE], C.c_int
    api.VerQueryValueW.argtypes, api.VerQueryValueW.restype = [HANDLE, C.c_wchar_p, C.POINTER(HANDLE), C.POINTER(DWORD)], C.c_int
    unused = DWORD()
    size = api.GetFileVersionInfoSizeW(path, C.byref(unused))
    if not 52 <= size <= 1024 * 1024:
        raise ReadError("PROCESS_VERSION_FAILED")
    buffer, pointer, length = C.create_string_buffer(size), HANDLE(), DWORD()
    if (not api.GetFileVersionInfoW(path, 0, size, buffer)
            or not api.VerQueryValueW(buffer, "\\", C.byref(pointer), C.byref(length)) or length.value < 52):
        raise ReadError("PROCESS_VERSION_FAILED")
    values = C.cast(pointer, C.POINTER(DWORD * 13)).contents
    if values[0] != 0xFEEF04BD:
        raise ReadError("PROCESS_VERSION_FAILED")
    return ".".join(str(v) for v in (values[2] >> 16, values[2] & 65535, values[3] >> 16, values[3] & 65535))


class NativeProcess:
    def __init__(self, pid: int):
        if type(pid) is not int or not 0 < pid <= 0xFFFFFFFF:
            raise ReadError("EXPLICIT_PID_REQUIRED")
        self.pid, self._api, self._handle = pid, kernel(), None
        self._handle = self._api.OpenProcess(0x0010 | 0x0400, False, pid)
        if not self._handle:
            self._handle = None
            raise ReadError("PROCESS_READ_ACCESS_FAILED")
        try:
            wow = C.c_int()
            if not self._api.IsWow64Process(self._handle, C.byref(wow)) or wow.value:
                raise ReadError("TARGET_X64_REQUIRED")
        except BaseException:
            self.close()
            raise

    def identity(self):
        status, created, exited, cpu_kernel, cpu_user = DWORD(), FileTime(), FileTime(), FileTime(), FileTime()
        output, count = C.create_unicode_buffer(32768), DWORD(32768)
        if (not self._api.GetExitCodeProcess(self._handle, C.byref(status)) or status.value != 259
                or not self._api.QueryFullProcessImageNameW(self._handle, 0, output, C.byref(count))
                or not self._api.GetProcessTimes(self._handle, C.byref(created), C.byref(exited), C.byref(cpu_kernel), C.byref(cpu_user))):
            raise ReadError("PROCESS_CHANGED_OR_EXITED")
        return ProcessIdentity(self.pid, normal_path(output.value), created.ticks, executable_version(output.value))

    def regions(self):
        address = 0
        while address < 0x800000000000:
            info = MemoryInfo()
            C.set_last_error(0)
            if not self._api.VirtualQueryEx(self._handle, address, C.byref(info), C.sizeof(info)):
                if C.get_last_error() == 87:  # Beyond the user address space.
                    break
                raise ReadError("PROCESS_REGION_ENUMERATION_FAILED")
            base, size = info.base or 0, info.size
            if size == 0 or base + size <= address:
                raise ReadError("PROCESS_REGION_INVALID")
            if info.state == 0x1000 and (info.protect & 0xFF) in (2, 4, 8, 32, 64, 128) and not info.protect & 0x100:
                yield base, size
            address = base + size

    def module(self, explicit_path):
        """Metadata for exactly this process's explicitly named loaded module."""
        target = normal_path(explicit_path)
        snapshot = self._api.CreateToolhelp32Snapshot(0x08 | 0x10, self.pid)
        if snapshot in (None, C.c_void_p(-1).value):
            raise ReadError("PROCESS_MODULE_METADATA_FAILED")
        found = []
        try:
            entry = ModuleEntry()
            entry.size = C.sizeof(entry)
            C.set_last_error(0)
            ok = self._api.Module32FirstW(snapshot, C.byref(entry))
            while ok:
                if normal_path(entry.path) == target:
                    found.append(ModuleIdentity(entry.base or 0, entry.image_size, target,
                                                executable_version(entry.path)))
                entry.size = C.sizeof(entry)
                C.set_last_error(0)
                ok = self._api.Module32NextW(snapshot, C.byref(entry))
            if C.get_last_error() != 18:  # ERROR_NO_MORE_FILES, including empty module lists.
                raise ReadError("PROCESS_MODULE_METADATA_FAILED")
        finally:
            if not self._api.CloseHandle(snapshot):
                raise ReadError("PROCESS_MODULE_CLOSE_FAILED")
        if not found:
            raise ReadError("EXPLICIT_MODULE_MISSING")
        if len(found) != 1:
            raise ReadError("EXPLICIT_MODULE_AMBIGUOUS")
        return found[0]

    def read(self, address: int, count: int):
        if not 0x10000 <= address < 0x800000000000 or not 0 < count <= 1024 * 1024:
            raise ReadError("PROCESS_READ_BOUNDS")
        output, actual = C.create_string_buffer(count), SIZE_T()
        if (not self._api.ReadProcessMemory(self._handle, address, output, count, C.byref(actual))
                or actual.value != count):
            raise ReadError("PROCESS_SHORT_READ")
        return output.raw

    def close(self):
        if self._handle is not None:
            if not self._api.CloseHandle(self._handle):
                raise ReadError("PROCESS_CLOSE_FAILED")
            self._handle = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
