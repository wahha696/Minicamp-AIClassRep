from dataclasses import replace
import struct
import unittest
from unittest.mock import Mock

from identity_snapshot import observe_identity_snapshot
from reader import ReadError
from test_managed_windows import BASE, PROCESS, MODULE, SHA, Process, Windows


def source():
    p = Process()
    for i in range(MODULE.size):
        p.bytes.setdefault(BASE + i, 0)
    p.anchor, p.owner, p.config, p.text = 0x3000, 0x30000, 0x31000, 0x32000
    p.pack(BASE + p.anchor, '<16sQQ', b'global_config', 13, 15)
    p.pack(BASE + p.anchor + 16 - 0x138, '<Q', p.owner)
    p.pack(p.owner + 0x68, '<Q', p.config)
    text = b'wxid_synthetic_account'
    p.pack(p.config + 0x48, '<QQQQ', p.text, 0, len(text), 255)
    p.put(p.text, text)
    return p


def observe(p=None, **options):
    p = p or source()
    args = dict(expected_process=PROCESS, expected_module=MODULE, report=p.report, expected_sha256=SHA,
                approve_joint_read=True, accept_os_memory_limit=True, max_bytes=1048576, max_seconds=15,
                process_factory=lambda _: p, windows_factory=Windows)
    args.update(options)
    return observe_identity_snapshot(**args)


class JointSnapshotTests(unittest.TestCase):
    def test_full_joint_snapshot_rechecks_both_account_and_window_without_auth(self):
        p = source()
        result = observe(p)
        self.assertEqual(result.state, 'main_and_account_observed')
        self.assertEqual(result.account_id, 'wxid_synthetic_account')
        self.assertEqual(result.anchor_rva, p.anchor)
        self.assertEqual(result.window_checks, 2)
        self.assertFalse(result.login_verified)
        self.assertTrue(p.closed)
        self.assertEqual(result.bytes_read, sum(n for _, n in p.reads))
        self.assertNotIn('synthetic_account', repr(result))

    def test_login_page_or_unknown_state_skips_all_account_memory(self):
        for table, state in ((BASE + 0x2600, 'login_page_observed'), (BASE + 0x2700, 'unknown')):
            p = source()
            p.pack(p.widget, '<Q', table)
            result = observe(p)
            self.assertEqual(result.state, state)
            self.assertIsNone(result.account_id)
            self.assertIsNone(result.anchor_rva)
            self.assertFalse(any(at == BASE or at == p.owner + 0x68 for at, n in p.reads))

    def test_joint_cached_anchor_never_reads_full_module(self):
        p = source()
        result = observe(p, anchor_rva=p.anchor, max_bytes=4096)
        self.assertEqual(result.state, 'main_and_account_observed')
        self.assertLess(result.bytes_read, 4096)
        self.assertFalse(any(at == BASE for at, n in p.reads))

    def test_stale_account_after_logout_is_not_read_or_restored(self):
        p = source()
        first = observe(p, anchor_rva=p.anchor)
        p.reads.clear()
        p.pack(p.widget, '<Q', BASE + 0x2600)
        result = observe(p, anchor_rva=first.anchor_rva)
        self.assertEqual(result.state, 'login_page_observed')
        self.assertIsNone(result.account_id)
        self.assertFalse(any(at == p.config + 0x48 for at, n in p.reads))

    def test_account_change_between_confirmations_stops(self):
        p = source()
        def mutate(at, size):
            if at == BASE + p.anchor and p.reads.count((at, size)) == 3:
                p.put(p.text, b'wxid_synthetic_changed')
        p.hook = mutate
        with self.assertRaisesRegex(ReadError, 'JOINT_ACCOUNT_CHANGED'):
            observe(p, anchor_rva=p.anchor)
        self.assertTrue(p.closed)

    def test_changed_window_state_or_ownership_after_account_stops(self):
        p = source()
        def mutate(at, size):
            if at == p.config + 0x48:
                p.pack(p.widget, '<Q', BASE + 0x2600)
        p.hook = mutate
        with self.assertRaisesRegex(ReadError, 'JOINT_WINDOW_STATE_CHANGED'):
            observe(p, anchor_rva=p.anchor)
        self.assertTrue(p.closed)

    def test_mid_read_process_change_closes_only_owned_handle(self):
        p = source()
        def mutate(at, size):
            if at == p.config + 0x48:
                p.current = replace(PROCESS, created=1)
        p.hook = mutate
        with self.assertRaisesRegex(ReadError, 'PROCESS_IDENTITY_CHANGED'):
            observe(p, anchor_rva=p.anchor)
        self.assertTrue(p.closed)

    def test_replaced_main_window_object_with_same_counts_is_rejected(self):
        p = source()
        replacement, private = 0x40000, 0x41000
        p.pack(replacement, '<Q', BASE + 0x2280)
        p.pack(replacement + 8, '<Q', private)
        p.pack(replacement + 0x28, '<Q', private + 0x120)
        p.pack(private + 8, '<Q', replacement)
        p.pack(private + 0x120, '<Q', p.hwnd)
        p.pack(private + 0x130, '<I', 0)
        def mutate(at, size):
            if at == p.config + 0x48:
                p.pack(p.node + 24, '<Q', replacement)
        p.hook = mutate
        with self.assertRaisesRegex(ReadError, 'JOINT_WINDOW_STATE_CHANGED'):
            observe(p, anchor_rva=p.anchor)
        self.assertTrue(p.closed)

    def test_global_budget_covers_both_windows_and_account_confirmation(self):
        p = source()
        result = observe(p, anchor_rva=p.anchor)
        with self.assertRaises(ReadError):
            observe(anchor_rva=p.anchor, max_bytes=result.bytes_read - 1)
        self.assertEqual(observe(anchor_rva=p.anchor, max_bytes=result.bytes_read).bytes_read, result.bytes_read)

    def test_invalid_consent_profile_anchor_and_budget_never_open_handle(self):
        factory = Mock()
        for options in (dict(approve_joint_read=False), dict(accept_os_memory_limit=False),
                        dict(max_bytes=268435457), dict(max_seconds=float('nan')),
                        dict(anchor_rva=1), dict(expected_sha256='b' * 64)):
            with self.subTest(options=options), self.assertRaises(ReadError):
                observe(process_factory=factory, **options)
        factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
