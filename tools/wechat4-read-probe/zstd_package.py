"""Pinned packaged decoder, no PATH DLL discovery or implicit installation.

API contract: https://python-zstandard.readthedocs.io/en/latest/decompressor.html
Check declared size/window before decoding; reject truncation, multiple frames
and trailing bytes. Unknown-size frames still receive a strict output bound.
"""
from reader import ReadError
from textdecode import ZSTD_MAGIC


class PackagedZstdDecoder:
    def __init__(self, *, max_input_bytes=1048576, max_output_bytes=262144, max_window_log=20):
        if (type(max_input_bytes) is not int or not 1 <= max_input_bytes <= 16777216
                or type(max_output_bytes) is not int or not 1 <= max_output_bytes <= 16777216
                or type(max_window_log) is not int or not 10 <= max_window_log <= 24):
            raise ReadError('EXPLICIT_TEXT_BUDGET_REQUIRED')
        try:
            import zstandard
        except ImportError: raise ReadError('ZSTD_PACKAGE_UNAVAILABLE') from None
        if zstandard.__version__ != '0.25.0': raise ReadError('ZSTD_PACKAGE_VERSION_UNSUPPORTED')
        self._api = zstandard
        self.max_input_bytes, self.max_output_bytes, self.max_window_log = max_input_bytes, max_output_bytes, max_window_log

    def decompress(self, data):
        if type(data) is not bytes or not data.startswith(ZSTD_MAGIC): raise ReadError('ZSTD_STANDARD_FRAME_REQUIRED')
        if len(data) > self.max_input_bytes: raise ReadError('TEXT_INPUT_LIMIT')
        try:
            header = self._api.get_frame_parameters(data)
            if header.window_size > (1 << self.max_window_log): raise ReadError('ZSTD_WINDOW_LIMIT')
            if header.content_size != self._api.CONTENTSIZE_UNKNOWN and header.content_size > self.max_output_bytes:
                raise ReadError('TEXT_OUTPUT_LIMIT')
            # Header bounds above also cover APIs that allocate the declared size
            # even when max_output_size was provided. No dictionary guessing.
            # The pinned C backend enforces this value as bytes (verified with
            # unknown-size artificial frames). The explicit header check above
            # is our independent window bound, including backend/API variation.
            decoder = self._api.ZstdDecompressor(max_window_size=1 << self.max_window_log)
            result = decoder.decompress(data, max_output_size=self.max_output_bytes,
                read_across_frames=False, allow_extra_data=False)
            if len(result) > self.max_output_bytes: raise ReadError('TEXT_OUTPUT_LIMIT')
            return result
        except self._api.ZstdError: raise ReadError('ZSTD_FRAME_REJECTED') from None
