"""Offline installed-program inspection. Never opens a running process."""
from __future__ import annotations

import argparse
import json
import math
import ntpath
import time

from native import NativeFile, executable_version, normal_path
from reader import ReadError
from static_types import analyze_types


def inspect_program(*, path, expected_sha256, expected_version, max_bytes, max_seconds,
                    max_references, max_functions, file_factory=NativeFile,
                    version_reader=executable_version, clock=time.monotonic):
    if (not isinstance(path, str) or normal_path(path) != path or ntpath.basename(path) != "weixin.dll"
            or not isinstance(expected_version, str) or not expected_version):
        raise ReadError("EXPLICIT_STATIC_PROGRAM_REQUIRED")
    if (type(max_bytes) is not int or not 0 < max_bytes <= 256 * 1024 * 1024
            or type(max_seconds) not in (int, float) or not math.isfinite(max_seconds)
            or not 0 < max_seconds <= 30):
        raise ReadError("EXPLICIT_STATIC_PROGRAM_BUDGET_REQUIRED")
    # Reject invalid parser budgets/hash before accessing a file.
    if (not isinstance(expected_sha256, str) or len(expected_sha256) != 64
            or any(char not in "0123456789abcdef" for char in expected_sha256)
            or type(max_references) is not int or not 1 <= max_references <= 500000
            or type(max_functions) is not int or not 1 <= max_functions <= 1000000):
        raise ReadError("EXPLICIT_STATIC_PROFILE_REQUIRED")
    deadline = clock() + max_seconds
    def remaining():
        result = deadline - clock()
        if result <= 0:
            raise ReadError("STATIC_ANALYSIS_TIME_EXCEEDED")
        return result

    remaining()
    with file_factory(path) as source:
        if source.path != path:
            raise ReadError("STATIC_PROGRAM_PATH_CHANGED")
        identity, size = source.identity(), source.size()
        if not 64 <= size <= max_bytes:
            raise ReadError("STATIC_PROGRAM_FILE_BUDGET_EXCEEDED")
        if version_reader(path) != expected_version:
            raise ReadError("STATIC_PROGRAM_VERSION_CHANGED")
        content = bytearray()
        for offset in range(0, size, 1024 * 1024):
            remaining()
            block = source.read(offset, min(1024 * 1024, size - offset))
            if len(block) != min(1024 * 1024, size - offset):
                raise ReadError("STATIC_PROGRAM_SHORT_READ")
            content.extend(block)
        if source.identity() != identity or source.size() != size:
            raise ReadError("STATIC_PROGRAM_FILE_CHANGED")
    # Copies are RAM-only. max_bytes limits input, not total process memory.
    image = bytes(content)
    del content
    report = analyze_types(image, expected_sha256=expected_sha256, max_file_bytes=max_bytes,
        max_image_bytes=max_bytes, max_references=max_references, max_functions=max_functions,
        max_seconds=remaining(), clock=clock)
    remaining()
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Static Qt metadata only; NOT login proof.")
    parser.add_argument("--program-file", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--max-bytes", type=int, required=True)
    parser.add_argument("--max-seconds", type=float, required=True)
    parser.add_argument("--max-references", type=int, required=True)
    parser.add_argument("--max-functions", type=int, required=True)
    args = parser.parse_args(argv)
    report = inspect_program(path=normal_path(args.program_file), expected_sha256=args.sha256,
        expected_version=args.version, max_bytes=args.max_bytes, max_seconds=args.max_seconds,
        max_references=args.max_references, max_functions=args.max_functions)
    # Only fixed class names and static program metadata; no file dump, offsets,
    # runtime account, process-memory content, secret or dynamic-state output.
    print(json.dumps({"stage": "static_types_analyzed", "sha256": report.sha256,
        "file_bytes": report.file_bytes, "image_bytes": report.image_bytes, "login_verified": False,
        "window_mapper_candidates": len(report.window_mapper_candidates),
        "types": [{"class_name": item.class_name, "metadata_candidates": 1,
                   "reference_functions": len(item.reference_function_rvas),
                   "pointer_table_candidates": len(item.pointer_table_candidates),
                   "qt_accessor_candidates": len(item.qt_accessor_candidates),
                   "qt_accessor_table_candidates": sum(len(entry.pointer_table_candidates)
                       for entry in item.qt_accessor_candidates)} for item in report.types]}), flush=True)
    return 0


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
        print(json.dumps({"stage": "stopped", "reason": "STATIC_ANALYSIS_FAILED", "login_verified": False}), flush=True)
        raise SystemExit(2)
