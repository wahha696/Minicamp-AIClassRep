"""AES-CBC through Windows CNG; no third-party package or key files.

Only cryptographic buffers are handled here. No WeChat/process/UI APIs.
"""
from __future__ import annotations

import ctypes
import sys


class CryptoError(RuntimeError):
    pass


class AesCbc:
    def __init__(self, key: bytes):
        if sys.platform != "win32":
            raise CryptoError("WINDOWS_CNG_REQUIRED")
        if len(key) != 32:
            raise CryptoError("AES256_KEY_LENGTH")
        self._api = ctypes.WinDLL("bcrypt")
        ptr, ulong = ctypes.c_void_p, ctypes.c_ulong
        signatures = {
            "BCryptOpenAlgorithmProvider": [ctypes.POINTER(ptr), ctypes.c_wchar_p, ctypes.c_wchar_p, ulong],
            "BCryptSetProperty": [ptr, ctypes.c_wchar_p, ptr, ulong, ulong],
            "BCryptGenerateSymmetricKey": [ptr, ctypes.POINTER(ptr), ptr, ulong, ptr, ulong, ulong],
            "BCryptDestroyKey": [ptr],
            "BCryptCloseAlgorithmProvider": [ptr, ulong],
            "BCryptDecrypt": [ptr, ptr, ulong, ptr, ptr, ulong, ptr, ulong, ctypes.POINTER(ulong), ulong],
        }
        for name, args in signatures.items():
            fn = getattr(self._api, name)
            fn.argtypes, fn.restype = args, ctypes.c_long
        self._algorithm, self._key = ptr(), ptr()
        try:
            self._check(self._api.BCryptOpenAlgorithmProvider(ctypes.byref(self._algorithm), "AES", None, 0))
            mode = ctypes.create_unicode_buffer("ChainingModeCBC")
            self._check(self._api.BCryptSetProperty(self._algorithm, "ChainingMode", mode, ctypes.sizeof(mode), 0))
            secret = ctypes.create_string_buffer(key, len(key))
            try:
                # Windows 7+ owns/frees the key object when buffer=None.
                self._check(self._api.BCryptGenerateSymmetricKey(
                    self._algorithm, ctypes.byref(self._key), None, 0, secret, len(key), 0))
            finally:
                ctypes.memset(secret, 0, len(key))
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _check(status: int):
        if status < 0:
            raise CryptoError("WINDOWS_CNG_FAILED")

    def decrypt(self, iv: bytes, ciphertext: bytes) -> bytes:
        if not self._key.value:
            raise CryptoError("KEY_CLOSED")
        if len(iv) != 16 or not ciphertext or len(ciphertext) % 16:
            raise CryptoError("AES_BLOCK_LENGTH")
        src = ctypes.create_string_buffer(ciphertext, len(ciphertext))
        vector = ctypes.create_string_buffer(iv, 16)  # BCryptDecrypt mutates the IV.
        out = ctypes.create_string_buffer(len(ciphertext))
        count = ctypes.c_ulong()
        try:
            self._check(self._api.BCryptDecrypt(self._key, src, len(ciphertext), None,
                                               vector, 16, out, len(ciphertext), ctypes.byref(count), 0))
            if count.value != len(ciphertext):
                raise CryptoError("AES_OUTPUT_LENGTH")
            return out.raw
        finally:
            ctypes.memset(out, 0, len(ciphertext))

    def close(self):
        if self._key.value:
            self._api.BCryptDestroyKey(self._key)
            self._key.value = None
        if self._algorithm.value:
            self._api.BCryptCloseAlgorithmProvider(self._algorithm, 0)
            self._algorithm.value = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
