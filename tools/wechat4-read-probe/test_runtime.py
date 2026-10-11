"""Artificial snapshots, fake elapsed time; native metrics inspect only self."""
import ctypes as C
import io
import json
import os
import sys
import unittest
from unittest.mock import patch

from canary import CaptureSession, MarkerReceipt, PollResult, baseline_reader
from reader import ReadError, Scope
from runtime import ControlFile, SelfMetrics, run_experiment, validate_runtime
from runtime_probe import main
from test_reader import ACCOUNT, GROUP_A, GROUP_B, image, shard

MARKER = "CLASSREP_TEST_SYNTHETIC"


class Clock:
    now = 0.0
    def __call__(self):
        return self.now
    def sleep(self, seconds):
        self.now += seconds


class Metrics:
    def sample(self):
        return {"cpu_seconds": 0.1, "working_set_bytes": 4096, "private_bytes": 4096,
                "peak_working_set_bytes": 8192, "handles": 2}


class RuntimeTests(unittest.TestCase):
    def run_case(self, *, sequence=(), window=8, fail=None, emit=None, **changes):
        clock, sessions, outputs = Clock(), [], []
        def factory(*, remaining_seconds=None):
            class Session:
                closed, calls = False, 0
                index = len(sessions)
                def __enter__(self):
                    if fail == "resume" and self.index == 1:
                        raise ReadError("PROCESS_IDENTITY_CHANGED")
                    if fail == "resume_deadline" and self.index == 1:
                        clock.sleep(100)
                    return self
                def capture(self):
                    if self.closed:
                        raise AssertionError("closed session captured")
                    self.calls += 1
                    clock.sleep(0.01)
                    if self.calls > 1 and fail == "capture":
                        raise ReadError("SNAPSHOT_LOCK_BUSY")
                    if self.calls > 1 and fail == "interrupt":
                        raise KeyboardInterrupt()
                    rows = [(1, 1, 1001, "historical private text")]
                    if self.calls > 1 or self.index:
                        rows.append((2, 2, 1002, MARKER))
                    if self.index:
                        rows.append((3, 3, 1003, MARKER))  # Arrived during pause.
                    return (shard(image({GROUP_A: rows, GROUP_B: [(1, 1, 2000, "private other group")]})),)
                def close(self):
                    self.closed = True
                def poll(self, reader, sink, *, limit, deadline):
                    before = clock()
                    shards = self.capture()
                    captured = clock() - before
                    if clock() >= deadline:
                        return PollResult((),False,captured,0,decoded=True,expired=True)
                    batch = reader.deliver(shards,sink,limit=limit)
                    return PollResult(batch,False,captured,0,decoded=True)
            session = Session()
            session.remaining_seconds = remaining_seconds
            sessions.append(session)
            return session
        commands = list(sequence)
        def control():
            if commands and clock.now >= commands[0][0]:
                return commands.pop(0)[1]
        baselines = []
        def baseline(scope, shards):
            baselines.append(clock.now)
            return baseline_reader(scope, shards)
        self.sessions, self.outputs, self.baselines = sessions, outputs, baselines
        options = dict(window_seconds=window, poll_seconds=1, metrics_seconds=2,
            extended_approved=False, gap_approved=True, commands=control, metrics=Metrics(),
            emit=outputs.append if emit is None else emit, clock=clock, sleep=clock.sleep,
            epoch=lambda: 1700000000, make_baseline=baseline)
        options.update(changes)
        result = run_experiment(Scope(ACCOUNT,(GROUP_A,)), factory, MarkerReceipt(MARKER), **options)
        return result

    def test_pause_resume_reuses_baseline_and_reads_gap_once(self):
        result = self.run_case(sequence=((1,"pause"),(3,"resume"),(5,"stop")))
        self.assertEqual(1, len(self.baselines))
        self.assertEqual(2, len(self.sessions))
        self.assertTrue(all(s.closed for s in self.sessions))
        self.assertLess(self.sessions[1].remaining_seconds, 8)
        self.assertEqual(2, result["marker_count"])
        self.assertEqual(2, result["events_examined"])
        self.assertEqual(1, result["runtime_stats"]["resume_count"])
        self.assertGreaterEqual(result["runtime_stats"]["paused_seconds"], 2)
        self.assertFalse(result["progress_persisted"])
        serialized = json.dumps(self.outputs)
        for secret in (MARKER, "historical private text", "private other group", ACCOUNT, GROUP_A, GROUP_B):
            self.assertNotIn(secret, serialized)

    def test_stop_or_expiry_while_paused_never_reopens_capture(self):
        for sequence in (((1,"pause"),(4,"stop")), ((1,"pause"),)):
            result = self.run_case(sequence=sequence)
            self.assertEqual(1,len(self.sessions))
            self.assertEqual(2,self.sessions[0].calls)  # Baseline + initial poll.
            self.assertTrue(self.sessions[0].closed)
            self.assertTrue(result["capture_component_closed"])

    def test_duplicate_pause_resume_are_idempotent_and_cannot_extend_deadline(self):
        result = self.run_case(sequence=((1,"pause"),(2,"pause"),(3,"resume"),(4,"resume")))
        self.assertEqual(2,len(self.sessions))
        self.assertEqual("WINDOW_EXPIRED",result["reason"])
        self.assertEqual(1,result["runtime_stats"]["resume_count"])

    def test_failed_resume_cleans_both_components_and_never_rebaselines(self):
        with self.assertRaisesRegex(ReadError,"PROCESS_IDENTITY_CHANGED"):
            self.run_case(sequence=((1,"pause"),(3,"resume")),fail="resume")
        self.assertTrue(all(s.closed for s in self.sessions))
        self.assertEqual(1,len(self.baselines))
        self.assertNotIn("stopped",[o["stage"] for o in self.outputs])

    def test_capture_error_and_keyboard_interrupt_close_active_component(self):
        for fail, expected in (("capture",ReadError),("interrupt",KeyboardInterrupt)):
            with self.assertRaises(expected):
                self.run_case(fail=fail)
            self.assertTrue(self.sessions[0].closed)

    def test_emitter_failure_also_closes_active_component(self):
        def emit(item):
            if item["stage"] == "baseline_ready":
                raise RuntimeError("synthetic output failure")
        with self.assertRaises(RuntimeError):
            self.run_case(emit=emit)
        self.assertTrue(self.sessions[0].closed)

    def test_resume_scan_crossing_deadline_cannot_query_new_bodies(self):
        result = self.run_case(sequence=((1,"pause"),(3,"resume")),fail="resume_deadline")
        self.assertEqual(1,result["marker_count"])
        self.assertEqual(0,self.sessions[1].calls)
        self.assertTrue(self.sessions[1].closed)

    def test_invalid_runtime_budget_or_approval_never_opens_component(self):
        for changes in ({"window_seconds":600},{"gap_approved":False},
                        {"window_seconds":float("nan")},{"metrics_seconds":float("inf")},
                        {"poll_seconds":True},{"window_seconds":1801}):
            with self.assertRaises(ReadError):
                self.run_case(**changes)
            self.assertEqual([],self.sessions)
        validate_runtime(600,3,30,extended_approved=True,gap_approved=True)

    def test_failed_close_retains_handle_owner_for_retry(self):
        class Process:
            attempts = 0
            def close(self):
                self.attempts += 1
                if self.attempts == 1:
                    raise ReadError("PROCESS_CLOSE_FAILED")
        session = CaptureSession.__new__(CaptureSession)
        process = session._process = Process()
        session._candidates,session._snapshotter = frozenset({b"synthetic key"}),object()
        with self.assertRaisesRegex(ReadError,"PROCESS_CLOSE_FAILED"):
            session.close()
        self.assertIs(process,session._process)
        self.assertEqual(frozenset(),session._candidates)
        session.close()
        self.assertIsNone(session._process)


class ControlTests(unittest.TestCase):
    def read(self, control, document):
        raw = document if isinstance(document,bytes) else json.dumps(document).encode()
        with patch("builtins.open",return_value=io.BytesIO(raw)):
            return control()

    def test_control_sequences_reject_reuse_and_reverse(self):
        control = ControlFile(os.path.abspath("synthetic-control.json"))
        self.assertIsNone(self.read(control,{"sequence":0,"command":"none"}))
        self.assertEqual("pause",self.read(control,{"sequence":1,"command":"pause"}))
        self.assertIsNone(self.read(control,{"sequence":1,"command":"pause"}))
        for document in ({"sequence":1,"command":"resume"},{"sequence":0,"command":"none"}):
            with self.assertRaisesRegex(ReadError,"CONTROL_SEQUENCE_REVERSED_OR_REUSED"):
                self.read(control,document)

    def test_control_unknown_oversized_or_malformed_is_not_executed_or_logged(self):
        for document in (b"private malformed",b"x"*1025,{"sequence":True,"command":"pause"},
                         {"sequence":1,"command":"shell private"},
                         {"sequence":1,"command":"stop","private":"body"}):
            with self.assertRaisesRegex(ReadError,"^CONTROL_DOCUMENT_INVALID$"):
                self.read(ControlFile(os.path.abspath("synthetic-control.json")),document)

    def test_extended_cli_without_approval_does_not_read_control_or_metadata(self):
        args = ["--metadata","unused","--account",ACCOUNT,"--group",GROUP_A,
                "--marker",MARKER,"--version","4.1.15.50","--vfs-profile","unused",
                "--approve-key-read","--approve-encrypted-db-read","--accept-os-memory-limit",
                "--approve-experimental-profile","--approve-new-texts-since-baseline",
                "--scan-bytes","100","--scan-seconds","1","--snapshot-bytes","100",
                "--snapshot-seconds","1","--window-seconds","600","--poll-seconds","3",
                "--control-file",os.path.abspath("unused.json"),"--metrics-seconds","30",
                "--approve-pause-gap-read"]
        with patch("builtins.open") as opened,patch("runtime_probe.CaptureSession") as process:
            with self.assertRaisesRegex(ReadError,"EXTENDED_WINDOW_APPROVAL_REQUIRED"):
                main(args)
            opened.assert_not_called()
            process.assert_not_called()

    @unittest.skipUnless(sys.platform == "win32" and C.sizeof(C.c_void_p) == 8,
                         "Windows x64 self metrics")
    def test_native_metrics_reads_only_self_metadata(self):
        metrics = SelfMetrics()
        with patch.object(metrics._api,"ReadProcessMemory",side_effect=AssertionError("no memory read")), \
             patch.object(metrics._api,"OpenProcess",side_effect=AssertionError("no target process")):
            first,second = metrics.sample(),metrics.sample()
        self.assertGreaterEqual(second["cpu_seconds"],first["cpu_seconds"])
        self.assertGreater(second["working_set_bytes"],0)
        self.assertGreaterEqual(second["peak_working_set_bytes"],second["working_set_bytes"])
        self.assertGreater(second["handles"],0)


if __name__ == "__main__":
    unittest.main()
