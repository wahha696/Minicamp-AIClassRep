import ctypes as C
from dataclasses import replace
import unittest
from unittest.mock import Mock

from identity_discovery import candidate_pids, discover_target, KNOWN_PROFILES
from native import ProcessEntry
from reader import ReadError
from test_managed_windows import PROCESS, MODULE


class Api:
    def __init__(self, names):
        self.names, self.closed, self.at = names, [], -1
        self.error = 18
    def CreateToolhelp32Snapshot(self, flags, pid):
        assert (flags, pid) == (2, 0)
        return 123
    def fill(self, entry):
        self.at += 1
        if self.at >= len(self.names):
            return False
        record = entry._obj
        assert record.size == C.sizeof(ProcessEntry)
        record.pid, record.executable = self.names[self.at]
        return True
    def Process32FirstW(self, handle, entry):
        return self.fill(entry)
    def Process32NextW(self, handle, entry):
        return self.fill(entry)
    def CloseHandle(self, handle):
        self.closed.append(handle)
        return True


def names(api, **options):
    return candidate_pids(api_factory=lambda: api, error=lambda: api.error, **options)


class EnumerationTests(unittest.TestCase):
    def test_filters_other_names_without_opening_any_process(self):
        api = Api([(1, 'private-other.exe'), (5, 'Weixin.exe'), (3, 'WeChat.exe'), (8, 'WeixinRenderer.exe')])
        self.assertEqual(names(api), (3, 5))
        self.assertEqual(api.closed, [123])
    def test_budget_or_enumeration_errors_close_snapshot(self):
        for maximum, code in ((1, 18), (8192, 5)):
            api = Api([(1, 'other.exe'), (5, 'Weixin.exe')]); api.error = code
            with self.subTest(maximum=maximum), self.assertRaises(ReadError):
                names(api, max_entries=maximum)
            self.assertEqual(api.closed, [123])
    def test_duplicate_pid_and_candidate_limit_do_not_return_partial_result(self):
        for entries, maximum in (([(1, 'Weixin.exe'), (1, 'Weixin.exe')], 32),
                ([(1, 'Weixin.exe'), (2, 'Weixin.exe')], 1)):
            api = Api(entries)
            with self.assertRaises(ReadError):
                names(api, max_candidates=maximum)
            self.assertEqual(api.closed, [123])
    def test_invalid_budgets_do_not_open_snapshot(self):
        api = Mock()
        for changes in (dict(max_entries=0), dict(max_candidates=True), dict(max_seconds=float('nan'))):
            with self.assertRaises(ReadError):
                candidate_pids(api_factory=api, **changes)
        api.assert_not_called()
    def test_time_limit_closes_snapshot(self):
        api = Api([(1, 'Weixin.exe')])
        times = iter([0, 0, 0, 6])
        with self.assertRaisesRegex(ReadError, 'TIME_EXCEEDED'):
            names(api, clock=lambda: next(times))
        self.assertEqual(api.closed, [123])


class Query:
    def __init__(self, pid, core=True):
        self.current = replace(PROCESS, pid=pid)
        self.core, self.closed = core, 0
    def identity(self):
        return self.current
    def module(self, path):
        if not self.core:
            raise ReadError('EXPLICIT_MODULE_MISSING')
        return replace(MODULE, path=path)
    def __enter__(self):
        return self
    def __exit__(self, *_):
        self.closed += 1


class DiscoveryTests(unittest.TestCase):
    def test_unique_core_is_rechecked_and_helpers_never_supply_an_account(self):
        processes = {1: Query(1), 2: Query(2, False)}
        enum = Mock(return_value=(1, 2))
        result = discover_target(enumerate_candidates=enum, query_factory=lambda pid: processes[pid])
        self.assertEqual(result.state, 'found')
        self.assertEqual(result.process.pid, 1)
        self.assertEqual(result.sha256, KNOWN_PROFILES['4.1.15.50'])
        self.assertEqual([p.closed for p in processes.values()], [2, 1])
        self.assertNotIn('synthetic', repr(result))
    def test_no_candidate_never_queries_a_process(self):
        query = Mock()
        result = discover_target(enumerate_candidates=lambda **_: (), query_factory=query)
        self.assertEqual(result.state, 'not_running'); query.assert_not_called()
    def test_multiple_cores_and_unsupported_versions_do_not_pick_first(self):
        result = discover_target(enumerate_candidates=lambda **_: (1, 2), query_factory=lambda pid: Query(pid))
        self.assertEqual(result.state, 'ambiguous'); self.assertIsNone(result.process)
        p = Query(1); p.current = replace(p.current, version='4.2.0.1')
        result = discover_target(enumerate_candidates=lambda **_: (1,), query_factory=lambda _: p)
        self.assertEqual(result.state, 'unsupported'); self.assertIsNone(result.process)
    def test_inaccessible_or_ambiguous_module_is_not_treated_as_a_helper(self):
        for error in ('EXPLICIT_MODULE_AMBIGUOUS', 'PROCESS_MODULE_METADATA_FAILED'):
            p = Query(1); p.module = Mock(side_effect=ReadError(error))
            with self.assertRaises(ReadError):
                discover_target(enumerate_candidates=lambda **_: (1,), query_factory=lambda _: p)
            self.assertEqual(p.closed, 1)
    def test_candidate_change_stops_and_closes_every_opened_handle(self):
        p = Query(1)
        with self.assertRaisesRegex(ReadError, 'CANDIDATES_CHANGED'):
            discover_target(enumerate_candidates=Mock(side_effect=[(1,), (1, 2)]), query_factory=lambda _: p)
        self.assertEqual(p.closed, 1)
    def test_final_identity_recheck_prevents_pid_reuse(self):
        p = Query(1); calls = 0
        def identity():
            nonlocal calls
            calls += 1
            return p.current if calls <= 2 else replace(p.current, created=1)
        p.identity = identity
        with self.assertRaisesRegex(ReadError, 'PROCESS_CHANGED'):
            discover_target(enumerate_candidates=lambda **_: (1,), query_factory=lambda _: p)
        self.assertEqual(p.closed, 2)
    def test_invalid_budget_or_pid_list_never_opens_process(self):
        query = Mock()
        for pids in ((True,), (1, 1), (0,), list(range(2))):
            with self.assertRaises(ReadError):
                discover_target(enumerate_candidates=lambda **_: pids, query_factory=query)
        with self.assertRaises(ReadError):
            discover_target(query_factory=query, max_seconds=11)
        query.assert_not_called()


if __name__ == '__main__':
    unittest.main()
