import hashlib
import struct
import unittest
from unittest.mock import Mock, patch

from native import FileIdentity
from reader import ReadError
from static_type_probe import inspect_program
from static_types import CLASSES, PEImage, analyze_types

BASE = 0x180000000
PATH = r"c:\synthetic\weixin.dll"


def synthetic_image():
    image = bytearray(0x1200)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 0x3C, 0x80)
    image[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HH", image, 0x84, 0x8664, 3)
    struct.pack_into("<H", image, 0x94, 240)
    optional = 0x98
    struct.pack_into("<H", image, optional, 0x20B)
    struct.pack_into("<Q", image, optional + 24, BASE)
    struct.pack_into("<II", image, optional + 56, 0x4000, 0x400)
    struct.pack_into("<I", image, optional + 108, 16)
    struct.pack_into("<II", image, optional + 112 + 3 * 8, 0x3000, 24)
    sections = ((0x1000, 0x400, 0x400, 0x60000020),
                (0x2000, 0x800, 0x800, 0xC0000040),
                (0x3000, 0x1000, 0x200, 0x40000040))
    for index, (rva, raw, size, flags) in enumerate(sections):
        at = optional + 240 + index * 40
        struct.pack_into("<IIII", image, at + 8, size, rva, size, raw)
        struct.pack_into("<I", image, at + 36, flags)
    def offset(rva):
        return next(raw + rva - start for start, raw, size, _ in sections if start <= rva < start + size)
    for name, header, text, metadata, meta, getter, call, table in (
            (CLASSES[0], 0x20E0, 0x2100, 0x2150, 0x2200, 0x1010, 0x1050, 0x2280),
            (CLASSES[1], 0x2480, 0x24A0, 0x24E0, 0x2580, 0x1110, 0x1150, 0x2600)):
        encoded = name.encode() + b"\0"
        image[offset(text):offset(text) + len(encoded)] = encoded
        struct.pack_into("<iIIIq", image, offset(header), -1, len(encoded) - 1, 0, 0, text - header)
        struct.pack_into("<14I", image, offset(metadata), 8, *([0] * 13))
        struct.pack_into("<6Q", image, offset(meta), BASE + 0x2700, BASE + header,
                         BASE + metadata, BASE + call, 0, 0)
        image[offset(getter):offset(getter) + 3] = b"\x48\x8d\x05"
        struct.pack_into("<i", image, offset(getter) + 3, meta - getter - 7)
        image[offset(getter) + 7] = 0xC3
        struct.pack_into("<3Q", image, offset(table), BASE + getter, BASE + call, BASE + call + 16)
    struct.pack_into("<6I", image, 0x1000, 0x1010, 0x1030, 0x3020, 0x1110, 0x1130, 0x3020)
    struct.pack_into("<I", image, 0x1020, 1)
    return image


def analyze(image=None, **options):
    image = bytes(synthetic_image() if image is None else image)
    args = dict(expected_sha256=hashlib.sha256(image).hexdigest(), max_file_bytes=0x2000,
                max_image_bytes=0x5000, max_references=100, max_functions=10, max_seconds=5)
    args.update(options)
    return analyze_types(image, **args)


class File:
    def __init__(self):
        self.path, self.data, self.closed, self.short = PATH, bytes(synthetic_image()), False, False
        self.file_identity, self.reads = FileIdentity(1, 2, 3), []
        self.hook = None

    def size(self):
        return len(self.data)

    def identity(self):
        return self.file_identity

    def read(self, offset, size):
        self.reads.append((offset, size))
        if self.hook:
            self.hook()
        result = self.data[offset:offset + size]
        return result[:-1] if self.short else result

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


def inspect(source=None, **options):
    source = source or File()
    args = dict(path=PATH, expected_sha256=hashlib.sha256(source.data).hexdigest(),
                expected_version="4.1.15.50", max_bytes=0x5000, max_seconds=5,
                max_references=100, max_functions=10, file_factory=lambda _: source,
                version_reader=lambda _: "4.1.15.50")
    args.update(options)
    return inspect_program(**args)


class StaticTests(unittest.TestCase):
    def test_complete_static_chain_is_not_a_login_or_live_instance(self):
        result = analyze()
        self.assertEqual(tuple(t.class_name for t in result.types), CLASSES)
        self.assertEqual(result.types[0].metaobject_rva, 0x2200)
        self.assertEqual(result.types[0].reference_function_rvas, (0x1010,))
        self.assertEqual(result.types[0].pointer_table_candidates, (0x2280,))
        self.assertFalse(result.login_verified)
        self.assertNotIn("MainWindow", repr(result))

    def test_mutable_data_sections_allowed_only_for_offline_metadata(self):
        result = analyze()
        self.assertEqual(len(result.types), 2)
        pe = PEImage(bytes(synthetic_image()), max_file_bytes=0x2000, max_image_bytes=0x5000)
        with self.assertRaisesRegex(ReadError, "SECTION_PERMISSION"):
            pe.locate(0x2100, readonly=True)
        with self.assertRaisesRegex(ReadError, "SECTION_PERMISSION"):
            pe.locate(0x1010, data=True)
        with self.assertRaisesRegex(ReadError, "RVA_BOUNDS"):
            pe.locate(0x2FFF)

    def test_missing_instruction_links_remain_empty_not_guessed(self):
        image = synthetic_image()
        image[0x410:0x417] = bytes(7)
        result = analyze(image)
        self.assertEqual(result.types[0].reference_function_rvas, ())
        self.assertEqual(result.types[0].pointer_table_candidates, ())

    def test_ambiguous_reference_tables_are_all_reported_never_selected(self):
        image = synthetic_image()
        struct.pack_into("<3Q", image, 0xAB0, BASE + 0x1010, BASE + 0x1050, BASE + 0x1060)
        result = analyze(image)
        self.assertEqual(result.types[0].pointer_table_candidates, (0x2280, 0x22B0))
        self.assertFalse(result.login_verified)

    def test_broken_or_unsupported_pe_headers_rejected(self):
        for offset, raw in ((0, b"NO"), (0x80, b"NOPE"), (0x84, b"\x4c\x01"),
                            (0x86, struct.pack("<H", 97)), (0x98, b"\x0b\x01"),
                            (0x98 + 108, struct.pack("<I", 17))):
            image = synthetic_image()
            image[offset:offset + len(raw)] = raw
            with self.subTest(offset=offset), self.assertRaises(ReadError):
                analyze(image)
        with self.assertRaises(ReadError):
            analyze(bytes(synthetic_image())[:300])

    def test_section_aliases_overflow_and_zero_filled_ranges_rejected(self):
        # Second section's raw bytes cannot alias executable section bytes.
        image = synthetic_image()
        section = 0x98 + 240 + 40
        struct.pack_into("<I", image, section + 20, 0x400)
        with self.assertRaisesRegex(ReadError, "OVERLAPPING_SECTIONS"):
            analyze(image)
        image = synthetic_image()
        struct.pack_into("<I", image, section + 12, 0x1000)
        with self.assertRaisesRegex(ReadError, "OVERLAPPING_SECTIONS"):
            analyze(image)
        image = synthetic_image()
        struct.pack_into("<I", image, section + 16, 0x100000)
        with self.assertRaises(ReadError):
            analyze(image)

    def test_hash_and_explicit_budgets_gate_analysis(self):
        for options in (dict(expected_sha256="0" * 64), dict(expected_sha256="invalid"),
                        dict(max_file_bytes=1), dict(max_image_bytes=1), dict(max_references=0),
                        dict(max_functions=1), dict(max_seconds=float("nan")), dict(max_seconds=31)):
            with self.subTest(options=options), self.assertRaises(ReadError):
                analyze(**options)
        with self.assertRaisesRegex(ReadError, "TIME_EXCEEDED"):
            analyze(clock=Mock(side_effect=(0, 6)))

    def test_missing_duplicate_class_or_qt_string_header_rejected(self):
        image = synthetic_image()
        image[0x900] = ord("X")
        with self.assertRaisesRegex(ReadError, "CLASS_STRING_MISSING"):
            analyze(image)
        image = synthetic_image()
        name = CLASSES[0].encode() + b"\0"
        image[0xE00:0xE00 + len(name)] = name
        with self.assertRaisesRegex(ReadError, "CLASS_STRING_MISSING_OR_AMBIGUOUS"):
            analyze(image)
        image = synthetic_image()
        struct.pack_into("<iIIIq", image, 0x8A0, -1, len(CLASSES[0]), 0, 0, 0x60)
        with self.assertRaisesRegex(ReadError, "STRING_HEADER_MISSING_OR_AMBIGUOUS"):
            analyze(image)

    def test_missing_ambiguous_or_out_of_bounds_metaobject_never_partially_returns(self):
        for offset, raw in ((0x950, struct.pack("<I", 99)),
                            (0xA00 + 16, struct.pack("<Q", BASE + 0xFFFFFF)),
                            (0xA00 + 40, struct.pack("<Q", 1))):
            image = synthetic_image()
            image[offset:offset + len(raw)] = raw
            with self.subTest(offset=offset), self.assertRaisesRegex(ReadError, "METAOBJECT_MISSING_OR_AMBIGUOUS"):
                analyze(image)
        image = synthetic_image()
        image[0xE00:0xE30] = image[0xA00:0xA30]
        with self.assertRaisesRegex(ReadError, "METAOBJECT_MISSING_OR_AMBIGUOUS"):
            analyze(image)

    def test_invalid_unwind_ranges_and_non_code_tables_are_rejected(self):
        image = synthetic_image()
        struct.pack_into("<I", image, 0x1004, 0x1000)
        with self.assertRaisesRegex(ReadError, "EXCEPTION_DIRECTORY_INVALID"):
            analyze(image)
        image = synthetic_image()
        struct.pack_into("<Q", image, 0xA80 + 8, BASE + 0x2100)
        self.assertEqual(analyze(image).types[0].pointer_table_candidates, ())

    def test_other_rip_destination_registers_remain_candidates(self):
        image = synthetic_image()
        image[0x410:0x413] = b"\x4c\x8d\x3d"
        self.assertEqual(analyze(image).types[0].reference_function_rvas, (0x1010,))

    def test_exact_qt_accessor_without_unwind_entry_is_only_a_static_candidate(self):
        image = synthetic_image()
        start, meta, branch = 0x1200, 0x2200, 0x1300
        raw = 0x600
        image[raw - 1] = 0xCC
        image[raw:raw + 11] = b"\x48\x8b\x49\x08\x48\x83\x79\x28\0\x0f\x85"
        struct.pack_into("<i", image, raw + 11, branch - start - 15)
        image[raw + 15:raw + 18] = b"\x48\x8d\x05"
        struct.pack_into("<i", image, raw + 18, meta - start - 22)
        image[raw + 22] = 0xC3
        struct.pack_into("<3Q", image, 0xAB0, BASE + start, BASE + 0x1050, BASE + 0x1060)
        result = analyze(image)
        accessor = result.types[0].qt_accessor_candidates
        self.assertEqual(len(accessor), 1)
        self.assertEqual(accessor[0].function_rva, start)
        self.assertEqual(accessor[0].dynamic_meta_target_rva, branch)
        self.assertEqual(accessor[0].pointer_table_candidates, (0x22B0,))
        self.assertFalse(result.login_verified)
        original_find = PEImage.find
        def limited(pe, pattern, **kwargs):
            if pattern == struct.pack("<Q", BASE + start):
                raise ReadError("STATIC_REFERENCE_LIMIT")
            return original_find(pe, pattern, **kwargs)
        with patch.object(PEImage, "find", limited), self.assertRaisesRegex(ReadError, "STATIC_REFERENCE_LIMIT"):
            analyze(image)
        # Wrong field offset must not silently use the previous layout.
        image[raw + 7] = 0x30
        self.assertEqual(analyze(image).types[0].qt_accessor_candidates, ())

    def test_reference_limit_stops_instead_of_omitting_ambiguous_candidates(self):
        with self.assertRaisesRegex(ReadError, "STATIC_REFERENCE_LIMIT"):
            analyze(max_references=1)

    def test_file_capture_reads_only_explicit_file_and_closes_it(self):
        source = File()
        result = inspect(source)
        self.assertEqual(len(result.types), 2)
        self.assertEqual(source.reads, [(0, len(source.data))])
        self.assertTrue(source.closed)

    def test_file_scope_budget_and_version_fail_before_content_read(self):
        factory = Mock()
        for change in (dict(path=r"c:\synthetic\chat.db"), dict(expected_sha256="bad"),
                       dict(max_bytes=0), dict(max_functions=0), dict(max_seconds=31)):
            with self.subTest(change=change), self.assertRaises(ReadError):
                inspect(file_factory=factory, **change)
        factory.assert_not_called()
        for change in (dict(max_bytes=64), dict(version_reader=lambda _: "other")):
            source = File()
            with self.assertRaises(ReadError):
                inspect(source, **change)
            self.assertEqual(source.reads, [])
            self.assertTrue(source.closed)

    def test_short_read_file_replacement_and_path_change_stop(self):
        source = File()
        source.short = True
        with self.assertRaisesRegex(ReadError, "SHORT_READ"):
            inspect(source)
        self.assertTrue(source.closed)
        source = File()
        source.hook = lambda: setattr(source, "file_identity", FileIdentity(1, 999, 3))
        with self.assertRaisesRegex(ReadError, "FILE_CHANGED"):
            inspect(source)
        source = File()
        source.path = r"c:\other\weixin.dll"
        with self.assertRaisesRegex(ReadError, "PATH_CHANGED"):
            inspect(source)
        self.assertEqual(source.reads, [])


if __name__ == "__main__":
    unittest.main()
