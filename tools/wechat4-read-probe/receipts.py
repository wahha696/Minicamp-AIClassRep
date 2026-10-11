"""Opt-in selected-message receipts, cursors and business delivery acknowledgements.

Only an explicit dedicated .wechat-receipts.sqlite3 file is accepted. Selected
message fields ARE persisted (including undecoded bytes); keys, full source DBs,
process snapshots and unselected groups are never inputs to this module.
Importing it opens no files. No automatic history, cleanup, AI or network access.
"""
from __future__ import annotations

import json
import math
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import struct
import uuid

from reader import Cursor, Message, ReadError, Reader, Scope, message_event_id

APPLICATION_ID = 0x43525734
VERSION = 4
MAX_INTEGER = (1 << 63) - 1
SUFFIX = ".wechat-receipts.sqlite3"
LEGACY_TABLES = {
    "receipt_binding": """CREATE TABLE receipt_binding (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        scope TEXT NOT NULL, manifest TEXT NOT NULL)""",
    "receipt_cursors": """CREATE TABLE receipt_cursors (
        shard_id TEXT NOT NULL, group_id TEXT NOT NULL,
        sort_seq INTEGER NOT NULL CHECK(sort_seq>=0),
        local_id INTEGER NOT NULL CHECK(local_id>=0),
        PRIMARY KEY(shard_id,group_id))""",
    "receipt_messages": """CREATE TABLE receipt_messages (
        event_id TEXT PRIMARY KEY NOT NULL,
        account TEXT NOT NULL, group_id TEXT NOT NULL,
        shard_id TEXT NOT NULL, generation TEXT NOT NULL,
        sort_seq INTEGER NOT NULL, local_id INTEGER NOT NULL,
        server_id INTEGER NOT NULL, kind INTEGER NOT NULL,
        sender_id INTEGER NOT NULL, timestamp INTEGER NOT NULL,
        content, compressed_content)""",
}
V2_TABLES = {**LEGACY_TABLES,
    "receipt_deliveries": """CREATE TABLE receipt_deliveries (
        destination TEXT NOT NULL, event_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        PRIMARY KEY(destination,event_id),
        FOREIGN KEY(event_id) REFERENCES receipt_messages(event_id))""",
}
V3_TABLES = {**V2_TABLES,
    "receipt_delivery_issues": """CREATE TABLE receipt_delivery_issues (
        destination TEXT NOT NULL, event_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY(destination,event_id),
        FOREIGN KEY(event_id) REFERENCES receipt_messages(event_id))""",
}
TABLES = {**V3_TABLES,
    'receipt_activation': '''CREATE TABLE receipt_activation (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), activation_id TEXT NOT NULL)''',
}
DELIVERY_ISSUE_REASONS = frozenset((
    "DELIVERY_MESSAGE_TYPE_UNSUPPORTED", "DELIVERY_COMPRESSED_FIELD_UNSUPPORTED",
    "DELIVERY_TEXT_NOT_DECODED", "DELIVERY_TEXT_CONFLICT", "DELIVERY_TEXT_INVALID",
    "DELIVERY_TEXT_LIMIT", "DELIVERY_MESSAGE_METADATA_INVALID", "DELIVERY_NAMES_UNAVAILABLE",
))


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


class LocalReceipts:
    def __init__(self, path, scope: Scope, manifest, *, allow_selected_message_storage=False):
        # Consent and scope checks precede even path inspection/creation.
        if allow_selected_message_storage is not True:
            raise ReadError("SELECTED_MESSAGE_STORAGE_APPROVAL_REQUIRED")
        initial = {(s, g): Cursor(0, 0) for s in manifest for g in scope.groups}
        Reader(scope, manifest, initial)
        self._scope, self._manifest = scope, dict(manifest)
        self._binding = (_json({"account": scope.account, "groups": sorted(scope.groups)}),
                         _json(self._manifest))
        self._conn = None
        try:
            target = Path(path)
            if (not target.is_absolute() or str(target).startswith("\\\\")
                    or not target.name.endswith(SUFFIX) or target.is_symlink()):
                raise ReadError("EXPLICIT_LOCAL_RECEIPT_FILE_REQUIRED")
            # Reject ordinary QQ/WeChat/foreign DB files BEFORE SQLite can do
            # hot-journal recovery or change journal mode on a writable handle.
            if target.exists():
                with target.open("rb") as source:
                    header = source.read(100)
                if header and (len(header) != 100 or header[:16] != b"SQLite format 3\x00"
                    or struct.unpack_from(">I", header, 68)[0] != APPLICATION_ID
                    or struct.unpack_from(">I", header, 60)[0] not in (1, 2, 3, VERSION)):
                    raise ReadError("LOCAL_RECEIPT_FORMAT_MISMATCH")
            self._conn = sqlite3.connect(str(target), timeout=0, isolation_level=None)
            self._conn.enable_load_extension(False)
            self._conn.execute("PRAGMA trusted_schema=OFF")
            self._conn.execute("PRAGMA temp_store=MEMORY")
            self._conn.execute("PRAGMA foreign_keys=ON")
            objects = self._conn.execute("SELECT type,name,sql FROM sqlite_master").fetchall()
            if objects:
                self._check_schema(objects)
                # Verify ownership before even an additive v1/v2 schema upgrade.
                bindings = self._conn.execute("SELECT singleton,scope,manifest FROM receipt_binding").fetchall()
                if bindings and bindings != [(1, *self._binding)]:
                    raise ReadError("LOCAL_RECEIPT_BINDING_MISMATCH")
            elif (self._conn.execute("PRAGMA application_id").fetchone()[0] != 0
                  or self._conn.execute("PRAGMA user_version").fetchone()[0] != 0):
                raise ReadError("LOCAL_RECEIPT_SCHEMA_MISMATCH")
            if self._conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0] != "delete":
                raise ReadError("LOCAL_RECEIPT_JOURNAL_REQUIRED")
            self._conn.execute("PRAGMA synchronous=FULL")
            if self._conn.execute("PRAGMA synchronous").fetchone()[0] != 2:
                raise ReadError("LOCAL_RECEIPT_SYNC_REQUIRED")
            if not objects:
                with self._transaction():
                    for statement in TABLES.values():
                        self._conn.execute(statement)
                    self._conn.execute(f"PRAGMA application_id={APPLICATION_ID}")
                    self._conn.execute(f"PRAGMA user_version={VERSION}")
            elif self._conn.execute("PRAGMA user_version").fetchone()[0] < VERSION:
                # Only our exact v1/v2 formats are accepted above. Additive migration
                # keeps messages, source cursors and existing delivery acknowledgements.
                with self._transaction():
                    version = self._conn.execute("PRAGMA user_version").fetchone()[0]
                    if version == 1:
                        self._conn.execute(TABLES["receipt_deliveries"])
                    if version < 3:
                        self._conn.execute(TABLES["receipt_delivery_issues"])
                    self._conn.execute(TABLES['receipt_activation'])
                    self._conn.execute(f"PRAGMA user_version={VERSION}")
            if self._conn.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ReadError("LOCAL_RECEIPT_INTEGRITY_FAILED")
            if self._conn.execute("PRAGMA foreign_key_check").fetchall():
                raise ReadError("LOCAL_RECEIPT_INTEGRITY_FAILED")
            with self._transaction():
                self._check_binding(allow_empty=True)
        except (OSError, ValueError, TypeError, sqlite3.Error):
            self.close()
            raise ReadError("LOCAL_RECEIPT_OPEN_FAILED") from None
        except BaseException:
            self.close()
            raise

    def _check_schema(self, objects):
        normalize = lambda value: " ".join(value.split())
        version = self._conn.execute("PRAGMA user_version").fetchone()[0]
        expected = LEGACY_TABLES if version == 1 else V2_TABLES if version == 2 else V3_TABLES if version == 3 else TABLES
        tables = {name: sql for kind, name, sql in objects if kind == "table"}
        if (set(tables) != set(expected)
                or any(not isinstance(sql, str) for sql in tables.values())
                or any(normalize(tables[n]) != normalize(expected[n]) for n in expected)
                or any(kind != "table" and not (kind == "index" and sql is None
                       and name.startswith("sqlite_autoindex_")) for kind, name, sql in objects)
                or self._conn.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID
                or version not in (1, 2, 3, VERSION)):
            raise ReadError("LOCAL_RECEIPT_SCHEMA_MISMATCH")

    def _open(self):
        if self._conn is None:
            raise ReadError("LOCAL_RECEIPT_CLOSED")

    @contextmanager
    def _transaction(self):
        self._open()
        if self._conn.in_transaction:
            raise ReadError("LOCAL_RECEIPT_TRANSACTION_ALREADY_RUNNING")
        try:
            self._conn.execute("BEGIN IMMEDIATE")
            yield
            self._conn.execute("COMMIT")
        except BaseException as error:
            if self._conn.in_transaction:
                try:
                    self._conn.execute("ROLLBACK")
                except sqlite3.Error:
                    self.close()  # A connection with uncertain state is unusable.
                    raise ReadError("LOCAL_RECEIPT_ROLLBACK_FAILED") from None
            if isinstance(error, sqlite3.Error):
                raise ReadError("LOCAL_RECEIPT_WRITE_FAILED") from None
            raise

    def _check_binding(self, *, allow_empty=False):
        rows = self._conn.execute("SELECT singleton,scope,manifest FROM receipt_binding").fetchall()
        if not rows:
            if (self._conn.execute("SELECT count(*) FROM receipt_cursors").fetchone()[0]
                    or self._conn.execute("SELECT count(*) FROM receipt_messages").fetchone()[0]
                    or self._conn.execute("SELECT count(*) FROM receipt_deliveries").fetchone()[0]
                    or self._conn.execute("SELECT count(*) FROM receipt_delivery_issues").fetchone()[0]
                    or self._conn.execute("SELECT count(*) FROM receipt_activation").fetchone()[0]):
                raise ReadError("LOCAL_RECEIPT_STATE_INVALID")
            if allow_empty:
                return False
            raise ReadError("LOCAL_RECEIPT_NOT_INITIALIZED")
        if rows != [(1, *self._binding)]:
            raise ReadError("LOCAL_RECEIPT_BINDING_MISMATCH")
        return True

    def _checked_cursors(self, cursors):
        if (not isinstance(cursors, dict)
                or set(cursors) != {(s, g) for s in self._manifest for g in self._scope.groups}
                or any(not isinstance(c, Cursor) or max(c.sort_seq, c.local_id) > MAX_INTEGER
                       for c in cursors.values())):
            raise ReadError("LOCAL_RECEIPT_CURSORS_INVALID")
        return cursors.copy()

    def _load_cursors(self):
        rows = self._conn.execute("SELECT shard_id,group_id,sort_seq,local_id FROM receipt_cursors").fetchall()
        try:
            return self._checked_cursors({(s, g): Cursor(seq, local) for s, g, seq, local in rows})
        except (TypeError, ValueError, ReadError):
            raise ReadError("LOCAL_RECEIPT_CURSORS_INVALID") from None

    def initialize(self, cursors, *, activation_id=None):
        """Persist an explicit activation baseline, without querying any history."""
        cursors = self._checked_cursors(cursors)
        if activation_id is not None: self._activation(activation_id)
        with self._transaction():
            if self._check_binding(allow_empty=True):
                raise ReadError("LOCAL_RECEIPT_ALREADY_INITIALIZED")
            self._conn.execute("INSERT INTO receipt_binding VALUES (1,?,?)", self._binding)
            self._conn.executemany("INSERT INTO receipt_cursors VALUES (?,?,?,?)",
                [(s, g, c.sort_seq, c.local_id) for (s, g), c in cursors.items()])
            if activation_id is not None: self._set_activation(activation_id)

    @staticmethod
    def _activation(value):
        try:
            if type(value) is not str or str(uuid.UUID(value, version=4)) != value:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise ReadError('LOCAL_RECEIPT_ACTIVATION_INVALID') from None

    def _set_activation(self, value):
        self._conn.execute('INSERT INTO receipt_activation VALUES (1,?) '
            'ON CONFLICT(singleton) DO UPDATE SET activation_id=excluded.activation_id', (value,))

    def activation_id(self):
        with self._transaction():
            self._check_binding()
            rows = self._conn.execute('SELECT activation_id FROM receipt_activation').fetchall()
            if not rows: return None  # Older receipt; never silently adopt a new activation.
            if len(rows) != 1: raise ReadError('LOCAL_RECEIPT_ACTIVATION_INVALID')
            self._activation(rows[0][0])
            return rows[0][0]

    def restore_reader(self, *, allow_missing_groups=False):
        """Never substitute a new baseline for missing/invalid stored progress."""
        with self._transaction():
            self._check_binding()
            cursors = self._load_cursors()
        return Reader(self._scope, self._manifest, cursors, allow_missing_groups=allow_missing_groups)

    def initialized(self):
        """An empty new receipt may be initialized; corrupt progress must fail."""
        with self._transaction():
            return self._check_binding(allow_empty=True)

    def reactivate(self, cursors, *, approve_skip_disabled_gap=False, activation_id=None):
        """Explicit group re-enable baseline; retains all received/pending rows.

        Not for application restart. Caller must use an immutable selected group
        scope and distinguish a real user re-enable from startup/reconnection.
        """
        if approve_skip_disabled_gap is not True:
            raise ReadError('LOCAL_RECEIPT_REACTIVATION_APPROVAL_REQUIRED')
        cursors = self._checked_cursors(cursors)
        if activation_id is not None: self._activation(activation_id)
        with self._transaction():
            self._check_binding()
            before = self._load_cursors()
            if any(cursors[pair] < previous for pair, previous in before.items()):
                raise ReadError('LOCAL_RECEIPT_REACTIVATION_REGRESSION')
            self._conn.executemany('UPDATE receipt_cursors SET sort_seq=?,local_id=? WHERE shard_id=? AND group_id=?',
                [(cursor.sort_seq, cursor.local_id, s, g) for (s, g), cursor in cursors.items()])
            self._checkpoint('after_reactivation_cursors')
            if activation_id is not None: self._set_activation(activation_id)
            self._checkpoint('after_reactivation_token')

    def _values(self, msg):
        if (not isinstance(msg, Message) or msg.account != self._scope.account
                or msg.group not in self._scope.groups or msg.shard_id not in self._manifest
                or not isinstance(msg.cursor, Cursor) or msg.cursor.local_id == 0):
            raise ReadError("LOCAL_RECEIPT_MESSAGE_INVALID")
        if any(type(v) is not int or not -MAX_INTEGER - 1 <= v <= MAX_INTEGER
               for v in (msg.cursor.sort_seq, msg.cursor.local_id, msg.server_id,
                         msg.kind, msg.sender_id, msg.timestamp)):
            raise ReadError('LOCAL_RECEIPT_INTEGER_INVALID')
        raw_types = (str, bytes, int, float, type(None))
        if type(msg.content) not in raw_types:
            raise ReadError('LOCAL_RECEIPT_CONTENT_TYPE_UNSUPPORTED')
        if type(msg.compressed_content) not in raw_types:
            raise ReadError('LOCAL_RECEIPT_COMPRESSED_TYPE_UNSUPPORTED')
        for value in (msg.content, msg.compressed_content):
            if ((type(value) is int and not -MAX_INTEGER - 1 <= value <= MAX_INTEGER)
                    or (type(value) is float and not math.isfinite(value))):
                raise ReadError('LOCAL_RECEIPT_MESSAGE_INVALID')
        generation = self._manifest[msg.shard_id]
        if msg.event_id != message_event_id(msg.account, msg.group, msg.shard_id,
                generation, msg.server_id, msg.cursor.local_id):
            raise ReadError("LOCAL_RECEIPT_EVENT_ID_INVALID")
        for value in (msg.content, msg.compressed_content):
            if isinstance(value, str):
                try:
                    value.encode("utf-8", errors="strict")
                except UnicodeError:
                    raise ReadError("LOCAL_RECEIPT_MESSAGE_INVALID") from None
        return (msg.event_id, msg.account, msg.group, msg.shard_id, generation,
                msg.cursor.sort_seq, msg.cursor.local_id, msg.server_id, msg.kind,
                msg.sender_id, msg.timestamp, msg.content, msg.compressed_content)

    @staticmethod
    def _payload(values):
        # Same server message may have a different source shard/local cursor.
        # Conflicting bodies/metadata are NOT silently overwritten or selected.
        return (tuple(values[i] for i in (0, 1, 2, 7, 8, 9, 10))
                + tuple((type(values[i]), values[i]) for i in (11, 12)))

    def sink(self, reader):
        if (not isinstance(reader, Reader) or reader.scope != self._scope
                or reader.manifest != self._manifest):
            raise ReadError("LOCAL_RECEIPT_READER_MISMATCH")

        def accept(events, next_cursors):
            self._commit(reader, events, next_cursors)
            return True  # Only after the SQLite commit succeeded.
        return accept

    def import_history(self, events, *, approve_history_read=False):
        """Idempotent explicit refresh; never advances or rewinds live cursors."""
        if approve_history_read is not True:
            raise ReadError('LOCAL_RECEIPT_HISTORY_APPROVAL_REQUIRED')
        if type(events) is not tuple or len(events) > 1000:
            raise ReadError('LOCAL_RECEIPT_BATCH_INVALID')
        values = tuple(self._values(message) for message in events)
        inserted = 0
        with self._transaction():
            self._check_binding()
            self._load_cursors()  # A history refresh cannot conceal corrupt live progress.
            for row in values:
                existing = self._conn.execute('SELECT * FROM receipt_messages WHERE event_id=?', (row[0],)).fetchone()
                if existing is not None:
                    if self._payload(existing) != self._payload(row):
                        raise ReadError('LOCAL_RECEIPT_EVENT_CONFLICT')
                else:
                    self._conn.execute('INSERT INTO receipt_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', row)
                    inserted += 1
            self._checkpoint('after_history_messages')
        return inserted

    def _commit(self, reader, events, next_cursors):
        before = self._checked_cursors(reader.cursors)
        after = self._checked_cursors(next_cursors)
        if not isinstance(events, tuple) or not 1 <= len(events) <= 1000:
            raise ReadError("LOCAL_RECEIPT_BATCH_INVALID")
        values = tuple(self._values(msg) for msg in events)
        calculated = before.copy()
        for msg in events:
            pair = (msg.shard_id, msg.group)
            if msg.cursor <= calculated[pair]:
                raise ReadError("LOCAL_RECEIPT_CURSOR_REGRESSION")
            calculated[pair] = msg.cursor
        if calculated != after:
            raise ReadError("LOCAL_RECEIPT_CURSOR_MESSAGE_MISMATCH")
        with self._transaction():
            self._check_binding()
            stored = self._load_cursors()
            replay = stored != before
            if replay and stored != after:
                raise ReadError("LOCAL_RECEIPT_STALE_READER")
            for row in values:
                existing = self._conn.execute("SELECT * FROM receipt_messages WHERE event_id=?",
                                              (row[0],)).fetchone()
                if existing is not None:
                    if self._payload(existing) != self._payload(row):
                        raise ReadError("LOCAL_RECEIPT_EVENT_CONFLICT")
                elif replay:
                    raise ReadError("LOCAL_RECEIPT_REPLAY_INCOMPLETE")
                else:
                    self._conn.execute("INSERT INTO receipt_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
            self._checkpoint("after_messages")
            if not replay:
                self._conn.executemany("UPDATE receipt_cursors SET sort_seq=?,local_id=? "
                    "WHERE shard_id=? AND group_id=?",
                    [(c.sort_seq, c.local_id, s, g) for (s, g), c in after.items()])
            self._checkpoint("after_cursors")
        self._checkpoint("after_commit")

    def _checkpoint(self, phase):
        """Fault-injection seam for synthetic subprocess tests; no input data."""

    def stored_messages(self, *, limit):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ReadError("BATCH_LIMIT")
        with self._transaction():
            self._check_binding()
            rows = self._conn.execute("SELECT * FROM receipt_messages "
                "ORDER BY timestamp,event_id LIMIT ?", (limit,)).fetchall()
        return self._messages(rows)

    def _messages(self, rows):
        result = []
        for row in rows:
            event, account, group, shard, generation, seq, local, server, kind, sender, ts, body, compressed = row
            if self._manifest.get(shard) != generation:
                raise ReadError("LOCAL_RECEIPT_MESSAGE_INVALID")
            msg = Message(event, account, group, shard, Cursor(seq, local), server, kind, sender, ts, body, compressed)
            self._values(msg)
            result.append(msg)
        return tuple(result)

    @staticmethod
    def _destination(destination):
        if not isinstance(destination, str) or not destination.strip():
            raise ReadError("EXPLICIT_DELIVERY_DESTINATION_REQUIRED")
        try:
            if len(destination.encode("utf-8")) > 256:
                raise ReadError("EXPLICIT_DELIVERY_DESTINATION_REQUIRED")
        except UnicodeError:
            raise ReadError("EXPLICIT_DELIVERY_DESTINATION_REQUIRED") from None

    @property
    def scope(self):
        return self._scope

    def pending_delivery(self, destination, *, limit, after=None, include_issues=False):
        self._destination(destination)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ReadError("BATCH_LIMIT")
        if (type(include_issues) is not bool or (after is not None and (
                not isinstance(after, tuple) or len(after) != 2 or type(after[0]) is not int
                or not -MAX_INTEGER - 1 <= after[0] <= MAX_INTEGER
                or not isinstance(after[1], str) or len(after[1]) != 64
                or any(c not in '0123456789abcdef' for c in after[1])))):
            raise ReadError("LOCAL_DELIVERY_QUERY_INVALID")
        with self._transaction():
            self._check_binding()
            sql = ("SELECT m.* FROM receipt_messages m WHERE NOT EXISTS "
                "(SELECT 1 FROM receipt_deliveries d WHERE d.destination=? AND d.event_id=m.event_id) "
            )
            values = [destination]
            if not include_issues:
                sql += ("AND NOT EXISTS (SELECT 1 FROM receipt_delivery_issues i "
                        "WHERE i.destination=? AND i.event_id=m.event_id) ")
                values.append(destination)
            if after is not None:
                sql += "AND (m.timestamp,m.event_id) > (?,?) "
                values.extend(after)
            sql += "ORDER BY m.timestamp,m.event_id LIMIT ?"
            rows = self._conn.execute(sql, (*values, limit)).fetchall()
        return self._messages(rows)

    def defer_delivery(self, destination, event_id, reason):
        self._destination(destination)
        if reason not in DELIVERY_ISSUE_REASONS:
            raise ReadError("LOCAL_DELIVERY_ISSUE_INVALID")
        with self._transaction():
            self._check_binding()
            rows = self._conn.execute("SELECT * FROM receipt_messages WHERE event_id=?", (event_id,)).fetchall()
            if len(rows) != 1:
                raise ReadError("LOCAL_DELIVERY_ACK_UNKNOWN_EVENT")
            self._messages(rows)
            if self._conn.execute("SELECT 1 FROM receipt_deliveries WHERE destination=? AND event_id=?",
                                  (destination, event_id)).fetchone():
                raise ReadError("LOCAL_DELIVERY_ALREADY_ACKNOWLEDGED")
            self._conn.execute("INSERT INTO receipt_delivery_issues VALUES (?,?,?) "
                "ON CONFLICT(destination,event_id) DO UPDATE SET reason=excluded.reason",
                (destination, event_id, reason))
            self._checkpoint("after_delivery_issue_rows")

    def delivery_issues(self, destination, *, limit):
        self._destination(destination)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ReadError("BATCH_LIMIT")
        with self._transaction():
            self._check_binding()
            rows = self._conn.execute("SELECT i.event_id,m.group_id,i.reason FROM receipt_delivery_issues i "
                "JOIN receipt_messages m ON i.event_id=m.event_id WHERE i.destination=? "
                "ORDER BY m.timestamp,m.event_id LIMIT ?", (destination, limit)).fetchall()
            if any(reason not in DELIVERY_ISSUE_REASONS for _, _, reason in rows):
                raise ReadError("LOCAL_DELIVERY_ISSUE_INVALID")
        return tuple({"event_id": event, "group_id": group, "reason": reason} for event, group, reason in rows)

    def delivery_status(self, destination):
        self._destination(destination)
        with self._transaction():
            self._check_binding()
            rows = self._conn.execute("SELECT count(*) FROM receipt_messages m WHERE NOT EXISTS "
                "(SELECT 1 FROM receipt_deliveries d WHERE d.destination=? AND d.event_id=m.event_id) "
                "AND NOT EXISTS (SELECT 1 FROM receipt_delivery_issues i "
                "WHERE i.destination=? AND i.event_id=m.event_id)", (destination, destination)).fetchone()
            deferred = self._conn.execute("SELECT count(*) FROM receipt_delivery_issues "
                                          "WHERE destination=?", (destination,)).fetchone()[0]
        return {"pending": rows[0], "deferred": deferred}

    def retry_delivery_issues(self, destination, event_ids):
        self._destination(destination)
        if (not isinstance(event_ids, tuple) or not 1 <= len(event_ids) <= 100
                or any(not isinstance(v, str) or len(v) != 64
                       or any(c not in '0123456789abcdef' for c in v) for v in event_ids)
                or len(set(event_ids)) != len(event_ids)):
            raise ReadError("LOCAL_DELIVERY_RETRY_INVALID")
        with self._transaction():
            self._check_binding()
            for event in event_ids:
                if not self._conn.execute("SELECT 1 FROM receipt_delivery_issues "
                    "WHERE destination=? AND event_id=?", (destination, event)).fetchone():
                    raise ReadError("LOCAL_DELIVERY_RETRY_NOT_FOUND")
            self._conn.executemany("DELETE FROM receipt_delivery_issues WHERE destination=? AND event_id=?",
                                   [(destination, event) for event in event_ids])
            self._checkpoint("after_delivery_retry_rows")

    def acknowledge_delivery(self, destination, batch_id, event_ids):
        # This is a business-ingestion acknowledgement, NOT AI success or cleanup.
        import re
        self._destination(destination)
        if (not isinstance(batch_id, str) or not re.fullmatch(r"[a-f0-9]{64}", batch_id)
                or not isinstance(event_ids, tuple) or not 1 <= len(event_ids) <= 100
                or any(not isinstance(v, str) or not re.fullmatch(r"[a-f0-9]{64}", v) for v in event_ids)
                or len(set(event_ids)) != len(event_ids)):
            raise ReadError("LOCAL_DELIVERY_ACK_INVALID")
        with self._transaction():
            self._check_binding()
            for event in event_ids:
                rows = self._conn.execute("SELECT * FROM receipt_messages WHERE event_id=?", (event,)).fetchall()
                if len(rows) != 1:
                    raise ReadError("LOCAL_DELIVERY_ACK_UNKNOWN_EVENT")
                self._messages(rows)
                if self._conn.execute("SELECT 1 FROM receipt_delivery_issues WHERE destination=? AND event_id=?",
                                      (destination, event)).fetchone():
                    raise ReadError("LOCAL_DELIVERY_DEFERRED_EVENT")
                self._conn.execute("INSERT OR IGNORE INTO receipt_deliveries VALUES (?,?,?)",
                                   (destination, event, batch_id))
            self._checkpoint("after_delivery_ack_rows")
        self._checkpoint("after_delivery_ack_commit")

    def close(self):
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def __enter__(self):
        self._open()
        return self

    def __exit__(self, *_):
        self.close()
