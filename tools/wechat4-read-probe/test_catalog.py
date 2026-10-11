import sqlite3
import struct
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from acquisition import CipherProfile, Consent
from catalog import ContactDatabase, GroupEntry, acquire_groups, read_contact_names, read_groups
from native import FileIdentity
from reader import PAGE_SIZE, ReadError, Shard
from snapshot import SQLITE_WINDOWS_PROFILE
from test_acquisition import FakeProcess, IDENTITY
import test_reader as cipher_fixtures


def image(rows=(), *, schema=None):
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(schema or "CREATE TABLE contact(username TEXT,nick_name TEXT,remark TEXT,owner TEXT)")
        if rows:
            connection.executemany("INSERT INTO contact VALUES (?,?,?,?)", rows)
        connection.commit()
        return connection.serialize()
    finally:
        connection.close()


def groups(data, **options):
    return read_groups(data, **dict({"max_image_bytes": 1024 * 1024,
        "max_groups": 20, "max_name_bytes": 256}, **options))


class CatalogTests(unittest.TestCase):
    def test_only_group_ids_and_names_returned(self):
        data = image((("wxid_private", "PRIVATE_NICKNAME", "PRIVATE_REMARK", "PRIVATE_OWNER"),
                      ("b@chatroom", "人工 <群> 😀", "GROUP_REMARK", "GROUP_OWNER"),
                      ("a@chatroom", "同名", "", ""), ("c@chatroom", "同名", "", "")))
        self.assertEqual(groups(data), (GroupEntry("a@chatroom", "同名"),
            GroupEntry("b@chatroom", "人工 <群> 😀"), GroupEntry("c@chatroom", "同名")))
        self.assertNotIn("PRIVATE", str(groups(data)))
        self.assertNotIn("人工", repr(groups(data)))

    def test_contact_names_prefer_remark_skip_groups_and_private_columns(self):
        data = image((("wxid_a", "昵称A", "备注A", "PRIVATE_OWNER"), ("wxid_b", "昵称B", "  ", "x"),
                      ("wxid_c", None, None, "x"), ("g@chatroom", "群", "群备注", "x")))
        names = read_contact_names(data, max_image_bytes=1024 * 1024, max_rows=20, max_name_bytes=256)
        self.assertEqual(names, {"wxid_a": "备注A", "wxid_b": "昵称B"})
        self.assertNotIn("PRIVATE", str(names))

    def test_contact_names_without_remark_column_use_nicknames(self):
        data = image(schema="CREATE TABLE contact(username TEXT,nick_name TEXT);"
                            "INSERT INTO contact VALUES ('wxid_a','昵称A');")
        self.assertEqual(read_contact_names(data, max_image_bytes=1024 * 1024, max_rows=20, max_name_bytes=256),
                         {"wxid_a": "昵称A"})

    def test_contact_name_budget_does_not_silently_truncate(self):
        data = image(tuple((f"wxid_{n}", "人工", "", "") for n in range(3)))
        with self.assertRaisesRegex(ReadError, "CONTACT_CATALOG_GROUP_LIMIT"):
            read_contact_names(data, max_image_bytes=1024 * 1024, max_rows=2, max_name_bytes=256)

    def test_no_groups_is_explicit_empty_catalog(self):
        self.assertEqual(groups(image((("wxid_private", "private", "", ""),))), ())

    def test_missing_names_are_not_guessed(self):
        self.assertEqual(groups(image((("a@chatroom", None, "", ""), ("b@chatroom", "  ", "", "")))),
            (GroupEntry("a@chatroom", None), GroupEntry("b@chatroom", None)))

    def test_duplicate_group_names_remain_separate(self):
        result = groups(image((("a@chatroom", "人工", "", ""), ("b@chatroom", "人工", "", ""))))
        self.assertEqual(len(result), 2)
        self.assertNotEqual(result[0].group_id, result[1].group_id)

    def test_group_budget_does_not_silently_truncate(self):
        data = image(tuple((f"g{number}@chatroom", "人工", "", "") for number in range(3)))
        self.assertEqual(len(groups(data, max_groups=3)), 3)
        with self.assertRaisesRegex(ReadError, "GROUP_LIMIT"):
            groups(data, max_groups=2)

    def test_image_and_budget_validation_happens_before_open(self):
        with patch("catalog.ContactDatabase") as database:
            for options in ({"max_groups": 0}, {"max_groups": True}, {"max_groups": 10001},
                            {"max_name_bytes": 0}, {"max_image_bytes": 0}):
                with self.assertRaisesRegex(ReadError, "BUDGET_REQUIRED"):
                    groups(b"invalid", **options)
            for value in ("C:\\synthetic\\contact.db", memoryview(b"data"), b""):
                with self.assertRaisesRegex(ReadError, "TYPE_INVALID"):
                    groups(value)
            with self.assertRaisesRegex(ReadError, "TYPE_INVALID"):
                groups(b"12345", max_image_bytes=4)
            database.assert_not_called()

    def test_unsupported_schema_or_view_does_not_query_other_tables(self):
        for schema in ("CREATE TABLE unrelated(secret TEXT)",
                       "CREATE TABLE secret(username TEXT,nick_name TEXT); CREATE VIEW contact AS SELECT * FROM secret"):
            with self.assertRaisesRegex(ReadError, "SCHEMA_UNSUPPORTED"):
                groups(image(schema=schema))
        with self.assertRaisesRegex(ReadError, "QUERY_FAILED"):
            groups(image(schema="CREATE TABLE contact(username TEXT)"))

    def test_duplicate_or_invalid_ids_fail_whole_catalog(self):
        for rows in ((("same@chatroom", "人工", "", ""), ("same@chatroom", "人工", "", "")),
                     (("../../wrong@chatroom", "人工", "", ""),),
                     ((("x" * 250) + "@chatroom", "人工", "", ""),)):
            with self.assertRaisesRegex(ReadError, "ID_INVALID_OR_DUPLICATE"):
                groups(image(rows))

    def test_names_are_strict_utf8_text_and_length_is_bytes(self):
        for name in (b"bytes", "nul\0name", "中" * 86):
            with self.assertRaisesRegex(ReadError, "NAME_INVALID_OR_LIMIT"):
                groups(image((("a@chatroom", name, "", ""),)))
        self.assertEqual(groups(image((("a@chatroom", "中" * 85, "", ""),)))[0].name, "中" * 85)

    def test_private_columns_members_history_and_file_exits_denied(self):
        data = image((("a@chatroom", "人工", "secret", "owner"),))
        with ContactDatabase(data) as database:
            for sql in ("SELECT remark FROM contact", "SELECT owner FROM contact",
                        "SELECT sql FROM sqlite_master", "SELECT * FROM contact",
                        "ATTACH ':memory:' AS other", "PRAGMA query_only=OFF",
                        "CREATE TABLE unexpected(x)", "DELETE FROM contact",
                        "SELECT load_extension('synthetic')"):
                with self.assertRaises(ReadError):
                    database.query(sql)
            self.assertEqual(len(database.query("SELECT username,nick_name FROM contact")), 1)

    def test_no_plaintext_file_and_connection_closed_on_bad_name(self):
        data = image((("a@chatroom", "bad\0name", "", ""),))
        real_connect, opened = sqlite3.connect, []
        def capture(*args, **kwargs):
            self.assertEqual(args[0], ":memory:")
            connection = real_connect(*args, **kwargs)
            opened.append(connection)
            return connection
        with patch("reader.sqlite3.connect", side_effect=capture):
            with self.assertRaisesRegex(ReadError, "NAME_INVALID"):
                groups(data)
        with self.assertRaises(sqlite3.ProgrammingError):
            opened[0].execute("SELECT 1")

    def test_unselected_private_invalid_text_is_not_decoded(self):
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript("CREATE TABLE contact(username TEXT,nick_name TEXT); "
                "INSERT INTO contact VALUES ('wxid_private',CAST(X'FF' AS TEXT)); "
                "INSERT INTO contact VALUES ('a@chatroom','人工')")
            connection.commit()
            self.assertEqual(groups(connection.serialize()), (GroupEntry("a@chatroom", "人工"),))
        finally:
            connection.close()


ACCOUNT = "synthetic_account"
ROOT = r"c:\synthetic_root\synthetic_account\db_storage"
FILE = FileIdentity(1, 2, 3)


def acquire(**overrides):
    values = {"account": ACCOUNT, "root": ROOT, "expected_process": IDENTITY,
        "expected_file": FILE, "consent": Consent(ACCOUNT, True, True, True),
        "cipher_profile": CipherProfile(IDENTITY.version, True), "vfs_profile": SQLITE_WINDOWS_PROFILE,
        "approve_contact_metadata": True, "scan_bytes": 20000, "scan_seconds": 5, "scan_hits": 128,
        "snapshot_bytes": 1024 * 1024, "snapshot_seconds": 5, "max_groups": 20, "max_name_bytes": 256}
    values.update(overrides)
    return acquire_groups(**values)


class AcquisitionTests(unittest.TestCase):
    def test_additional_scope_paths_and_budgets_checked_before_any_process_open(self):
        with patch("catalog.read_selected_snapshots") as scanner:
            for arguments in ({"approve_contact_metadata": False}, {"account": "../another"},
                              {"root": r"c:\synthetic_root\other\db_storage"}, {"expected_file": None},
                              {"max_groups": 0}, {"max_name_bytes": 0}):
                with self.subTest(arguments=arguments), self.assertRaises(ReadError):
                    acquire(**arguments)
            scanner.assert_not_called()
        for arguments in ({"consent": Consent(ACCOUNT)}, {"scan_hits": 0}, {"scan_bytes": 0},
                          {"snapshot_bytes": 1}, {"vfs_profile": "unverified"}):
            with patch("catalog.NativeProcess") as process:
                with self.assertRaises(ReadError):
                    acquire(process_factory=process, **arguments)
                process.assert_not_called()

    def test_exact_one_contact_db_not_messages_other_accounts_or_members(self):
        data = image((("a@chatroom", "人工群", "private", "private"),))
        with patch("catalog.read_selected_snapshots", return_value=(Shard(ACCOUNT, "contact/contact.db", "g", data),)) as scan:
            self.assertEqual(acquire(), (GroupEntry("a@chatroom", "人工群"),))
            self.assertEqual(scan.call_args.kwargs["selected_databases"],
                {"contact/contact.db": ("contact/contact.db", FILE)})
            self.assertEqual(scan.call_args.kwargs["root"], ROOT)
        for account, shard in (("another", "contact/contact.db"), (ACCOUNT, "message/message_0.db")):
            with patch("catalog.read_selected_snapshots", return_value=(Shard(account, shard, "g", data),)):
                with self.assertRaisesRegex(ReadError, "CAPTURE_SCOPE_MISMATCH"):
                    acquire()

    def test_synthetic_key_scan_authenticated_contact_image_to_group_catalog(self):
        # Two small leaf pages, independently move cells to reserve the cipher trailer.
        plain = bytearray(image((("a@chatroom", "人工群 😀", "remark", "owner"),
                                 ("wxid_private", "PRIVATE_NICK", "PRIVATE_REMARK", "PRIVATE_OWNER"))))
        plain[18:20], plain[20] = b"\x02\x02", 80
        for offset in range(0, len(plain), PAGE_SIZE):
            page = bytearray(plain[offset:offset + PAGE_SIZE])
            header = 100 if offset == 0 else 0
            self.assertEqual(page[header], 13)
            count, start = struct.unpack_from(">HH", page, header + 3)
            page[start - 80:4016] = page[start:]
            page[4016:] = bytes(80)
            struct.pack_into(">H", page, header + 5, start - 80)
            for number in range(count):
                position = header + 8 + number * 2
                struct.pack_into(">H", page, position, struct.unpack_from(">H", page, position)[0] - 80)
            plain[offset:offset + PAGE_SIZE] = page
        key, salt = bytes(range(32)), bytes(range(16))
        encrypted = b"".join(cipher_fixtures.CipherTests.encrypt_test_page(key, salt, bytes(plain[offset:offset + PAGE_SIZE]),
            offset // PAGE_SIZE + 1) for offset in range(0, len(plain), PAGE_SIZE))
        wal = cipher_fixtures.make_wal([(2, 2, encrypted[PAGE_SIZE:])])
        calls = []
        class Capture:
            def __init__(self, *, profile):
                self_profile = profile
                if self_profile != SQLITE_WINDOWS_PROFILE:
                    raise AssertionError("wrong VFS")
            def capture(self, root, relative, **kwargs):
                calls.append((root, relative, kwargs["expected_identity"]))
                return SimpleNamespace(main=encrypted, wal=wal, identity=FILE)
        process = FakeProcess(key=key)
        result = acquire(process_factory=lambda _: process, snapshotter_factory=Capture)
        self.assertEqual(result, (GroupEntry("a@chatroom", "人工群 😀"),))
        self.assertEqual(calls, [(ROOT, "contact/contact.db", FILE)])
        self.assertTrue(process.closed)


if __name__ == "__main__":
    unittest.main()
