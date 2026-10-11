"""Explicit, one-shot diagnostic. Never authenticates or starts a collector."""
from __future__ import annotations

import argparse
import json
import math

from account_candidate import AccountProfile, observe_account
from native import ModuleIdentity, NativeProcess, ProcessIdentity
from reader import ReadError


def main(argv=None, *, process_factory=NativeProcess):
    parser = argparse.ArgumentParser(description="Observe a runtime account candidate; NOT login proof.")
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--max-read-bytes", type=int, required=True)
    parser.add_argument("--max-read-seconds", type=float, required=True)
    for flag in ("approve-runtime-account-read", "accept-os-memory-limit", "approve-experimental-layout"):
        parser.add_argument("--" + flag, action="store_true", required=True)
    args = parser.parse_args(argv)
    if (not 0 < args.max_read_bytes <= 256 * 1024 * 1024
            or not math.isfinite(args.max_read_seconds) or not 0 < args.max_read_seconds <= 15):
        raise ReadError("EXPLICIT_ACCOUNT_OBSERVATION_BUDGET_REQUIRED")
    with open(args.metadata, "r", encoding="utf-8-sig") as source:
        raw = source.read(16385)
    if len(raw.encode("utf-8")) > 16384:
        raise ReadError("ACCOUNT_METADATA_SIZE_INVALID")
    metadata = json.loads(raw)
    if (not isinstance(metadata, dict) or set(metadata) != {"process", "module", "expected_account"}
            or not isinstance(metadata["expected_account"], str) or not metadata["expected_account"]):
        raise ReadError("ACCOUNT_METADATA_FORMAT_INVALID")
    observation = observe_account(expected_process=ProcessIdentity(**metadata["process"]),
        expected_module=ModuleIdentity(**metadata["module"]), profile=AccountProfile(args.version, True),
        approve_runtime_account_read=args.approve_runtime_account_read,
        accept_os_memory_limit=args.accept_os_memory_limit,
        max_bytes=args.max_read_bytes, max_seconds=args.max_read_seconds, process_factory=process_factory)
    matched = observation.account_id == metadata["expected_account"]
    print(json.dumps({"stage": "account_candidate_observed", "candidate_present": observation.account_id is not None,
        "expected_account_matched": matched, "login_verified": False, "read_bytes": observation.read_bytes}), flush=True)
    return 0 if matched else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(json.dumps({"stage": "stopped", "reason": "USER_INTERRUPTED", "login_verified": False}), flush=True)
        raise SystemExit(130)
    except ReadError as error:
        print(json.dumps({"stage": "stopped", "reason": str(error), "login_verified": False}), flush=True)
        raise SystemExit(2)
    except Exception:
        print(json.dumps({"stage": "stopped", "reason": "ACCOUNT_OBSERVATION_FAILED", "login_verified": False}), flush=True)
        raise SystemExit(2)
