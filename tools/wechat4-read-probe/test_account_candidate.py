import os
import contextlib
import io
import json
import struct
import sys
import tempfile
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from unittest.mock import Mock

from account_candidate import AccountProfile, observe_account
from account_candidate_probe import main
from native import ModuleIdentity, NativeProcess, ProcessIdentity, normal_path
from reader import ReadError

PROCESS = ProcessIdentity(1234, r"c:\synthetic\weixin.exe", 123456, "4.1.15.50")
MODULE = ModuleIdentity(0x10000, 1024 * 1024 + 128, r"c:\synthetic\4.1.15.50\weixin.dll", "4.1.15.50")


class Process:
    def __init__(self, account=b"wxid_synthetic_current", *, anchor_offset=1024 * 1024 - 16):
        self.calls, self.closed, self.short, self.hook = [], False, False, None
        self.identity_calls, self.module_calls = 0, 0
        self.process_identity, self.module_identity = PROCESS, MODULE
        self.owner, self.config, self.text = 0x70000000, 0x80000000, 0x90000000
        image = bytearray(MODULE.size)
        image[anchor_offset:anchor_offset + 13] = b"global_config"
        struct.pack_into("<QQ", image, anchor_offset + 16, 13, 15)
        struct.pack_into("<Q", image, anchor_offset + 16 - 0x138, self.owner)
        owner, config, text = bytearray(256), bytearray(1024), bytearray(256)
        struct.pack_into("<Q", owner, 0x68, self.config)
        if len(account) <= 15:
            config[0x48:0x48 + len(account)] = account
            struct.pack_into("<QQ", config, 0x48 + 16, len(account), 15)
        else:
            struct.pack_into("<Q", config, 0x48, self.text)
            struct.pack_into("<QQ", config, 0x48 + 16, len(account), 255)
            text[:len(account)] = account
        config[0x2B8:0x2D8] = b"SECRET_MASTER_KEY_MUST_NOT_READ!!"
        self.memory = {MODULE.base: image, self.owner: owner, self.config: config, self.text: text}

    def identity(self):
        self.identity_calls += 1
        return self.process_identity

    def module(self, path):
        self.module_calls += 1
        if path != MODULE.path:
            raise AssertionError("wrong module path")
        return self.module_identity

    def read(self, address, count):
        self.calls.append((address, count))
        if address < self.config + 0x2D8 and address + count > self.config + 0x2B8:
            raise AssertionError("nearby master key must not be read")
        if self.hook:
            self.hook(self, address, count)
        for base, data in self.memory.items():
            if base <= address < address + count <= base + len(data):
                result = bytes(data[address - base:address - base + count])
                return result[:-1] if self.short else result
        raise ReadError("SYNTHETIC_READ_OUTSIDE_SCOPE")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


def observe(process, **options):
    values = {"expected_process": PROCESS, "expected_module": MODULE,
        "profile": AccountProfile(PROCESS.version, True), "approve_runtime_account_read": True,
        "accept_os_memory_limit": True, "max_bytes": MODULE.size + 4096, "max_seconds": 5,
        "process_factory": lambda _: process}
    values.update(options)
    return observe_account(**values)


class AccountTests(unittest.TestCase):
    def test_learned_location_reads_fresh_account_without_rescanning_module(self):
        process = Process()
        first = observe(process)
        process.calls.clear()
        changed = b"wxid_synthetic_changed"
        process.memory[process.text][:len(changed)] = changed
        struct.pack_into("<Q", process.memory[process.config], 0x48 + 16, len(changed))
        current = observe(process, anchor_rva=first.anchor_rva, max_bytes=4096)
        self.assertEqual(current.account_id, changed.decode())
        self.assertLess(current.read_bytes, 4096)
        self.assertTrue(all(count <= 32 for _, count in process.calls))
        self.assertFalse(current.login_verified)

    def test_cached_location_checks_landmark_and_stops_without_fallback(self):
        process = Process()
        first = observe(process)
        process.memory[MODULE.base][first.anchor_rva] = ord('X')
        process.calls.clear()
        with self.assertRaisesRegex(ReadError, 'ACCOUNT_ANCHOR_CHANGED'):
            observe(process, anchor_rva=first.anchor_rva, max_bytes=4096)
        self.assertEqual(process.calls, [(MODULE.base + first.anchor_rva, 32)])

    def test_bad_cached_location_rejected_before_opening_handle(self):
        factory = Mock()
        for rva in (True, 0, 0x1001, MODULE.size - 8):
            with self.subTest(rva=rva), self.assertRaises(ReadError):
                observe(Process(), anchor_rva=rva, max_bytes=4096, process_factory=factory)
        factory.assert_not_called()

    def test_cached_location_does_not_accept_changed_process_or_module(self):
        for key, value in (('process_identity', replace(PROCESS, created=1)),
                           ('module_identity', replace(MODULE, base=MODULE.base + 65536))):
            process = Process()
            first = observe(process)
            process.calls.clear()
            setattr(process, key, value)
            with self.assertRaises(ReadError):
                observe(process, anchor_rva=first.anchor_rva, max_bytes=4096)
            self.assertEqual(process.calls, [])

    def test_cross_chunk_landmark_and_heap_account_no_keys_or_login_proof(self):
        process = Process()
        result = observe(process)
        self.assertEqual(result.account_id, "wxid_synthetic_current")
        self.assertFalse(result.login_verified)
        self.assertGreater(result.read_bytes, MODULE.size)
        self.assertNotIn("synthetic_current", repr(result))
        self.assertTrue(process.closed)
        self.assertEqual(process.module_calls, 2)

    def test_inline_and_empty_fields_do_not_imply_current_login(self):
        for raw, expected in ((b"wxid_short", "wxid_short"), (b"", None)):
            result = observe(Process(raw))
            self.assertEqual(result.account_id, expected)
            self.assertFalse(result.login_verified)

    def test_cached_account_after_logout_is_never_authorized(self):
        process = Process(b"wxid_still_cached")
        # No login-state evidence is provided. Identical stale bytes remain only a candidate.
        result = observe(process)
        self.assertEqual(result.account_id, "wxid_still_cached")
        self.assertFalse(result.login_verified)

    def test_same_process_disconnect_and_recovery_never_reuses_previous_account(self):
        # Model both pointer-chain invalidation points without erasing old text.
        # A later successful observation must read again, never reuse a result.
        for cleared_owner in (True, False):
            with self.subTest(cleared_owner=cleared_owner):
                process = Process()
                first = observe(process)
                self.assertEqual(first.account_id, "wxid_synthetic_current")
                parent = process.memory[MODULE.base if cleared_owner else process.owner]
                offset = 1024 * 1024 - 0x138 if cleared_owner else 0x68
                original = bytes(parent[offset:offset + 8])
                parent[offset:offset + 8] = bytes(8)
                process.calls.clear()
                process.closed = False
                with self.assertRaisesRegex(ReadError, "ACCOUNT_POINTER_INVALID"):
                    observe(process)
                self.assertTrue(process.closed)
                self.assertNotIn((process.config + 0x48, 32), process.calls)
                parent[offset:offset + 8] = original
                new_account = b"wxid_synthetic_changed"
                process.memory[process.text][:len(new_account)] = new_account
                struct.pack_into("<Q", process.memory[process.config], 0x48 + 16, len(new_account))
                process.closed = False
                recovered = observe(process)
                self.assertEqual(recovered.account_id, new_account.decode("ascii"))
                self.assertNotEqual(first.account_id, recovered.account_id)
                self.assertFalse(first.login_verified)
                self.assertFalse(recovered.login_verified)
                self.assertTrue(process.closed)

    def test_missing_consent_invalid_budgets_profiles_and_identities_open_nothing(self):
        factory = Mock()
        cases = ({"approve_runtime_account_read": False}, {"accept_os_memory_limit": False},
                 {"profile": AccountProfile(PROCESS.version)}, {"max_seconds": float("nan")},
                 {"max_seconds": 61}, {"max_bytes": MODULE.size - 1},
                 {"expected_module": replace(MODULE, version="4.1.16.1")},
                 {"expected_process": replace(PROCESS, executable=r"c:\synthetic\other.exe")})
        for case in cases:
            with self.subTest(case=case), self.assertRaises(ReadError):
                observe(Process(), process_factory=factory, **case)
        factory.assert_not_called()

    def test_ambiguous_anchor_not_first_or_recent(self):
        process = Process()
        other = 2048
        process.memory[MODULE.base][other:other + 13] = b"global_config"
        struct.pack_into("<QQ", process.memory[MODULE.base], other + 16, 13, 15)
        with self.assertRaisesRegex(ReadError, "ANCHOR_AMBIGUOUS"):
            observe(process)
        self.assertTrue(process.closed)
        self.assertTrue(all(address < MODULE.base + MODULE.size for address, _ in process.calls))

    def test_missing_anchor_or_bad_pointer_no_fallback(self):
        process = Process()
        process.memory[MODULE.base][:] = bytes(MODULE.size)
        with self.assertRaisesRegex(ReadError, "ANCHOR_NOT_FOUND"):
            observe(process)
        process = Process()
        struct.pack_into("<Q", process.memory[MODULE.base], 1024 * 1024 - 0x138, 8)
        with self.assertRaisesRegex(ReadError, "POINTER_INVALID"):
            observe(process)

    def test_bad_id_and_string_capacity_not_salvaged_or_leaked(self):
        for raw in (b"private/name", b"bad\xffid", b"123number", b"wxid\0extra"):
            with self.assertRaisesRegex(ReadError, "ACCOUNT_STRING_INVALID") as caught:
                observe(Process(raw))
            self.assertNotIn(str(raw), str(caught.exception))
        process = Process()
        struct.pack_into("<Q", process.memory[process.config], 0x48 + 24, 3)
        with self.assertRaisesRegex(ReadError, "LAYOUT_UNSUPPORTED"):
            observe(process)

    def test_change_during_string_read_fails_and_closes(self):
        process = Process()
        reads = []
        def change(host, address, _count):
            if address == host.text:
                reads.append(address)
                if len(reads) == 2:
                    host.memory[host.text][0] = ord("z")
        process.hook = change
        with self.assertRaisesRegex(ReadError, "ACCOUNT_VALUE_CHANGED"):
            observe(process)
        self.assertTrue(process.closed)

    def test_pointer_chain_changed_even_when_account_field_unchanged(self):
        process = Process()
        reads = []
        def change(host, address, _count):
            if address == host.owner + 0x68:
                reads.append(address)
                if len(reads) == 2:
                    struct.pack_into("<Q", host.memory[host.owner], 0x68, host.config + 4096)
        process.hook = change
        with self.assertRaisesRegex(ReadError, "ACCOUNT_VALUE_CHANGED"):
            observe(process)

    def test_process_or_module_change_short_reads_budgets_stop(self):
        process = Process()
        process.module_identity = replace(MODULE, base=MODULE.base + 4096)
        with self.assertRaisesRegex(ReadError, "MODULE_IDENTITY_CHANGED"):
            observe(process)
        self.assertEqual(process.calls, [])
        process = Process(); process.short = True
        with self.assertRaisesRegex(ReadError, "SHORT_READ"):
            observe(process)
        process = Process()
        def change(host, _address, _count):
            host.process_identity = replace(PROCESS, created=PROCESS.created + 1)
        process.hook = change
        with self.assertRaisesRegex(ReadError, "IDENTITY_CHANGED"):
            observe(process)
        with self.assertRaisesRegex(ReadError, "BYTE_BUDGET_EXCEEDED"):
            observe(Process(), max_bytes=MODULE.size)
        times = iter((0, 0, 6))
        with self.assertRaisesRegex(ReadError, "TIME_EXCEEDED"):
            observe(Process(), clock=lambda: next(times))

    @unittest.skipUnless(sys.platform == "win32", "native module metadata requires Windows")
    def test_native_module_metadata_for_only_the_test_process(self):
        with NativeProcess(os.getpid()) as process:
            result = process.module(normal_path(sys.executable))
            self.assertGreater(result.base, 0)
            self.assertGreater(result.size, 0)
            self.assertEqual(result.path, normal_path(sys.executable))

    def test_cli_outputs_only_matching_boolean_and_never_authenticates(self):
        research = Path(__file__).resolve().parents[2] / ".review-research"
        with tempfile.TemporaryDirectory(prefix="synthetic-account-observation-", dir=research) as folder:
            self.assertTrue(Path(folder).resolve().is_relative_to(research.resolve()))
            metadata = Path(folder) / "metadata.json"
            metadata.write_text(json.dumps({"process": asdict(PROCESS), "module": asdict(MODULE),
                "expected_account": "wxid_synthetic_current"}), encoding="utf-8")
            args = ["--metadata", str(metadata), "--version", PROCESS.version,
                "--max-read-bytes", str(MODULE.size + 4096), "--max-read-seconds", "5",
                "--approve-runtime-account-read", "--accept-os-memory-limit", "--approve-experimental-layout"]
            process, output = Process(), io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main(args, process_factory=lambda _: process)
            self.assertEqual(code, 0)
            self.assertTrue(json.loads(output.getvalue())["expected_account_matched"])
            self.assertFalse(json.loads(output.getvalue())["login_verified"])
            self.assertNotIn("wxid_synthetic_current", output.getvalue())
            self.assertNotIn(PROCESS.executable, output.getvalue())


if __name__ == "__main__":
    unittest.main()
