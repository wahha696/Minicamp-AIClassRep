"""Artificial frames only; installed pinned wheel, no real WeChat data."""
import importlib.util
import unittest

from reader import ReadError
from test_textdecode import raw_frame
from zstd_package import PackagedZstdDecoder


@unittest.skipUnless(importlib.util.find_spec('zstandard'), 'packaged zstandard is required')
class PackagedZstdTests(unittest.TestCase):
    def test_chinese_emoji_and_unknown_frame_size_decode_without_loss(self):
        decoder = PackagedZstdDecoder()
        text = '人工长文字\n中文 😀'.encode('utf-8')
        for frame in (raw_frame(text), raw_frame(text, unknown_size=True)):
            self.assertEqual(decoder.decompress(frame), text)
    def test_truncation_trailing_and_multiple_frames_are_rejected(self):
        decoder = PackagedZstdDecoder(); frame = raw_frame(b'synthetic')
        for value in (frame[:-1], frame + b'private trailing', frame + frame):
            with self.assertRaises(ReadError): decoder.decompress(value)
    def test_declared_output_unknown_output_and_window_budgets_are_enforced(self):
        decoder = PackagedZstdDecoder(max_output_bytes=8, max_window_log=18)
        for value in (raw_frame(b'x' * 9), raw_frame(b'x' * 9, unknown_size=True),
                raw_frame(b'x', unknown_size=True, window_descriptor=0x78)):
            with self.assertRaises(ReadError): decoder.decompress(value)


if __name__ == '__main__': unittest.main()
