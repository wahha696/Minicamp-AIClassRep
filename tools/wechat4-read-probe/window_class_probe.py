"""Explicit one-shot window-class diagnostic with a bounded worker lifetime."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

from native import ProcessIdentity
from reader import ReadError
from window_observation import WindowObservation, observe_windows


def worker(args):
    with open(args.metadata, "r", encoding="utf-8-sig") as source:
        raw = source.read(16385)
    if len(raw.encode("utf-8")) > 16384:
        raise ReadError("WINDOW_METADATA_SIZE_INVALID")
    metadata = json.loads(raw)
    if not isinstance(metadata, dict) or set(metadata) != {"process"}:
        raise ReadError("WINDOW_METADATA_FORMAT_INVALID")
    result = observe_windows(expected_process=ProcessIdentity(**metadata["process"]),
        approve_window_classes=args.approve_window_classes, max_windows=args.max_windows, max_seconds=5)
    print(json.dumps({"stage": "window_class_observed", "evidence": result.evidence, **asdict(result)}), flush=True)
    return 0


def main(argv=None, *, run=subprocess.run):
    parser = argparse.ArgumentParser(description="Root class names only; NOT login proof.")
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--max-windows", type=int, required=True)
    parser.add_argument("--approve-window-classes", action="store_true", required=True)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not 1 <= args.max_windows <= 32:
        raise ReadError("EXPLICIT_WINDOW_BUDGET_REQUIRED")
    if args.worker:
        return worker(args)
    # A hung provider must not block the orchestrator indefinitely. No shell,
    # hidden worker on Windows, no inherited console/UI, no stdout/stderr file.
    command = [sys.executable, "-B", str(Path(__file__).resolve()), "--worker", "--metadata", args.metadata,
               "--max-windows", str(args.max_windows), "--approve-window-classes"]
    try:
        result = run(command, capture_output=True, text=True, encoding="utf-8", timeout=8,
                     creationflags=0x08000000 if sys.platform == "win32" else 0, check=False)
    except subprocess.TimeoutExpired:
        print(json.dumps({"stage": "stopped", "reason": "WINDOW_WORKER_TIMEOUT", "login_verified": False}), flush=True)
        return 2
    try:
        if len(result.stdout) > 2048:
            raise ValueError()
        output = json.loads(result.stdout)
        if result.returncode or not isinstance(output, dict) or output.get("login_verified") is not False:
            raise ValueError()
        if (set(output) != {"stage", "evidence", "main_roots", "login_roots", "unknown_roots", "target_windows", "login_verified"}
                or output["stage"] != "window_class_observed"
                or output["evidence"] not in ("main_class_observed", "login_class_observed", "unknown")
                or any(type(output[key]) is not int or not 0 <= output[key] <= args.max_windows
                       for key in ("main_roots", "login_roots", "unknown_roots", "target_windows"))
                or output["main_roots"] + output["login_roots"] + output["unknown_roots"] != output["target_windows"]):
            raise ValueError()
        expected = WindowObservation(output["main_roots"], output["login_roots"],
                                     output["unknown_roots"], output["target_windows"])
        if output["evidence"] != expected.evidence:
            raise ValueError()
    except (ValueError, TypeError):
        print(json.dumps({"stage": "stopped", "reason": "WINDOW_WORKER_FAILED", "login_verified": False}), flush=True)
        return 2
    print(json.dumps(output), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(json.dumps({"stage": "stopped", "reason": "USER_INTERRUPTED", "login_verified": False}), flush=True)
        raise SystemExit(130)
    except Exception:
        print(json.dumps({"stage": "stopped", "reason": "WINDOW_OBSERVATION_FAILED", "login_verified": False}), flush=True)
        raise SystemExit(2)
