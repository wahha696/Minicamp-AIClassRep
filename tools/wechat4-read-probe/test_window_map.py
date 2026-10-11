import struct
import unittest

from reader import ReadError
from static_types import CLASSES, PEImage
from static_window_map import LOOKUP_BODY, WindowMapper, find_window_mappers
from test_static_types import BASE, synthetic_image
from window_map_snapshot import observe_window_map


def profile(rva=0x1200, cell=0x2880):
    body = bytearray(LOOKUP_BODY)
    struct.pack_into("<i", body, 4, cell - rva - 8)
    return WindowMapper(rva, cell, bytes(body))


def offline_image():
    raw = synthetic_image()
    # The pointer cell is intentionally in unmaterialized virtual data.
    struct.pack_into("<I", raw, 0x98 + 240 + 40 + 8, 0x900)
    raw[0x600:0x600 + len(LOOKUP_BODY)] = profile().body
    return raw


def offline(raw=None, functions=None, **options):
    pe = PEImage(bytes(offline_image() if raw is None else raw), max_file_bytes=0x2000, max_image_bytes=0x5000)
    return find_window_mappers(pe, functions or [(0x1200, 0x1200 + len(LOOKUP_BODY))],
                              max_references=options.get("max_references", 10),
                              guard=options.get("guard", lambda: None))


class Memory:
    def __init__(self):
        self.bytes, self.reads, self.hook = {}, [], None
        self.root, self.data, self.buckets = 0x20000, 0x21000, 0x22000
        self.node, self.widget, self.private = 0x23000, 0x24000, 0x25000
        self.hwnd, self.seed, self.capacity = 0x1234, 7, 3
        self.mapper = profile()
        self.put(BASE + self.mapper.lookup_rva, self.mapper.body)
        self.pack(BASE + self.mapper.global_rva, "<Q", self.root)
        self.pack(self.root, "<Q", self.data)
        self.header()
        for i in range(self.capacity):
            self.pack(self.buckets + i * 8, "<Q", self.data)
        self.pack(self.buckets + self.hash(self.hwnd) % self.capacity * 8, "<Q", self.node)
        self.pack(self.node, "<QI4xQQ", self.data, self.hash(self.hwnd), self.hwnd, self.widget)
        self.pack(self.widget, "<Q", BASE + 0x2280)
        self.pack(self.widget + 8, "<Q", self.private)
        self.pack(self.widget + 0x28, "<Q", self.private + 0x120)
        self.pack(self.private + 8, "<Q", self.widget)
        self.pack(self.private + 0x120, "<Q", self.hwnd)
        self.pack(self.private + 0x130, "<I", 0)

    def hash(self, hwnd):
        return (hwnd ^ (hwnd >> 31) ^ self.seed) & 0xFFFFFFFF

    def header(self, *, size=1, node_size=32, capacity=None):
        self.pack(self.data, "<QQiiihhiI", 0, self.buckets, 1, size, node_size, 0, 4,
                  self.capacity if capacity is None else capacity, self.seed)

    def put(self, at, raw):
        self.bytes.update({at + i: b for i, b in enumerate(raw)})

    def pack(self, at, fmt, *values):
        self.put(at, struct.pack(fmt, *values))

    def read(self, at, size):
        self.reads.append((at, size))
        if self.hook:
            self.hook(at, size)
        # Unexpected reads (e.g. text/children/unmatched values) fail the test.
        return bytes(self.bytes[at + i] for i in range(size))

    def observe(self, **options):
        args = dict(read=self.read, module_base=BASE, mapper=self.mapper,
                    type_tables={BASE + 0x2280: CLASSES[0], BASE + 0x2600: CLASSES[1]},
                    hwnds=(self.hwnd,), max_bytes=1024 * 1024, max_nodes=128, max_seconds=5)
        args.update(options)
        return observe_window_map(**args)


class OfflineMapperTests(unittest.TestCase):
    def test_exact_lookup_and_virtual_cell_do_not_invent_bss_content(self):
        result = offline()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].lookup_rva, 0x1200)
        self.assertEqual(result[0].global_rva, 0x2880)
        self.assertFalse(result[0].login_verified)

    def test_bad_instruction_branch_and_function_boundaries_are_not_guessed(self):
        for at in (8, 12, 42, 68, 93, 122):
            raw = offline_image()
            raw[0x600 + at] ^= 1
            self.assertEqual(offline(raw), ())
        self.assertEqual(offline(functions=[(0x1201, 0x127B)]), ())

    def test_executable_unreadable_or_outside_cells_rejected(self):
        for cell in (0x1010, 0x4000, 0x2881):
            raw = offline_image()
            raw[0x600:0x67B] = profile(cell=cell).body
            self.assertEqual(offline(raw), ())
        raw = offline_image()
        struct.pack_into("<I", raw, 0x98 + 240 + 40 + 36, 0x80000040)
        self.assertEqual(offline(raw), ())

    def test_duplicate_valid_functions_preserved_as_ambiguity(self):
        raw = offline_image()
        raw[0x680:0x6FB] = profile(rva=0x1280).body
        found = offline(raw, functions=[(0x1200, 0x127B), (0x1280, 0x12FB)])
        self.assertEqual(len(found), 2)
        self.assertTrue(all(not x.login_verified for x in found))

    def test_time_and_reference_limits_propagate(self):
        with self.assertRaisesRegex(ReadError, "REFERENCE_LIMIT"):
            offline(max_references=0)
        def expired():
            raise ReadError("EXPIRED")
        with self.assertRaisesRegex(ReadError, "EXPIRED"):
            offline(guard=expired)


class MapSnapshotTests(unittest.TestCase):
    def test_stable_managed_main_window_is_still_not_login_proof(self):
        source = Memory()
        result = source.observe()
        self.assertEqual((result.main_windows, result.login_windows, result.unknown_windows, result.absent_windows),
                         (1, 0, 0, 0))
        self.assertFalse(result.login_verified)
        self.assertEqual(result.bytes_read, sum(size for _, size in source.reads))
        self.assertEqual(len(source.reads), 2 * len(set(source.reads)))

    def test_stale_unmanaged_object_is_never_scanned_or_counted(self):
        source = Memory()
        source.pack(source.buckets + source.hash(source.hwnd) % source.capacity * 8, "<Q", source.data)
        result = source.observe()
        self.assertEqual(result.absent_windows, 1)
        self.assertEqual(result.main_windows, 0)
        self.assertFalse(any(at == source.widget for at, _ in source.reads))

    def test_nonmatching_collision_value_is_not_dereferenced(self):
        source = Memory()
        other = source.hwnd + 3
        source.pack(0x26000, "<QI4xQQ", source.node, source.hash(other), other, 0xDEADBEEF)
        source.pack(source.buckets + source.hash(source.hwnd) % source.capacity * 8, "<Q", 0x26000)
        source.header(size=2)
        self.assertEqual(source.observe().main_windows, 1)
        self.assertFalse(any(at == 0xDEADBEEF for at, _ in source.reads))

    def test_unknown_widget_reads_only_its_type_pointer(self):
        source = Memory()
        source.pack(source.widget, "<Q", BASE + 0x2990)
        self.assertEqual(source.observe().unknown_windows, 1)
        self.assertFalse(any(source.widget < at < source.widget + 0x100 for at, _ in source.reads))

    def test_null_and_empty_maps_never_follow_buckets(self):
        source = Memory()
        source.pack(BASE + source.mapper.global_rva, "<Q", 0)
        self.assertEqual(source.observe().absent_windows, 1)
        self.assertEqual(len(source.reads), 4)  # only code and global, twice
        source = Memory()
        source.header(size=0, node_size=0, capacity=0)
        self.assertEqual(source.observe().absent_windows, 1)
        self.assertFalse(any(at == source.buckets for at, _ in source.reads))

    def test_changed_code_stops_before_following_map(self):
        source = Memory()
        source.put(BASE + source.mapper.lookup_rva, bytes(len(LOOKUP_BODY)))
        with self.assertRaisesRegex(ReadError, "CODE_CHANGED"):
            source.observe()
        self.assertEqual(len(source.reads), 1)

    def test_corrupted_layout_cycle_hash_and_duplicate_key_stop(self):
        cases = [
            ("LAYOUT_INVALID", lambda m: m.header(node_size=24)),
            ("LAYOUT_INVALID", lambda m: m.header(capacity=1000001)),
            ("POINTER_INVALID", lambda m: m.pack(m.root, "<Q", 7)),
            ("CYCLE", lambda m: m.pack(m.node, "<Q", m.node)),
            ("HASH_INVALID", lambda m: m.pack(m.node + 8, "<I", m.hash(m.hwnd) ^ 0xFF)),
        ]
        for code, mutate in cases:
            with self.subTest(code=code):
                source = Memory()
                mutate(source)
                with self.assertRaisesRegex(ReadError, code):
                    source.observe()
        source = Memory()
        source.pack(0x26000, "<QI4xQQ", source.node, source.hash(source.hwnd), source.hwnd, source.widget)
        source.pack(source.buckets + source.hash(source.hwnd) % source.capacity * 8, "<Q", 0x26000)
        source.header(size=2)
        with self.assertRaisesRegex(ReadError, "DUPLICATE_KEY"):
            source.observe()

    def test_destroying_misowned_or_reused_hwnd_stops(self):
        cases = [
            (source_at, fmt, value, code) for source_at, fmt, value, code in (
                (0x25008, "<Q", 0x28000, "OWNERSHIP_INVALID"),
                (0x24028, "<Q", 0x25128, "OWNERSHIP_INVALID"),
                (0x25120, "<Q", 0x8888, "HWND_MISMATCH"),
                (0x25130, "<I", 0x40000, "OBJECT_DESTROYING"))]
        for at, fmt, value, code in cases:
            source = Memory()
            source.pack(at, fmt, value)
            with self.subTest(code=code), self.assertRaisesRegex(ReadError, code):
                source.observe()

    def test_login_window_does_not_authenticate(self):
        source = Memory()
        source.pack(source.widget, "<Q", BASE + 0x2600)
        result = source.observe()
        self.assertEqual(result.login_windows, 1)
        self.assertFalse(result.login_verified)

    def test_coexisting_main_and_login_are_both_reported_without_authentication(self):
        source = Memory()
        hwnd = source.hwnd + 1
        node, widget, private = 0x27000, 0x28000, 0x29000
        source.header(size=2)
        source.pack(source.buckets + source.hash(hwnd) % source.capacity * 8, "<Q", node)
        source.pack(node, "<QI4xQQ", source.data, source.hash(hwnd), hwnd, widget)
        source.pack(widget, "<Q", BASE + 0x2600)
        source.pack(widget + 8, "<Q", private)
        source.pack(widget + 0x28, "<Q", private + 0x120)
        source.pack(private + 8, "<Q", widget)
        source.pack(private + 0x120, "<Q", hwnd)
        source.pack(private + 0x130, "<I", 0)
        result = source.observe(hwnds=(source.hwnd, hwnd))
        self.assertEqual((result.main_windows, result.login_windows), (1, 1))
        self.assertFalse(result.login_verified)

    def test_two_hwnds_mapping_same_object_are_rejected(self):
        source = Memory()
        hwnd, node = source.hwnd + 1, 0x27000
        source.header(size=2)
        source.pack(source.buckets + source.hash(hwnd) % source.capacity * 8, "<Q", node)
        source.pack(node, "<QI4xQQ", source.data, source.hash(hwnd), hwnd, source.widget)
        with self.assertRaisesRegex(ReadError, "DUPLICATE_OBJECT"):
            source.observe(hwnds=(source.hwnd, hwnd))

    def test_observed_mutation_between_passes_rejected(self):
        source = Memory()
        target = BASE + source.mapper.global_rva
        def mutate(at, size):
            if at == target and source.reads.count((at, size)) == 2:
                source.pack(target, "<Q", 0)
        source.hook = mutate
        with self.assertRaisesRegex(ReadError, "MAP_CHANGED"):
            source.observe()

    def test_byte_node_time_and_short_read_limits_stop(self):
        with self.assertRaisesRegex(ReadError, "BYTE_LIMIT"):
            Memory().observe(max_bytes=130)
        source = Memory()
        source.pack(0x26000, "<QI4xQQ", source.node, source.hash(source.hwnd + 3), source.hwnd + 3, 0)
        source.pack(source.buckets + source.hash(source.hwnd) % source.capacity * 8, "<Q", 0x26000)
        with self.assertRaisesRegex(ReadError, "NODE_LIMIT"):
            source.observe(max_nodes=1)
        ticks = iter((0, 6))
        with self.assertRaisesRegex(ReadError, "TIME_EXCEEDED"):
            Memory().observe(clock=lambda: next(ticks))
        with self.assertRaisesRegex(ReadError, "SHORT_READ"):
            Memory().observe(read=lambda at, size: bytes(size - 1))

    def test_invalid_budget_and_targets_fail_before_any_read(self):
        for options in (dict(max_bytes=True), dict(max_nodes=4097), dict(max_seconds=float('nan')),
                        dict(hwnds=(1, 1)), dict(type_tables={}), dict(module_base=0),
                        dict(type_tables={BASE + 0x2280: [], BASE + 0x2600: CLASSES[1]}),
                        dict(mapper=WindowMapper(0x1200, 0x3880, profile().body))):
            source = Memory()
            with self.subTest(options=options), self.assertRaises(ReadError):
                source.observe(**options)
            self.assertEqual(source.reads, [])


if __name__ == "__main__":
    unittest.main()
