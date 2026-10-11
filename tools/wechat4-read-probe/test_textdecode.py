"""Artificial text/frames only. Native tests opt in to an explicit local library."""
import ctypes
import hashlib
import os
import sqlite3
import struct
import unittest
from unittest.mock import patch

from canary import MarkerReceipt, baseline_reader, main
from reader import ReadError, Scope
from test_reader import ACCOUNT, GROUP_A, image, shard
from textdecode import ZSTD_MAGIC, ZstdDecoder, decode_field

MARKER = "CLASSREP_TEST_SYNTHETIC"


def raw_frame(data, *, unknown_size=False, window_descriptor=0x38, dictionary=None):
    """Build independent standard raw-block fixtures from the published format."""
    if len(data) > 131072:
        raise ValueError("fixture must fit one raw block")
    if unknown_size:
        header = bytes((0, window_descriptor))
    elif len(data) < 256:
        header = b"\x20" + bytes((len(data),))
    elif len(data) < 65792:
        header = b"\x60" + struct.pack("<H", len(data) - 256)
    else:
        header = b"\xa0" + struct.pack("<I", len(data))
    if dictionary is not None:
        if len(data) >= 256 or unknown_size:
            raise ValueError("small fixture only")
        header = b"\x21" + bytes((dictionary, len(data)))
    return ZSTD_MAGIC + header + ((len(data) << 3) | 1).to_bytes(3, "little") + data


class TextDecodeTests(unittest.TestCase):
    def test_utf8_preserves_whitespace_chinese_emoji_and_nuls(self):
        text = " \n中文😀\x00\n "
        for value in (text, text.encode()):
            result = decode_field(value)
            self.assertEqual(text, result.text)
            self.assertEqual("UTF8", result.status)
            self.assertNotIn("中文", repr(result))
        for value in (None, b"", ""):
            self.assertEqual("", decode_field(value).text)

    def test_invalid_utf8_and_unknown_types_are_not_salvaged(self):
        for value in (b"private\xff", "private\ud800"):
            result = decode_field(value)
            self.assertIsNone(result.text)
            self.assertEqual("INVALID_UTF8", result.status)
            self.assertNotIn("private", repr(result))
        self.assertEqual("FIELD_TYPE_UNSUPPORTED", decode_field(123).status)

    def test_native_code_is_not_loaded_implicitly(self):
        with patch("textdecode.ctypes.CDLL") as load:
            result = decode_field(raw_frame(MARKER.encode()))
            self.assertEqual("ZSTD_DECODER_REQUIRED", result.status)
            self.assertIsNone(result.text)
            load.assert_not_called()

    def test_library_path_and_budgets_are_required_before_loading(self):
        options = dict(max_input_bytes=1024, max_output_bytes=1024, max_window_log=18)
        with patch("textdecode.ctypes.CDLL") as load:
            for path in (None, "libzstd.dll", "", os.path.abspath("bad\x00path.dll")):
                with self.assertRaisesRegex(ReadError, "EXPLICIT_ZSTD_LIBRARY_REQUIRED"):
                    ZstdDecoder(path, **options)
            for name, value in (("max_input_bytes", 0), ("max_output_bytes", True),
                                ("max_output_bytes", 16777217), ("max_window_log", 0)):
                with self.assertRaisesRegex(ReadError, "EXPLICIT_TEXT_BUDGET_REQUIRED"):
                    ZstdDecoder(os.path.abspath("unused.dll"), **(options | {name: value}))
            load.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows local-drive path validation")
    def test_windows_rooted_or_network_library_paths_are_not_local_absolute(self):
        with patch("textdecode.ctypes.CDLL") as load:
            for path in (r"\libzstd.dll", r"\\server\share\libzstd.dll", r"C:libzstd.dll"):
                with self.assertRaisesRegex(ReadError, "EXPLICIT_ZSTD_LIBRARY_REQUIRED"):
                    ZstdDecoder(path, max_input_bytes=1024, max_output_bytes=1024, max_window_log=18)
            load.assert_not_called()

    def test_missing_library_error_does_not_expose_path(self):
        with patch("textdecode.ctypes.CDLL", side_effect=OSError("private/path")):
            with self.assertRaisesRegex(ReadError, "^ZSTD_LIBRARY_UNAVAILABLE$"):
                ZstdDecoder(os.path.abspath("unused.dll"), max_input_bytes=1024,
                            max_output_bytes=1024, max_window_log=18)

    def test_partial_cli_text_options_cannot_open_metadata_or_wechat(self):
        args = ["--metadata", "unused", "--account", ACCOUNT, "--group", GROUP_A,
                "--marker", MARKER, "--version", "4.1.15.50", "--vfs-profile", "unused",
                "--approve-key-read", "--approve-encrypted-db-read", "--accept-os-memory-limit",
                "--approve-experimental-profile", "--approve-new-texts-since-baseline",
                "--scan-bytes", "100", "--scan-seconds", "1", "--snapshot-bytes", "100",
                "--snapshot-seconds", "1", "--window-seconds", "1", "--poll-seconds", "1",
                "--zstd-library", os.path.abspath("unused.dll")]
        with patch("builtins.open") as opened, patch("canary.NativeProcess") as process:
            with self.assertRaisesRegex(ReadError, "EXPLICIT_ZSTD_LIBRARY_AND_BUDGETS_REQUIRED"):
                main(args)
            opened.assert_not_called()
            process.assert_not_called()


class NativeZstdTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = os.environ.get("WECHAT4_TEST_ZSTD_LIBRARY")
        if not path:
            raise unittest.SkipTest("Explicit WECHAT4_TEST_ZSTD_LIBRARY required for native artificial tests")
        # An explicitly requested but invalid library fails, never skips.
        cls.path = path
        cls.decoder = cls.make_decoder()

    @classmethod
    def make_decoder(cls, **changes):
        return ZstdDecoder(cls.path, **(dict(max_input_bytes=262144,
            max_output_bytes=262144, max_window_log=18) | changes))

    def compressed(self, data, *, content_size=True, checksum=True):
        """Exercise compressed blocks too; raw fixtures above are independent."""
        api = self.decoder._api
        p, s = ctypes.c_void_p, ctypes.c_size_t
        for name, args, result in (
            ("ZSTD_createCCtx", [], p), ("ZSTD_freeCCtx", [p], s),
            ("ZSTD_CCtx_setParameter", [p, ctypes.c_int, ctypes.c_int], s),
            ("ZSTD_compressBound", [s], s), ("ZSTD_compress2", [p, p, s, p, s], s)):
            fn = getattr(api, name)
            fn.argtypes, fn.restype = args, result
        context = api.ZSTD_createCCtx()
        self.assertTrue(context)
        try:
            self.decoder._check(api.ZSTD_CCtx_setParameter(context, 200, int(content_size)))
            self.decoder._check(api.ZSTD_CCtx_setParameter(context, 201, int(checksum)))
            src = ctypes.create_string_buffer(data, max(1, len(data)))
            out = ctypes.create_string_buffer(api.ZSTD_compressBound(len(data)))
            size = self.decoder._check(api.ZSTD_compress2(context, out, len(out), src, len(data)))
            return out.raw[:size]
        finally:
            api.ZSTD_freeCCtx(context)

    def test_raw_frames_empty_and_unknown_length(self):
        for data in (b"", " \n中文😀\x00\n ".encode(), b"abc" * 30000):
            for unknown in (False, True):
                frame = raw_frame(data, unknown_size=unknown)
                self.assertEqual(data, self.decoder.decompress(frame))
                self.assertEqual(data.decode(), decode_field(frame, zstd=self.decoder).text)

    def test_actual_compressed_long_text_and_checksum(self):
        text = ("人工正文 中文😀\n" * 3000) + MARKER
        for known in (False, True):
            frame = self.compressed(text.encode(), content_size=known)
            self.assertLess(len(frame), len(text.encode()) // 5)
            self.assertEqual(text, decode_field(frame, zstd=self.decoder).text)
            damaged = frame[:-1] + bytes((frame[-1] ^ 1,))
            self.assertIsNone(decode_field(damaged, zstd=self.decoder).text)

    def test_input_known_output_and_unknown_output_limits(self):
        frame = raw_frame(b"x" * 10000)
        with self.assertRaisesRegex(ReadError, "TEXT_INPUT_LIMIT"):
            self.make_decoder(max_input_bytes=100).decompress(frame)
        decoder = self.make_decoder(max_output_bytes=1000)
        for known in (False, True):
            frame = self.compressed(b"x" * 10000, content_size=known)
            with self.assertRaisesRegex(ReadError, "TEXT_OUTPUT_LIMIT"):
                decoder.decompress(frame)
        exact = self.make_decoder(max_output_bytes=10000)
        self.assertEqual(b"x" * 10000, exact.decompress(self.compressed(b"x" * 10000, content_size=False)))

    def test_large_advertised_window_rejected(self):
        frame = raw_frame(b"small", unknown_size=True, window_descriptor=0x50)
        with self.assertRaisesRegex(ReadError, "ZSTD_FRAME_REJECTED"):
            self.make_decoder(max_window_log=10).decompress(frame)

    def test_truncation_trailing_concatenated_and_skippable_rejected(self):
        frame = raw_frame(MARKER.encode())
        for data in (frame[:-1], frame + b"trailer", frame + frame,
                     b"\x50\x2a\x4d\x18" + bytes(4) + frame):
            with self.subTest(size=len(data)):
                with self.assertRaises(ReadError):
                    self.decoder.decompress(data)
        self.assertEqual(MARKER.encode(), self.decoder.decompress(frame))

    def test_dictionary_frame_and_invalid_decoded_utf8_rejected(self):
        with self.assertRaisesRegex(ReadError, "ZSTD_FRAME_REJECTED"):
            self.decoder.decompress(raw_frame(b"text", dictionary=7))
        result = decode_field(raw_frame(b"private\xff"), zstd=self.decoder)
        self.assertEqual("INVALID_UTF8", result.status)
        self.assertNotIn("private", repr(result))

    def deliver(self, rows):
        scope = Scope(ACCOUNT, (GROUP_A,))
        reader = baseline_reader(scope, (shard(image({GROUP_A: []})),))
        db = sqlite3.connect(":memory:")
        try:
            db.deserialize(image({GROUP_A: [(i, i, 100 + i, primary)
                                          for i, primary, secondary in rows]}))
            table = "Msg_" + hashlib.md5(GROUP_A.encode()).hexdigest()
            for i, primary, secondary in rows:
                db.execute(f'UPDATE "{table}" SET compress_content=? WHERE local_id=?', (secondary, i))
            db.commit()
            data = db.serialize()
        finally:
            db.close()
        receipt = MarkerReceipt(MARKER, zstd=self.decoder)
        reader.deliver((shard(data),), receipt, limit=100)
        return receipt.summary()

    def test_canary_decodes_both_fields_without_printing_text(self):
        frame = self.compressed(("人工\n" + MARKER).encode())
        summary = self.deliver([(1, frame, None), (2, "", frame), (3, frame, frame)])
        self.assertEqual(3, summary["marker_count"])
        self.assertEqual(4, summary["zstd_fields_decoded"])
        self.assertFalse(summary["unverified_encoded_content"])
        self.assertNotIn(MARKER, str(summary))
        self.assertNotIn("人工", str(summary))

    def test_canary_conflicting_fields_and_bad_frames_are_explicit(self):
        frame = self.compressed(MARKER.encode())
        summary = self.deliver([(1, "different private text", frame),
                                (2, frame[:-1], None), (3, frame + b"trailer", None)])
        self.assertEqual(0, summary["marker_count"])
        self.assertEqual(1, summary["conflicting_text_fields"])
        self.assertEqual(2, summary["undecoded_fields"])
        self.assertTrue(summary["unverified_encoded_content"])
        self.assertNotIn("private", str(summary))


if __name__ == "__main__":
    unittest.main()
