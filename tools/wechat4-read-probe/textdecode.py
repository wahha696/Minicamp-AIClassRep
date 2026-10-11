"""Strict UTF-8 / single standard Zstandard frame decoding, memory only.

No WeChat/process/database access. Importing does not load native code. The
operator must explicitly supply a trusted absolute library path and budgets.
No prefix stripping, guessed offsets, lossy decoding or readable-byte salvage.
"""
from __future__ import annotations

import ctypes
import ntpath
import os
import re
from dataclasses import dataclass, field

from reader import ReadError

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


class _Buffer(ctypes.Structure):
    _fields_ = [("data", ctypes.c_void_p), ("size", ctypes.c_size_t),
                ("pos", ctypes.c_size_t)]


class ZstdDecoder:
    """Stable libzstd C API; one new, bounded streaming context per field."""
    def __init__(self, library_path, *, max_input_bytes, max_output_bytes, max_window_log):
        if (type(max_input_bytes) is not int or not 1 <= max_input_bytes <= 16 * 1024 * 1024
                or type(max_output_bytes) is not int or not 1 <= max_output_bytes <= 16 * 1024 * 1024
                or type(max_window_log) is not int or not 10 <= max_window_log <= 24):
            raise ReadError("EXPLICIT_TEXT_BUDGET_REQUIRED")
        if (not isinstance(library_path, str) or "\x00" in library_path
                or not os.path.isabs(library_path)
                or (os.name == "nt" and not re.fullmatch(r"[A-Za-z]:", ntpath.splitdrive(library_path)[0]))):
            raise ReadError("EXPLICIT_ZSTD_LIBRARY_REQUIRED")
        self.max_input_bytes, self.max_output_bytes = max_input_bytes, max_output_bytes
        self.max_window_log = max_window_log
        try:
            # Windows resolves dependencies only beside this explicit library
            # and in System32, never from cwd / PATH. No library auto-discovery.
            self._api = ctypes.CDLL(library_path, **({"winmode": 0x1100} if os.name == "nt" else {}))
            ptr, size = ctypes.c_void_p, ctypes.c_size_t
            signatures = {
                "ZSTD_versionNumber": ([], ctypes.c_uint),
                "ZSTD_isError": ([size], ctypes.c_uint),
                "ZSTD_findFrameCompressedSize": ([ptr, size], size),
                "ZSTD_getFrameContentSize": ([ptr, size], ctypes.c_ulonglong),
                "ZSTD_createDCtx": ([], ptr),
                "ZSTD_freeDCtx": ([ptr], size),
                "ZSTD_DCtx_setParameter": ([ptr, ctypes.c_int, ctypes.c_int], size),
                "ZSTD_decompressStream": ([ptr, ctypes.POINTER(_Buffer), ctypes.POINTER(_Buffer)], size),
            }
            for name, (args, result) in signatures.items():
                fn = getattr(self._api, name)
                fn.argtypes, fn.restype = args, result
            self.version = self._api.ZSTD_versionNumber()
            if not 10400 <= self.version < 20000:
                raise ReadError("ZSTD_LIBRARY_VERSION_UNSUPPORTED")
        except (OSError, AttributeError):
            raise ReadError("ZSTD_LIBRARY_UNAVAILABLE") from None

    def _check(self, result):
        if self._api.ZSTD_isError(result):
            raise ReadError("ZSTD_FRAME_REJECTED")
        return result

    def decompress(self, data):
        if not isinstance(data, bytes) or not data.startswith(ZSTD_MAGIC):
            raise ReadError("ZSTD_STANDARD_FRAME_REQUIRED")
        if len(data) > self.max_input_bytes:
            raise ReadError("TEXT_INPUT_LIMIT")
        src = ctypes.create_string_buffer(data, len(data))
        context, output = None, None
        chunks = bytearray()
        try:
            frame_size = self._check(self._api.ZSTD_findFrameCompressedSize(src, len(data)))
            if frame_size != len(data):
                raise ReadError("ZSTD_TRAILING_DATA")
            declared = self._api.ZSTD_getFrameContentSize(src, len(data))
            if declared == (1 << 64) - 2:
                raise ReadError("ZSTD_FRAME_REJECTED")
            if declared != (1 << 64) - 1 and declared > self.max_output_bytes:
                raise ReadError("TEXT_OUTPUT_LIMIT")
            context = self._api.ZSTD_createDCtx()
            if not context:
                raise ReadError("ZSTD_CONTEXT_UNAVAILABLE")
            # ZSTD_d_windowLogMax=100 is a stable streaming parameter.
            self._check(self._api.ZSTD_DCtx_setParameter(context, 100, self.max_window_log))
            source = _Buffer(ctypes.addressof(src), len(data), 0)
            output = ctypes.create_string_buffer(min(65536, self.max_output_bytes + 1))
            while True:
                capacity = min(len(output), self.max_output_bytes - len(chunks) + 1)
                target = _Buffer(ctypes.addressof(output), capacity, 0)
                before = source.pos
                remaining = self._check(self._api.ZSTD_decompressStream(
                    context, ctypes.byref(target), ctypes.byref(source)))
                if len(chunks) + target.pos > self.max_output_bytes:
                    raise ReadError("TEXT_OUTPUT_LIMIT")
                chunks.extend(output.raw[:target.pos])
                if remaining == 0:
                    if source.pos != len(data):
                        raise ReadError("ZSTD_TRAILING_DATA")
                    if declared != (1 << 64) - 1 and declared != len(chunks):
                        raise ReadError("ZSTD_FRAME_REJECTED")
                    return bytes(chunks)
                if source.pos == before and not target.pos:
                    raise ReadError("ZSTD_FRAME_REJECTED")
        finally:
            if context:
                self._api.ZSTD_freeDCtx(context)
            if output is not None:
                ctypes.memset(output, 0, len(output))
            ctypes.memset(src, 0, len(src))
            chunks[:] = bytes(len(chunks))
            chunks.clear()


@dataclass(frozen=True)
class DecodedField:
    text: str | None = field(repr=False)
    status: str
    compressed: bool = False


def decode_field(value, *, zstd=None):
    """Decode fields independently; does not guess which field is authoritative."""
    if value is None or value == b"" or value == "":
        return DecodedField("", "EMPTY")
    if isinstance(value, str):
        try:
            value.encode("utf-8", errors="strict")
        except UnicodeEncodeError:
            return DecodedField(None, "INVALID_UTF8")
        return DecodedField(value, "UTF8")
    if not isinstance(value, bytes):
        return DecodedField(None, "FIELD_TYPE_UNSUPPORTED")
    compressed = value.startswith(ZSTD_MAGIC)
    if compressed:
        if zstd is None:
            return DecodedField(None, "ZSTD_DECODER_REQUIRED", True)
        try:
            value = zstd.decompress(value)
        except ReadError as error:
            # Only local decoder codes, never a library's original error text.
            return DecodedField(None, str(error), True)
    try:
        text = value.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return DecodedField(None, "INVALID_UTF8", compressed)
    return DecodedField(text, "ZSTD_UTF8" if compressed else "UTF8", compressed)
