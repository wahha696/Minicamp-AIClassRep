"""Explicit finite runtime experiment. No persistent cursor/crash recovery."""
import json

from acquisition import CipherProfile, Consent
from canary import CaptureSession, MarkerReceipt, parser, selected_metadata
from reader import ReadError, Scope
from runtime import ControlFile, SelfMetrics, run_experiment, validate_runtime
from textdecode import ZstdDecoder


def main(argv=None):
    p = parser()
    p.add_argument("--control-file", required=True)
    p.add_argument("--metrics-seconds", type=float, required=True)
    p.add_argument("--approve-extended-window", action="store_true")
    p.add_argument("--approve-pause-gap-read", action="store_true", required=True)
    args = p.parse_args(argv)
    validate_runtime(args.window_seconds, args.poll_seconds, args.metrics_seconds,
        extended_approved=args.approve_extended_window, gap_approved=args.approve_pause_gap_read)
    control = ControlFile(args.control_file)
    if control() is not None:  # Never consume and ignore a startup command.
        raise ReadError("CONTROL_START_STATE_INVALID")
    text_options = (args.zstd_library, args.text_input_bytes, args.text_output_bytes, args.text_window_log)
    if any(v is not None for v in text_options) and not all(v is not None for v in text_options):
        raise ReadError("EXPLICIT_ZSTD_LIBRARY_AND_BUDGETS_REQUIRED")
    zstd = (ZstdDecoder(args.zstd_library, max_input_bytes=args.text_input_bytes,
        max_output_bytes=args.text_output_bytes, max_window_log=args.text_window_log)
        if args.zstd_library is not None else None)
    receipt = MarkerReceipt(args.marker, zstd=zstd)
    with open(args.metadata, "r", encoding="utf-8-sig") as source:
        metadata = json.load(source)
    root, selected, expected = selected_metadata(metadata, args.account)
    scope = Scope(args.account, (args.group,))
    consent = Consent(args.account, args.approve_key_read, args.approve_encrypted_db_read,
                      args.accept_os_memory_limit)
    profile = CipherProfile(args.version, args.approve_experimental_profile)
    def factory(*, remaining_seconds=None):
        return CaptureSession(scope, consent, expected, profile, root=root,
            selected_databases=selected, vfs_profile=args.vfs_profile,
            scan_bytes=args.scan_bytes, scan_seconds=(args.scan_seconds if remaining_seconds is None
                else min(args.scan_seconds, remaining_seconds)),
            snapshot_bytes=args.snapshot_bytes, snapshot_seconds=args.snapshot_seconds)
    result = run_experiment(scope, factory, receipt, window_seconds=args.window_seconds,
        poll_seconds=args.poll_seconds, metrics_seconds=args.metrics_seconds,
        extended_approved=args.approve_extended_window, gap_approved=args.approve_pause_gap_read,
        commands=control, metrics=SelfMetrics(), diagnostics=args.diagnostics,
        emit=lambda item: print(json.dumps(item), flush=True))
    return 0 if result["marker_count"] else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(json.dumps({"stage": "stopped", "reason": "USER_INTERRUPTED"}), flush=True)
        raise SystemExit(130)
    except ReadError as error:
        print(json.dumps({"stage": "stopped", "reason": str(error)}), flush=True)
        raise SystemExit(2)
    except Exception:
        print(json.dumps({"stage": "stopped", "reason": "UNEXPECTED_RUNTIME_FAILURE"}), flush=True)
        raise SystemExit(2)
