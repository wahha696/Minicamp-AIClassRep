"""Explicit one-shot managed-window diagnostic in a bounded hidden worker."""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import re
import subprocess
import sys

from managed_windows import observe_managed_windows
from native import ModuleIdentity, ProcessIdentity
from reader import ReadError
from static_type_probe import inspect_program


def worker(args):
    with open(args.metadata, "r", encoding="utf-8-sig") as source:
        raw = source.read(16385)
    if len(raw.encode("utf-8")) > 16384:
        raise ReadError("MANAGED_METADATA_SIZE_INVALID")
    metadata = json.loads(raw)
    if type(metadata) is not dict or set(metadata) != {"process", "module", "sha256"}:
        raise ReadError("MANAGED_METADATA_FORMAT_INVALID")
    process, module = ProcessIdentity(**metadata["process"]), ModuleIdentity(**metadata["module"])
    if process.version != "4.1.15.50" or module.version != process.version:
        raise ReadError("MANAGED_EXPERIMENTAL_VERSION_REQUIRED")
    report = inspect_program(path=module.path, expected_sha256=metadata["sha256"], expected_version=module.version,
        max_bytes=256 * 1024 * 1024, max_seconds=30, max_references=500000, max_functions=1000000)
    result = observe_managed_windows(expected_process=process, expected_module=module, report=report,
        expected_sha256=metadata["sha256"], approve_managed_read=args.approve_managed_read,
        max_windows=args.max_windows, max_bytes=args.max_read_bytes, max_nodes=args.max_nodes, max_seconds=5)
    public = asdict(result)
    public.pop("ownership_token")
    print(json.dumps({"stage": "managed_windows_observed", **public}), flush=True)
    return 0


def main(argv=None, *, run=subprocess.run):
    parser = argparse.ArgumentParser(description="Managed window metadata only; NOT login proof.")
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--max-windows", type=int, required=True)
    parser.add_argument("--max-read-bytes", type=int, required=True)
    parser.add_argument("--max-nodes", type=int, required=True)
    parser.add_argument("--approve-managed-read", action="store_true", required=True)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if (not 1 <= args.max_windows <= 32 or not 1 <= args.max_read_bytes <= 1024 * 1024
            or not 1 <= args.max_nodes <= 4096):
        raise ReadError("EXPLICIT_MANAGED_WINDOW_BUDGET_REQUIRED")
    if args.worker:
        return worker(args)
    command = [sys.executable, "-B", str(Path(__file__).resolve()), "--worker", "--metadata", args.metadata,
        "--max-windows", str(args.max_windows), "--max-read-bytes", str(args.max_read_bytes),
        "--max-nodes", str(args.max_nodes), "--approve-managed-read"]
    try:
        result = run(command, capture_output=True, text=True, encoding="utf-8", timeout=40,
                     creationflags=0x08000000 if sys.platform == "win32" else 0, check=False)
    except subprocess.TimeoutExpired:
        print(json.dumps({"stage": "stopped", "reason": "MANAGED_WORKER_TIMEOUT", "login_verified": False}), flush=True)
        return 2
    output = None
    try:
        if len(result.stdout) > 2048:
            raise ValueError()
        candidate = json.loads(result.stdout)
        if type(candidate) is not dict or candidate.get("login_verified") is not False:
            raise ValueError()
        if (result.returncode == 2 and set(candidate) == {"stage", "reason", "login_verified"}
                and candidate["stage"] == "stopped" and type(candidate["reason"]) is str
                and re.fullmatch("[A-Z][A-Z0-9_]{0,95}", candidate["reason"])):
            output = candidate
        elif result.returncode == 0:
            keys = {"main_windows", "login_windows", "unknown_windows", "absent_windows", "target_windows"}
            if (set(candidate) != keys | {"stage", "bytes_read", "nodes_read", "login_verified"}
                    or candidate["stage"] != "managed_windows_observed"
                    or any(type(candidate[k]) is not int or not 0 <= candidate[k] <= args.max_windows for k in keys)
                    or candidate["target_windows"] == 0
                    or sum(candidate[k] for k in keys - {"target_windows"}) != candidate["target_windows"]
                    or type(candidate["bytes_read"]) is not int or not 0 < candidate["bytes_read"] <= args.max_read_bytes
                    or type(candidate["nodes_read"]) is not int or not 0 <= candidate["nodes_read"] <= args.max_nodes):
                raise ValueError()
            output = candidate
    except (ValueError, TypeError):
        pass
    if output is None:
        output = {"stage": "stopped", "reason": "MANAGED_WORKER_FAILED", "login_verified": False}
    print(json.dumps(output), flush=True)
    return 0 if output["stage"] == "managed_windows_observed" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(json.dumps({"stage": "stopped", "reason": "USER_INTERRUPTED", "login_verified": False}), flush=True)
        raise SystemExit(130)
    except ReadError as error:
        reason = str(error)
        if not re.fullmatch("[A-Z][A-Z0-9_]{0,95}", reason):
            reason = "MANAGED_OBSERVATION_FAILED"
        print(json.dumps({"stage": "stopped", "reason": reason, "login_verified": False}), flush=True)
        raise SystemExit(2)
    except Exception:
        print(json.dumps({"stage": "stopped", "reason": "MANAGED_OBSERVATION_FAILED", "login_verified": False}), flush=True)
        raise SystemExit(2)
