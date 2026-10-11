"""Explicit short live experiment. No keys, DB images or message bodies are saved.

This is a research receipt in memory, NOT a durable business ingestion adapter.
Importing this module performs no process/file access.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import ntpath
import re
import time
from dataclasses import dataclass, field

from acquisition import (CipherProfile, Consent, KeyScanner, capture_selected_shards,
                         capture_selected_encrypted, decode_selected_shards,
                         fingerprint_selected_snapshots, validate_scan_budget, validate_target)
from native import FileIdentity, NativeProcess, ProcessIdentity, normal_path
from reader import Cursor, MemoryDatabase, ReadError, Reader, Scope
from snapshot import SQLITE_WINDOWS_PROFILE, Snapshotter, validate_capture_request
from textdecode import DecodedField, ZSTD_MAGIC, ZstdDecoder, decode_field


@dataclass(frozen=True, repr=False)
class PollResult:
    batch: tuple = field(repr=False)
    unchanged: bool
    capture_seconds: float
    delivery_seconds: float
    decoded: bool = False
    expired: bool = False


class CaptureSession:
    def __init__(self, scope, consent, expected, profile, *, root, selected_databases,
                 vfs_profile, scan_bytes, scan_seconds, snapshot_bytes, snapshot_seconds,
                 process_factory=NativeProcess, snapshotter_factory=Snapshotter, scan_hits=1024):
        validate_target(scope, consent, expected, profile)
        validate_scan_budget(scan_bytes, scan_seconds, max_hits=scan_hits)
        if (vfs_profile != SQLITE_WINDOWS_PROFILE or not selected_databases
                or any(not isinstance(name, str) or not name or not isinstance(item, tuple)
                       or len(item) != 2 or not isinstance(item[1], FileIdentity)
                       for name, item in selected_databases.items())):
            raise ReadError("EXPLICIT_DATABASE_IDENTITIES_AND_VFS_REQUIRED")
        for relative, _ in selected_databases.values():
            validate_capture_request(root, relative, snapshot_bytes, snapshot_seconds)
        self.scope, self.expected = scope, expected
        self._root, self._selected = root, dict(selected_databases)
        self._vfs, self._scan_bytes, self._scan_seconds = vfs_profile, scan_bytes, scan_seconds
        self._scan_hits = scan_hits
        self._bytes, self._seconds = snapshot_bytes, snapshot_seconds
        self._process_factory, self._snapshotter_factory = process_factory, snapshotter_factory
        self._process, self._candidates, self._snapshotter = None, frozenset(), None
        self._fingerprint, self._reader = None, None

    def __enter__(self):
        if self._process is not None:
            raise ReadError("SESSION_ALREADY_OPEN")
        self._process = self._process_factory(self.expected.pid)
        try:
            self._candidates = KeyScanner(self._process, self.expected,
                max_bytes=self._scan_bytes, max_seconds=self._scan_seconds,
                max_hits=self._scan_hits).candidates()
            self._snapshotter = self._snapshotter_factory(profile=self._vfs)
            return self
        except BaseException:
            self.close()
            raise

    def capture(self):
        if self._process is None or not self._candidates:
            raise ReadError("SESSION_NOT_OPEN")
        self._fingerprint, self._reader = None, None
        return capture_selected_shards(self.scope, self._process, self.expected, self._candidates,
            root=self._root, selected_databases=self._selected, snapshotter=self._snapshotter,
            snapshot_bytes=self._bytes, snapshot_seconds=self._seconds)

    def poll(self, reader, sink, *, limit, deadline=None):
        """Skip only a fully authenticated, acknowledged AND drained snapshot.

        Retains a 32-byte ciphertext digest and reader metadata only. No cached
        ciphertext/plaintext DB or message bodies, even between unchanged polls.
        A full batch, rejected sink, capture/decode error or new reader forces
        the next poll through authentication/decryption again.
        """
        if self._process is None or not self._candidates:
            raise ReadError("SESSION_NOT_OPEN")
        if not isinstance(reader, Reader) or reader.scope != self.scope:
            raise ReadError("READER_SCOPE_MISMATCH")
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ReadError("BATCH_LIMIT")
        if deadline is not None and (type(deadline) not in (int, float) or not math.isfinite(deadline)):
            raise ReadError("READ_DEADLINE_INVALID")
        if deadline is not None and time.monotonic() >= deadline:
            return PollResult((), False, 0.0, 0.0, expired=True)
        if reader is not self._reader:
            self._fingerprint, self._reader = None, reader
        before = time.monotonic()
        try:
            snapshots = capture_selected_encrypted(self._process, self.expected, root=self._root,
                selected_databases=self._selected, snapshotter=self._snapshotter,
                snapshot_bytes=self._bytes, snapshot_seconds=self._seconds)
            fingerprint = fingerprint_selected_snapshots(snapshots)
            if self._process.identity() != self.expected:
                raise ReadError("PROCESS_IDENTITY_CHANGED")
            if fingerprint == self._fingerprint:
                return PollResult((), True, time.monotonic() - before, 0.0)
            if deadline is not None and time.monotonic() >= deadline:
                self._fingerprint = None
                return PollResult((), False, time.monotonic() - before, 0.0, expired=True)
            shards = decode_selected_shards(self.scope, self._process, self.expected,
                self._candidates, snapshots, snapshot_bytes=self._bytes)
            del snapshots
            captured = time.monotonic() - before
            if deadline is not None and time.monotonic() >= deadline:
                self._fingerprint = None
                return PollResult((), False, captured, 0.0, decoded=True, expired=True)
            delivered_at = time.monotonic()
            batch = reader.deliver(shards, sink, limit=limit)
            del shards
            self._fingerprint = fingerprint if len(batch) < limit else None
            return PollResult(batch, False, captured, time.monotonic() - delivered_at, decoded=True)
        except BaseException:
            self._fingerprint = None
            raise

    def close(self):
        self._fingerprint, self._reader = None, None
        self._candidates = frozenset()
        self._snapshotter = None
        if self._process is not None:
            # Keep a failed handle owner available for retry. Never report the
            # session closed after an unsuccessful CloseHandle call.
            self._process.close()
            self._process = None

    def __exit__(self, *_):
        self.close()


def baseline_reader(scope, shards, *, database_factory=MemoryDatabase, allow_missing_groups=False):
    """Read schema and maximum cursor ONLY; never select historical bodies."""
    if not shards or len({s.shard_id for s in shards}) != len(shards):
        raise ReadError("SHARD_MANIFEST_MISMATCH")
    manifest, cursors, found = {}, {}, set()
    for shard in shards:
        scope.check_account(shard.account)
        manifest[shard.shard_id] = shard.generation
        with database_factory(shard.image) as db:
            for group in scope.groups:
                table = "Msg_" + hashlib.md5(group.encode("utf-8")).hexdigest()
                tables = db.query("SELECT type FROM sqlite_master WHERE name=?", (table,))
                cursor = Cursor(0, 0)
                if tables:
                    if len(tables) != 1 or tables[0][0] != "table":
                        raise ReadError("MESSAGE_TABLE_UNSUPPORTED")
                    found.add(group)
                    rows = db.query(f'SELECT sort_seq, local_id FROM "{table}" '
                                    'ORDER BY sort_seq DESC, local_id DESC LIMIT 1')
                    if rows:
                        cursor = Cursor(rows[0]["sort_seq"], rows[0]["local_id"])
                cursors[(shard.shard_id, group)] = cursor
    if found != set(scope.groups) and not allow_missing_groups:
        raise ReadError("SELECTED_GROUP_NOT_FOUND")
    return Reader(scope, manifest, cursors, allow_missing_groups=allow_missing_groups)


class MarkerReceipt:
    """In-memory test receipts/cursors only; never serialize event bodies/IDs."""
    def __init__(self, marker, *, zstd=None):
        if not re.fullmatch(r"CLASSREP_TEST_[A-Z0-9_]{1,64}", marker):
            raise ReadError("EXPLICIT_TEST_MARKER_REQUIRED")
        self._marker = marker
        self._zstd = zstd
        self._state = ({}, {}, False, {"events_examined": 0, "empty_content_fields": 0,
                                      "nonempty_compressed_fields": 0, "invalid_utf8_fields": 0,
                                      "zstd_fields_decoded": 0, "undecoded_fields": 0,
                                      "conflicting_text_fields": 0})

    def __call__(self, events, next_cursors):
        receipts, _, unsupported, counts = self._state
        receipts = receipts.copy()
        counts = counts.copy()
        for event in events:
            counts["events_examined"] += 1
            if not event.content:
                counts["empty_content_fields"] += 1
            fields = [decode_field(event.content, zstd=self._zstd)]
            compressed = event.compressed_content
            if compressed is not None and compressed != b'' and compressed != '':
                counts["nonempty_compressed_fields"] += 1
                if type(compressed) is bytes and compressed.startswith(ZSTD_MAGIC):
                    fields.append(decode_field(compressed, zstd=self._zstd))
                else:
                    fields.append(DecodedField(None, "COMPRESSED_FIELD_FORMAT_UNSUPPORTED"))
            for result in fields:
                if result.status == "ZSTD_UTF8":
                    counts["zstd_fields_decoded"] += 1
                if result.text is None:
                    unsupported = True
                    counts["undecoded_fields"] += 1
                if result.status == "INVALID_UTF8":
                    counts["invalid_utf8_fields"] += 1
            texts = {result.text for result in fields if result.text}
            if len(texts) > 1:
                # No undocumented field precedence or placeholder heuristics.
                counts["conflicting_text_fields"] += 1
                unsupported = True
                continue
            if any(re.search(r"(?<![A-Z0-9_])" + re.escape(self._marker)
                             + r"(?![A-Z0-9_])", text) for text in texts):
                receipts[event.event_id] = event.timestamp
        # The experiment has no durable sink. This acknowledgement deliberately
        # lasts only for this process; it must never be reused by business ingest.
        self._state = (receipts, next_cursors.copy(), unsupported, counts)
        return True

    def summary(self):
        receipts, _, unsupported, counts = self._state
        return {"marker_count": len(receipts), "message_timestamps": sorted(receipts.values()),
                "unverified_encoded_content": unsupported, **counts}


def selected_metadata(metadata, account):
    accounts = [a for a in metadata["accounts"] if a["folder"] == account]
    if len(accounts) != 1:
        raise ReadError("EXPLICIT_ACCOUNT_SELECTION_REQUIRED")
    target = accounts[0]
    root = normal_path(target["root"])
    if (ntpath.basename(root) != "db_storage"
            or ntpath.basename(ntpath.dirname(root)) != account.lower()):
        raise ReadError("ACCOUNT_ROOT_MISMATCH")
    selected = {}
    for item in target["selected"]:
        relative = item["relative"]
        if (not re.fullmatch(r"message/message_\d+\.db", relative)
                or relative in selected or normal_path(item["path"]) != normal_path(ntpath.join(root, relative))):
            raise ReadError("EXPLICIT_MESSAGE_DATABASES_REQUIRED")
        selected[relative] = (relative, FileIdentity(**item["identity"]))
    if not selected:
        raise ReadError("EXPLICIT_MESSAGE_DATABASES_REQUIRED")
    return root, selected, ProcessIdentity(**metadata["process"])


def parser():
    p = argparse.ArgumentParser(description="Opt-in short research test; no business ingestion.")
    for name in ("metadata", "account", "group", "marker", "version", "vfs-profile"):
        p.add_argument("--" + name, required=True)
    for name in ("approve-key-read", "approve-encrypted-db-read", "accept-os-memory-limit",
                 "approve-experimental-profile", "approve-new-texts-since-baseline"):
        p.add_argument("--" + name, action="store_true", required=True)
    p.add_argument("--scan-bytes", type=int, required=True)
    p.add_argument("--scan-seconds", type=float, required=True)
    p.add_argument("--snapshot-bytes", type=int, required=True)
    p.add_argument("--snapshot-seconds", type=float, required=True)
    p.add_argument("--window-seconds", type=float, required=True)
    p.add_argument("--poll-seconds", type=float, required=True)
    p.add_argument("--diagnostics", action="store_true", help="Only cursor/timing/counter metadata; no bodies.")
    p.add_argument("--zstd-library", help="Explicit trusted absolute libzstd path; never auto-discovered.")
    p.add_argument("--text-input-bytes", type=int)
    p.add_argument("--text-output-bytes", type=int)
    p.add_argument("--text-window-log", type=int)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    if not 1 <= args.window_seconds <= 300 or not 1 <= args.poll_seconds <= 10:
        raise ReadError("EXPLICIT_SHORT_TEST_WINDOW_REQUIRED")
    text_options = (args.zstd_library, args.text_input_bytes, args.text_output_bytes, args.text_window_log)
    if any(option is not None for option in text_options) and not all(option is not None for option in text_options):
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
    with CaptureSession(scope, consent, expected, profile, root=root, selected_databases=selected,
            vfs_profile=args.vfs_profile, scan_bytes=args.scan_bytes, scan_seconds=args.scan_seconds,
            snapshot_bytes=args.snapshot_bytes, snapshot_seconds=args.snapshot_seconds) as session:
        initial = session.capture()
        reader = baseline_reader(scope, initial)
        del initial
        deadline = time.monotonic() + args.window_seconds
        ready = {"stage": "baseline_ready", "window_seconds": args.window_seconds,
                 "historical_bodies_selected": False, "baseline_epoch_ms": int(time.time() * 1000)}
        if zstd is not None:
            ready["zstd_decoder"] = {"version": zstd.version,
                "max_input_bytes": zstd.max_input_bytes, "max_output_bytes": zstd.max_output_bytes,
                "max_window_log": zstd.max_window_log}
        if args.diagnostics:
            ready["baseline_cursors"] = [{"database": shard_id, "sort_seq": c.sort_seq,
                "local_id": c.local_id} for (shard_id, _group), c in reader.cursors.items()]
        print(json.dumps(ready), flush=True)
        last_count, last_examined = 0, 0
        poll_stats = {"poll_count": 0, "unchanged_poll_count": 0, "full_decode_count": 1}
        while time.monotonic() < deadline:
            time.sleep(min(args.poll_seconds, max(0, deadline - time.monotonic())))
            if time.monotonic() >= deadline:
                break
            polled = session.poll(reader, receipt, limit=100, deadline=deadline)
            poll_stats["poll_count"] += 1
            poll_stats["unchanged_poll_count"] += int(polled.unchanged)
            poll_stats["full_decode_count"] += int(polled.decoded)
            if polled.expired:
                del polled
                break
            del polled
            summary = receipt.summary()
            if summary["marker_count"] != last_count:
                print(json.dumps({"stage": "marker_received", **summary}), flush=True)
                last_count = summary["marker_count"]
            elif args.diagnostics and summary["events_examined"] != last_examined:
                print(json.dumps({"stage": "new_messages_examined", **summary}), flush=True)
            last_examined = summary["events_examined"]
        summary = receipt.summary()
    print(json.dumps({"stage": "stopped", **summary, "poll_stats": poll_stats,
                      "keys_or_plaintext_saved": False}), flush=True)
    return 0 if summary["marker_count"] else 3


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
        # Suppress traceback locals, identity/path details and message contents.
        print(json.dumps({"stage": "stopped", "reason": "UNEXPECTED_TEST_FAILURE"}), flush=True)
        raise SystemExit(2)
