"""Synthetic identities/SQLite only; no real WeChat or native process reads."""
import unittest
from unittest.mock import Mock

from identity_bound_capture import IdentityBoundCapture
from identity_snapshot import observe_identity_snapshot
from reader import ReadError, Scope
from test_identity_snapshot import source
from test_managed_windows import PROCESS, MODULE, SHA, BASE, Windows


class Session:
    def __init__(self, scope):
        self.scope, self.expected = scope, PROCESS
        self.entered, self.closed, self.captures = False, False, 0
        self.open_hook, self.capture_hook = lambda: None, lambda: None
        self.result = ('synthetic-memory-only-capture',)

    def __enter__(self):
        self.entered = True
        self.open_hook()
        return self

    def capture(self):
        self.captures += 1
        self.capture_hook()
        return self.result

    def close(self):
        self.closed = True


def setup(**changes):
    p = source()
    scope = Scope('wxid_synthetic_account', ('synthetic@chatroom',))
    session = Session(scope)
    observer = Mock(side_effect=lambda **options: observe_identity_snapshot(**options,
        process_factory=lambda _: p, windows_factory=Windows))
    factory = Mock(return_value=session)
    args = dict(scope=scope, expected_process=PROCESS, expected_module=MODULE,
        report=p.report, expected_sha256=SHA, session_factory=factory,
        approve_joint_read=True, accept_os_memory_limit=True, observe=observer)
    args.update(changes)
    return IdentityBoundCapture(**args), p, session, observer, factory


class BoundCaptureTests(unittest.TestCase):
    def test_checks_before_key_read_and_before_and_after_every_capture(self):
        guard, p, session, observer, factory = setup()
        session.open_hook = lambda: self.assertEqual(observer.call_count, 1)
        session.capture_hook = lambda: self.assertEqual(observer.call_count, 3)
        with guard:
            self.assertIs(guard.capture(), session.result)
            self.assertEqual(observer.call_count, 4)
            self.assertEqual(observer.call_args_list[0].kwargs['max_bytes'], 268435456)
            self.assertTrue(all(call.kwargs['max_bytes'] == 1048576 for call in observer.call_args_list[1:]))
            self.assertTrue(all(call.kwargs['anchor_rva'] == p.anchor for call in observer.call_args_list[1:]))
        self.assertTrue(session.closed)
        self.assertIsNone(guard._anchor)
        self.assertNotIn('wxid_', repr(guard))

    def test_logged_out_or_other_account_never_opens_capture(self):
        for table in (BASE + 0x2600, BASE + 0x2700, None):
            guard, p, session, observer, factory = setup()
            if table:
                p.pack(p.widget, '<Q', table)
            else:
                p.put(p.text, b'wxid_synthetic_changed')
            with self.subTest(table=table), self.assertRaises(ReadError):
                guard.__enter__()
            factory.assert_not_called()
            self.assertFalse(session.entered)

    def test_account_switch_during_key_scan_closes_and_never_captures(self):
        guard, p, session, observer, factory = setup()
        session.open_hook = lambda: p.put(p.text, b'wxid_synthetic_changed')
        with self.assertRaisesRegex(ReadError, 'IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT'):
            guard.__enter__()
        self.assertTrue(session.closed)
        self.assertEqual(session.captures, 0)

    def test_account_switch_or_logout_during_capture_discards_result(self):
        for logout in (False, True):
            guard, p, session, observer, factory = setup()
            session.capture_hook = (lambda: p.pack(p.widget, '<Q', BASE + 0x2600)) if logout else (
                lambda: p.put(p.text, b'wxid_synthetic_changed'))
            with guard:
                with self.assertRaisesRegex(ReadError, 'IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT'):
                    guard.capture()
                self.assertTrue(session.closed)
                self.assertIsNone(guard._anchor)
                with self.assertRaises(ReadError):
                    guard.capture()
                self.assertEqual(session.captures, 1)

    def test_unknown_or_failed_identity_before_capture_stops_without_database_read(self):
        for state in ('unknown', 'process_changed'):
            guard, p, session, observer, factory = setup()
            with guard:
                if state == 'unknown':
                    p.pack(p.widget, '<Q', BASE + 0x2700)
                else:
                    observer.side_effect = ReadError('PROCESS_IDENTITY_CHANGED')
                with self.subTest(state=state), self.assertRaises(ReadError):
                    guard.capture()
                self.assertTrue(session.closed)
                self.assertEqual(session.captures, 0)

    def test_capture_exception_closes_and_is_not_an_empty_success(self):
        guard, p, session, observer, factory = setup()
        session.capture = Mock(side_effect=ReadError('SYNTHETIC_CAPTURE_FAILED'))
        with guard, self.assertRaisesRegex(ReadError, 'SYNTHETIC_CAPTURE_FAILED'):
            guard.capture()
        self.assertTrue(session.closed)

    def test_mismatched_session_scope_or_process_is_closed_before_key_scan(self):
        for mismatch in ('scope', 'process'):
            guard, p, session, observer, factory = setup()
            if mismatch == 'scope':
                session.scope = Scope('wxid_other', ('synthetic@chatroom',))
            else:
                session.expected = None
            with self.subTest(mismatch=mismatch), self.assertRaises(ReadError):
                guard.__enter__()
            self.assertTrue(session.closed)
            self.assertFalse(session.entered)

    def test_failed_close_keeps_owner_and_can_retry_without_reopening(self):
        guard, p, session, observer, factory = setup()
        guard.__enter__()
        session.close = Mock(side_effect=[ReadError('SYNTHETIC_CLOSE_FAILED'), None])
        with self.assertRaisesRegex(ReadError, 'SYNTHETIC_CLOSE_FAILED'):
            guard.close()
        self.assertIs(guard._session, session)
        with self.assertRaises(ReadError):
            guard.capture()
        guard.close()
        self.assertIsNone(guard._session)
        self.assertEqual(session.close.call_count, 2)

    def test_closed_session_cannot_reopen_or_use_old_location(self):
        guard, p, session, observer, factory = setup()
        with guard:
            pass
        calls = observer.call_count
        for operation in (guard.__enter__, guard.capture):
            with self.assertRaises(ReadError):
                operation()
        self.assertEqual(observer.call_count, calls)
        self.assertIsNone(guard._anchor)

    def test_precommit_revalidation_reads_current_account_and_closes_on_change(self):
        guard, p, session, observer, factory = setup()
        with guard:
            before = observer.call_count
            guard.revalidate()
            self.assertEqual(observer.call_count, before + 1)
            p.put(p.text, b'wxid_synthetic_changed')
            with self.assertRaisesRegex(ReadError, 'IDENTITY_CAPTURE_ACCOUNT_NOT_CURRENT'):
                guard.revalidate()
            self.assertTrue(session.closed)
            with self.assertRaisesRegex(ReadError, 'SESSION_NOT_OPEN'):
                guard.revalidate()

    def test_invalid_consent_or_profile_opens_nothing(self):
        for changes in (dict(approve_joint_read=False), dict(accept_os_memory_limit=False),
                        dict(expected_sha256='b' * 64), dict(scope=None)):
            with self.subTest(changes=changes), self.assertRaises(ReadError):
                setup(**changes)

    def test_real_memory_capture_session_composes_without_disk_or_native_process_access(self):
        import test_canary as fixtures
        from canary import CaptureSession
        from acquisition import CipherProfile, Consent
        from snapshot import Snapshotter
        guard, p, _, observer, factory = setup(scope=Scope(fixtures.ACCOUNT, (fixtures.GROUP_A,)))
        # Use the real bounded identity observer against synthetic account bytes.
        account = fixtures.ACCOUNT.encode('ascii')
        p.put(p.text, account)
        p.pack(p.config + 0x48, '<QQQQ', p.text, 0, len(account), 255)
        process, files = fixtures.CanaryTests().fixtures()
        process._identity = PROCESS
        session = CaptureSession(guard.scope, Consent(fixtures.ACCOUNT, True, True, True), PROCESS,
            CipherProfile(PROCESS.version, True), root=fixtures.ROOT,
            selected_databases={'shard_A': (fixtures.RELATIVE, files.identities[''])},
            vfs_profile=fixtures.SQLITE_WINDOWS_PROFILE, scan_bytes=20000, scan_seconds=5,
            snapshot_bytes=fixtures.MAX_BYTES, snapshot_seconds=5, process_factory=lambda _: process,
            snapshotter_factory=lambda **options: Snapshotter(files=files, **options))
        factory.return_value = session
        with guard:
            shards = guard.capture()
            self.assertEqual(len(shards), 1)
            self.assertTrue(shards[0].image.startswith(b'SQLite format 3\0'))
            p.pack(p.widget, '<Q', BASE + 0x2600)
            with self.assertRaises(ReadError):
                guard.capture()
            self.assertTrue(process.closed)
            self.assertFalse(session._candidates)
            self.assertEqual(files.locks, [])


if __name__ == '__main__':
    unittest.main()
