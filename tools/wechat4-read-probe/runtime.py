"""Bounded research lifecycle / self metrics, not durable crash recovery.

Pause closes the capture component; cursors/marker receipts stay in this
supervisor's memory. Resume never rebuilds the baseline or changes identity.
No key, plaintext DB, body or cursor persistence. Control file contains only
an explicit sequence number and pause/resume/stop command.
"""
from __future__ import annotations

import ctypes as C
import json
import math
import os
import time

from canary import baseline_reader
from native import DWORD, FileTime, HANDLE, SIZE_T, kernel
from reader import ReadError


class _MemoryCounters(C.Structure):
    _fields_ = [("cb", DWORD), ("faults", DWORD)] + [(name, SIZE_T) for name in (
        "peak_working", "working", "peak_paged", "paged", "peak_nonpaged",
        "nonpaged", "commit", "peak_commit", "private")]


class SelfMetrics:
    """Windows metadata for this Python process only, no target-process input."""
    def __init__(self):
        self._api = kernel()
        for name, args, result in (
            ("GetCurrentProcess", [], HANDLE),
            ("GetProcessHandleCount", [HANDLE, C.POINTER(DWORD)], C.c_int),
            ("K32GetProcessMemoryInfo", [HANDLE, C.POINTER(_MemoryCounters), DWORD], C.c_int)):
            fn = getattr(self._api, name)
            fn.argtypes, fn.restype = args, result
        self._handle = self._api.GetCurrentProcess()  # Pseudo-handle; must not close.

    def sample(self):
        memory, handles = _MemoryCounters(), DWORD()
        memory.cb = C.sizeof(memory)
        created, exited, cpu_kernel, cpu_user = FileTime(), FileTime(), FileTime(), FileTime()
        if (not self._api.K32GetProcessMemoryInfo(self._handle, C.byref(memory), memory.cb)
                or not self._api.GetProcessHandleCount(self._handle, C.byref(handles))
                or not self._api.GetProcessTimes(self._handle, C.byref(created), C.byref(exited),
                                              C.byref(cpu_kernel), C.byref(cpu_user))):
            raise ReadError("SELF_RESOURCE_SAMPLE_FAILED")
        return {"cpu_seconds": (cpu_kernel.ticks + cpu_user.ticks) / 10000000,
                "working_set_bytes": memory.working, "private_bytes": memory.private,
                "peak_working_set_bytes": memory.peak_working, "handles": handles.value}


class ControlFile:
    """Read an explicitly named, tiny control document; never write it."""
    def __init__(self, path):
        if not isinstance(path, str) or not os.path.isabs(path):
            raise ReadError("EXPLICIT_CONTROL_FILE_REQUIRED")
        self._path, self._sequence, self._command = path, -1, None

    def __call__(self):
        try:
            with open(self._path, "rb") as source:
                raw = source.read(1025)
            if len(raw) > 1024:
                raise ReadError("CONTROL_DOCUMENT_INVALID")
            document = json.loads(raw)
        except (OSError, ValueError, UnicodeError):
            raise ReadError("CONTROL_DOCUMENT_INVALID") from None
        if (not isinstance(document, dict) or set(document) != {"sequence", "command"}
                or type(document["sequence"]) is not int or not 0 <= document["sequence"] <= 2147483647
                or document["command"] not in ("none", "pause", "resume", "stop")):
            raise ReadError("CONTROL_DOCUMENT_INVALID")
        sequence, command = document["sequence"], document["command"]
        if sequence < self._sequence or (sequence == self._sequence and self._command not in (None, command)):
            raise ReadError("CONTROL_SEQUENCE_REVERSED_OR_REUSED")
        if sequence == self._sequence:
            self._command = command
            return None
        self._sequence, self._command = sequence, command
        return command if command != "none" else None


def validate_runtime(window_seconds, poll_seconds, metrics_seconds, *, extended_approved, gap_approved):
    if (any(type(v) not in (int, float) or not math.isfinite(v)
            for v in (window_seconds, poll_seconds, metrics_seconds))
            or not 1 <= window_seconds <= 1800 or not 1 <= poll_seconds <= 10
            or not 1 <= metrics_seconds <= 60):
        raise ReadError("EXPLICIT_RUNTIME_BUDGET_REQUIRED")
    if window_seconds > 180 and extended_approved is not True:
        raise ReadError("EXTENDED_WINDOW_APPROVAL_REQUIRED")
    if gap_approved is not True:
        raise ReadError("PAUSE_GAP_READ_APPROVAL_REQUIRED")


def run_experiment(scope, session_factory, receipt, *, window_seconds, poll_seconds,
                   metrics_seconds, extended_approved, gap_approved, commands, metrics,
                   emit, diagnostics=False, clock=time.monotonic, sleep=time.sleep,
                   epoch=time.time, make_baseline=baseline_reader):
    validate_runtime(window_seconds, poll_seconds, metrics_seconds,
                     extended_approved=extended_approved, gap_approved=gap_approved)
    session, reader, paused_at = None, None, None
    started = clock()
    stats = {"capture_count": 0, "capture_seconds_total": 0.0, "capture_seconds_max": 0.0,
             "delivery_seconds_total": 0.0, "resume_count": 0, "paused_seconds": 0.0,
             "resource_samples": 0, "full_decode_count": 1, "unchanged_poll_count": 0}

    def resource(phase):
        values = metrics.sample()
        stats["resource_samples"] += 1
        emit({"stage": "resource_sample", "phase": phase,
              "elapsed_seconds": round(clock() - started, 3), **values})

    def open_session(*, remaining_seconds=None):
        active = session_factory(remaining_seconds=remaining_seconds)
        try:
            active.__enter__()
        except BaseException:
            active.close()
            raise
        return active

    def capture():
        before = clock()
        shards = session.capture()
        elapsed = clock() - before
        stats["capture_count"] += 1
        stats["capture_seconds_total"] += elapsed
        stats["capture_seconds_max"] = max(stats["capture_seconds_max"], elapsed)
        return shards

    resource("startup")
    reason = "WINDOW_EXPIRED"
    try:
        session = open_session()
        shards = capture()
        reader = make_baseline(scope, shards)
        del shards
        deadline = clock() + window_seconds  # Includes pauses / resume scans.
        ready = {"stage": "baseline_ready", "window_seconds": window_seconds,
                 "baseline_epoch_ms": int(epoch() * 1000), "historical_bodies_selected": False,
                 "recovery_mode": "same_supervisor_memory_only"}
        if diagnostics:
            ready["baseline_cursors"] = [{"database": shard, "sort_seq": cursor.sort_seq,
                "local_id": cursor.local_id} for (shard, _group), cursor in reader.cursors.items()]
        emit(ready)
        resource("baseline")
        next_metrics, last_summary = clock() + metrics_seconds, receipt.summary()
        while clock() < deadline:
            command = commands()
            if clock() >= deadline:
                break
            if command == "stop":
                reason = "OPERATOR_STOPPED"
                break
            if command == "pause" and session is not None:
                session.close()
                session = None
                paused_at = clock()
                emit({"stage": "paused", "capture_component_closed": True,
                      "progress_in_memory": True, **receipt.summary()})
                resource("paused")
            elif command == "resume" and session is None:
                session = open_session(remaining_seconds=deadline - clock())
                stats["paused_seconds"] += clock() - paused_at
                paused_at = None
                stats["resume_count"] += 1
                emit({"stage": "resumed", "baseline_reused": True})
                resource("resumed")
            if session is not None and clock() < deadline:
                polled = session.poll(reader, receipt, limit=100, deadline=deadline)
                stats["capture_count"] += 1
                stats["capture_seconds_total"] += polled.capture_seconds
                stats["capture_seconds_max"] = max(stats["capture_seconds_max"], polled.capture_seconds)
                stats["delivery_seconds_total"] += polled.delivery_seconds
                stats["full_decode_count"] += int(polled.decoded)
                stats["unchanged_poll_count"] += int(polled.unchanged)
                if polled.expired:
                    del polled
                    break
                del polled
                summary = receipt.summary()
                if summary != last_summary:
                    emit({"stage": "marker_received" if summary["marker_count"] != last_summary["marker_count"]
                          else "new_messages_examined", **summary})
                    last_summary = summary
            if clock() >= next_metrics:
                resource("active" if session is not None else "paused")
                next_metrics = clock() + metrics_seconds
            sleep(min(poll_seconds, max(0, deadline - clock())))
    finally:
        if session is not None:
            session.close()
    if paused_at is not None:
        stats["paused_seconds"] += clock() - paused_at
    resource("closed")
    result = {"stage": "stopped", "reason": reason, "capture_component_closed": True,
              "keys_or_plaintext_saved": False, "progress_persisted": False,
              **receipt.summary(), "runtime_stats": stats}
    emit(result)
    return result
