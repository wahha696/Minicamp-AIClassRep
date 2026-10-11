"""Synthetic data only. No process scanning, file inputs, chats or UI access."""
import ctypes
import hashlib
import hmac
import sqlite3
import struct
import sys
import unittest
from unittest.mock import patch

from cng import AesCbc, CryptoError
from reader import (Cursor, MemoryDatabase, PAGE_SIZE, PageCodec, ReadError, Reader,
                    SQLITE_HEADER, Scope, Shard, committed_wal_pages, decode_snapshot,
                    wal_checksum)

GROUP_A = "synthetic_A@chatroom"
GROUP_B = "synthetic_B@chatroom"
ACCOUNT = "synthetic_account_A"
MAX_BYTES = 1024 * 1024


def image(groups=None):
    """Build only an in-memory SQLite image in the candidate schema."""
    if groups is None:
        groups = {GROUP_A: [(1, 40, 1001, "synthetic message")]}
    db = sqlite3.connect(":memory:")
    try:
        db.execute("PRAGMA page_size=4096")
        for group, entries in groups.items():
            table = "Msg_" + hashlib.md5(group.encode()).hexdigest()
            db.execute(f'CREATE TABLE "{table}" (local_id INTEGER, sort_seq INTEGER, '
                       'server_id INTEGER, local_type INTEGER, real_sender_id INTEGER, '
                       'create_time INTEGER, message_content TEXT, compress_content BLOB)')
            for local_id, seq, server, body in entries:
                db.execute(f'INSERT INTO "{table}" VALUES (?, ?, ?, 1, 7, 1700000000, ?, NULL)',
                           (local_id, seq, server, body))
        db.commit()
        return db.serialize()
    finally:
        db.close()


def make_wal(frames, endian="<"):
    """Independent writer for artificial WAL fixtures; no on-disk DB/WAL."""
    magic = 0x377F0682 if endian == "<" else 0x377F0683
    header = struct.pack(">IIIIII", magic, 3007000, PAGE_SIZE, 0, 123, 456)
    # Intentionally separate implementation from the production checksum.
    def checksum(data, state):
        a, b = state
        words = struct.unpack(endian + "I" * (len(data) // 4), data)
        for i in range(0, len(words), 2):
            a = (a + words[i] + b) % (2 ** 32)
            b = (b + words[i + 1] + a) % (2 ** 32)
        return a, b
    state = checksum(header, (0, 0))
    result = header + struct.pack(">II", *state)
    for n, size, page in frames:
        first8 = struct.pack(">II", n, size)
        state = checksum(first8 + page, state)
        result += first8 + header[16:24] + struct.pack(">II", *state) + page
    return result


def raw_decode(page, _number):
    return page


def reserved_image(groups=None):
    """Relocate small fixture leaf cells to leave SQLCipher's 80-byte reserve.

    Fixture-only: two small table-leaf pages, no free blocks or overflow pages.
    SQLite itself validates and queries the resulting image in integration tests.
    """
    data = bytearray(image(groups))
    data[20] = 80
    for offset in range(0, len(data), PAGE_SIZE):
        page = bytearray(data[offset:offset + PAGE_SIZE])
        header = 100 if offset == 0 else 0
        if page[header] != 13 or page[header + 1:header + 3] != b"\x00\x00":
            raise AssertionError("unexpected synthetic SQLite fixture")
        count = struct.unpack_from(">H", page, header + 3)[0]
        start = struct.unpack_from(">H", page, header + 5)[0]
        payload = page[start:]
        page[start - 80:4016] = payload
        page[4016:] = bytes(80)
        struct.pack_into(">H", page, header + 5, start - 80)
        for i in range(count):
            pointer = header + 8 + i * 2
            cell = struct.unpack_from(">H", page, pointer)[0]
            struct.pack_into(">H", page, pointer, cell - 80)
        data[offset:offset + PAGE_SIZE] = page
    return bytes(data)


def engine(groups=(GROUP_A,), manifest=None):
    if manifest is None:
        manifest = {"shard_A": "generation_A"}
    return Reader(Scope(ACCOUNT, groups), manifest,
                  {(s, g): Cursor(0, 0) for s in manifest for g in groups})


def shard(data=None, account=ACCOUNT, name="shard_A", generation="generation_A"):
    return Shard(account, name, generation, image() if data is None else data)


class BatchTests(unittest.TestCase):
    def test_n1_save_failure_does_not_advance_and_retry_reuses_event_id(self):
        reader, seen = engine(), []
        original = reader.cursors
        def fail(events, _cursors):
            seen.append(events[0].event_id)
            raise OSError("synthetic body must not appear in error")
        with self.assertRaisesRegex(ReadError, "^BATCH_NOT_ACKNOWLEDGED$"):
            reader.deliver((shard(),), fail, limit=10)
        self.assertEqual(original, reader.cursors)
        def accept(events, cursors):
            seen.append(events[0].event_id)
            self.assertEqual(Cursor(40, 1), cursors[("shard_A", GROUP_A)])
            return True
        saved = reader.deliver((shard(),), accept, limit=10)
        self.assertEqual(seen[0], seen[1])
        self.assertEqual(1, len(saved))
        self.assertEqual((), reader.deliver((shard(),), accept, limit=10))

    def test_truthy_non_boolean_ack_is_rejected(self):
        reader = engine()
        original = reader.cursors
        for answer in (False, None, 1, "ok"):
            with self.subTest(answer=answer):
                with self.assertRaises(ReadError):
                    reader.deliver((shard(),), lambda *_: answer, limit=10)
                self.assertEqual(original, reader.cursors)

    def test_n2_broken_shard_prevents_any_batch_delivery(self):
        reader = engine(manifest={"shard_A": "generation_A", "shard_B": "generation_B"})
        called = []
        snapshots = (shard(), shard(b"not a database", name="shard_B", generation="generation_B"))
        original = reader.cursors
        with self.assertRaises(ReadError):
            reader.deliver(snapshots, lambda *_: called.append(True), limit=10)
        self.assertEqual([], called)
        self.assertEqual(original, reader.cursors)

    def test_n3_explicit_account_cannot_fall_back(self):
        reader = engine()
        with self.assertRaisesRegex(ReadError, "ACCOUNT_MISMATCH"):
            reader.deliver((shard(account="synthetic_account_B"),), lambda *_: True, limit=10)
        self.assertEqual(Cursor(0, 0), reader.cursors[("shard_A", GROUP_A)])

    def test_group_filter_never_returns_other_group(self):
        db = image({GROUP_A: [(1, 40, 1001, "allowed")], GROUP_B: [(2, 41, 1002, "private other group")]})
        events = engine().deliver((shard(db),), lambda *_: True, limit=10)
        self.assertEqual(["allowed"], [e.content for e in events])
        self.assertNotIn("allowed", repr(events[0]))

    def test_equal_sort_sequences_across_shards_and_batch_boundaries(self):
        reader = engine(manifest={"shard_A": "generation_A", "shard_B": "generation_B"})
        snapshots = (shard(image({GROUP_A: [(1, 40, 1001, "a"), (2, 40, 1002, "b")]})),
                     shard(image({GROUP_A: [(1, 40, 1003, "c")]}),
                           name="shard_B", generation="generation_B"))
        received = []
        for _ in range(4):
            received.extend(reader.deliver(snapshots, lambda *_: True, limit=1))
        self.assertEqual(3, len(received))
        self.assertEqual(3, len({e.event_id for e in received}))
        self.assertEqual({"a", "b", "c"}, {e.content for e in received})

    def test_shard_loss_addition_and_recreation_require_explicit_reset(self):
        reader = engine()
        cases = ((), (shard(), shard(name="unexpected")), (shard(generation="generation_B"),))
        for snapshots in cases:
            with self.subTest(count=len(snapshots)):
                with self.assertRaises(ReadError):
                    reader.deliver(snapshots, lambda *_: True, limit=10)

    def test_missing_selected_group_is_an_error(self):
        with self.assertRaisesRegex(ReadError, "SELECTED_GROUP_NOT_FOUND"):
            engine().deliver((shard(image({GROUP_B: []})),), lambda *_: True, limit=10)

    def test_same_server_identity_across_shards_is_stable_for_sink_dedup(self):
        reader = engine(manifest={"shard_A": "generation_A", "shard_B": "generation_B"})
        snapshots = (shard(), shard(name="shard_B", generation="generation_B"))
        events = reader.deliver(snapshots, lambda *_: True, limit=10)
        self.assertEqual(2, len(events))
        self.assertEqual(events[0].event_id, events[1].event_id)

    def test_local_identity_without_server_id_includes_shard_generation(self):
        data = image({GROUP_A: [(1, 40, 0, "a")]})
        reader = engine(manifest={"shard_A": "generation_A", "shard_B": "generation_B"})
        events = reader.deliver((shard(data), shard(data, name="shard_B", generation="generation_B")),
                                lambda *_: True, limit=10)
        self.assertNotEqual(events[0].event_id, events[1].event_id)

    def test_reentrant_callback_is_rejected_without_advancing(self):
        reader = engine()
        def sink(*_):
            reader.deliver((shard(),), lambda *_: True, limit=10)
        with self.assertRaisesRegex(ReadError, "BATCH_NOT_ACKNOWLEDGED"):
            reader.deliver((shard(),), sink, limit=10)
        self.assertEqual(Cursor(0, 0), reader.cursors[("shard_A", GROUP_A)])

    def test_scope_and_initial_cursors_must_be_explicit(self):
        for scope_args in (("", (GROUP_A,)), (ACCOUNT, ()), (ACCOUNT, (GROUP_A, GROUP_A)),
                           (ACCOUNT, ("private_user",)), (ACCOUNT, [GROUP_A])):
            with self.assertRaises(ReadError):
                Scope(*scope_args)
        with self.assertRaises(ReadError):
            Reader(Scope(ACCOUNT, (GROUP_A,)), {"shard_A": "generation_A"}, {})


class SnapshotTests(unittest.TestCase):
    def test_n4_uncommitted_tail_is_not_visible_after_valid_commit(self):
        old, committed, uncommitted = (image({GROUP_A: [(1, 40, 1001, value)]})
                                       for value in ("old", "yes", "bad"))
        self.assertEqual(len(old), len(committed))
        wal = make_wal([(2, 2, committed[PAGE_SIZE:]), (2, 0, uncommitted[PAGE_SIZE:])])
        decoded = decode_snapshot(old, wal, raw_decode, max_bytes=MAX_BYTES)
        events = engine().deliver((shard(bytes(decoded)),), lambda *_: True, limit=10)
        self.assertEqual("yes", events[0].content)

    def test_wal_without_any_commit_leaves_main_unchanged(self):
        old, new = image(), image({GROUP_A: [(1, 40, 1001, "pending")]})
        result = decode_snapshot(old, make_wal([(2, 0, new[PAGE_SIZE:])]), raw_decode, max_bytes=MAX_BYTES)
        self.assertEqual(old, result)

    def test_header_and_frame_checksums_are_both_required(self):
        wal = make_wal([(2, 2, image()[PAGE_SIZE:])])
        for offset, code in ((24, "WAL_HEADER_CHECKSUM"), (48, "WAL_FRAME_CHECKSUM"),
                             (len(wal) - 1, "WAL_FRAME_CHECKSUM")):
            bad = bytearray(wal)
            bad[offset] ^= 1
            with self.assertRaisesRegex(ReadError, code):
                committed_wal_pages(bytes(bad), MAX_BYTES)

    def test_both_wal_checksum_byte_orders(self):
        for endian in ("<", ">"):
            overlay = committed_wal_pages(make_wal([(2, 2, image()[PAGE_SIZE:])], endian), MAX_BYTES)
            self.assertEqual(2, overlay.size)
            self.assertEqual(image()[PAGE_SIZE:], overlay.pages[2])
        self.assertEqual((3, 7), wal_checksum(struct.pack("<II", 3, 4), "<"))

    def test_partial_current_generation_frame_blocks_read(self):
        wal = make_wal([(2, 2, image()[PAGE_SIZE:]), (2, 0, image()[PAGE_SIZE:])])
        with self.assertRaisesRegex(ReadError, "WAL_PARTIAL_FRAME"):
            committed_wal_pages(wal[:-1], MAX_BYTES)

    def test_stale_generation_tail_stops_after_verified_commit(self):
        wal = bytearray(make_wal([(2, 2, image()[PAGE_SIZE:]), (2, 0, image()[PAGE_SIZE:])]))
        wal[32 + 24 + PAGE_SIZE + 8] ^= 1
        overlay = committed_wal_pages(bytes(wal), MAX_BYTES)
        self.assertEqual(2, overlay.size)
        # A mismatched first frame is not an excuse to use stale main data.
        wal[40] ^= 1
        with self.assertRaisesRegex(ReadError, "WAL_GENERATION_MISMATCH"):
            committed_wal_pages(bytes(wal), MAX_BYTES)

    def test_committed_shrink_removes_pages(self):
        old = image()
        wal = make_wal([(1, 1, old[:PAGE_SIZE])])
        result = decode_snapshot(old, wal, raw_decode, max_bytes=MAX_BYTES)
        self.assertEqual(PAGE_SIZE, len(result))
        self.assertEqual(1, struct.unpack_from(">I", result, 28)[0])

    def test_shrink_then_growth_cannot_resurrect_old_main_page(self):
        old = image()
        wal = make_wal([(1, 1, old[:PAGE_SIZE]), (1, 2, old[:PAGE_SIZE])])
        with self.assertRaisesRegex(ReadError, "SNAPSHOT_MISSING_PAGE"):
            decode_snapshot(old, wal, raw_decode, max_bytes=MAX_BYTES)

    def test_missing_growth_page_partial_main_and_budget_are_errors(self):
        old = image()
        cases = ((old, make_wal([(1, 3, old[:PAGE_SIZE])]), MAX_BYTES),
                 (old[:-1], b"", MAX_BYTES), (old, b"", PAGE_SIZE))
        for main, wal, budget in cases:
            with self.assertRaises(ReadError):
                decode_snapshot(main, wal, raw_decode, max_bytes=budget)

    def test_wal_mode_is_converted_only_for_in_memory_snapshot(self):
        main = bytearray(image())
        main[18:20] = b"\x02\x02"
        result = decode_snapshot(bytes(main), b"", raw_decode, max_bytes=MAX_BYTES)
        self.assertEqual(b"\x02\x02", main[18:20])
        with MemoryDatabase(result) as db:
            self.assertEqual(1, db.query("SELECT count(*) FROM sqlite_master WHERE type='table'")[0][0])


class MemoryBoundaryTests(unittest.TestCase):
    def test_no_python_file_io_or_non_memory_sqlite_connections(self):
        fixture = image()
        connect = sqlite3.connect
        calls = []
        def memory_only(target, *args, **kwargs):
            self.assertEqual(":memory:", target)
            calls.append(target)
            return connect(target, *args, **kwargs)
        with patch("builtins.open", side_effect=AssertionError("file IO forbidden")), \
             patch("sqlite3.connect", side_effect=memory_only):
            decoded = decode_snapshot(fixture, b"", raw_decode, max_bytes=MAX_BYTES)
            engine().deliver((shard(bytes(decoded)),), lambda *_: True, limit=10)
        self.assertEqual([":memory:"], calls)

    def test_writes_attach_vacuum_extension_and_temp_pragmas_are_denied(self):
        with MemoryDatabase(image()) as db:
            queries = ("CREATE TABLE forbidden(x)", "ATTACH DATABASE 'forbidden.db' AS other",
                       "VACUUM INTO 'forbidden.db'", "PRAGMA temp_store=FILE",
                       "SELECT load_extension('forbidden')", "PRAGMA query_only=OFF")
            for sql in queries:
                with self.subTest(sql=sql):
                    with self.assertRaises(ReadError):
                        db.query(sql)
            self.assertEqual(1, db.query("SELECT count(*) FROM sqlite_master WHERE type='table'")[0][0])

    def test_connection_closes_and_errors_do_not_leak_parameters(self):
        db = MemoryDatabase(image())
        with self.assertRaisesRegex(ReadError, "^SQLITE_QUERY_FAILED$"):
            db.query("SELECT does_not_exist(?)", ("synthetic secret",))
        db.close()
        with self.assertRaisesRegex(ReadError, "SQLITE_CLOSED"):
            db.query("SELECT 1")


@unittest.skipUnless(sys.platform == "win32", "Windows CNG required")
class CipherTests(unittest.TestCase):
    def test_aes256_cbc_known_answer_and_closed_key(self):
        # NIST SP 800-38A F.2.5/6, AES-256 CBC (public test vector).
        key = bytes.fromhex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4")
        iv = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
        ciphertext = bytes.fromhex("f58c4c04d6e5f1ba779eabfb5f7bfbd6"
                                   "9cfc4e967edb808d679f777bc6702c7d"
                                   "39f23369a9d9bacfa530e26304231461"
                                   "b2eb05e2c39be9fcda6c19078c6a9d1b")
        plain = bytes.fromhex("6bc1bee22e409f96e93d7e117393172a"
                              "ae2d8a571e03ac9c9eb76fac45af8e51"
                              "30c81c46a35ce411e5fbc1191a0a52ef"
                              "f69f2445df4f9b17ad2b417be66c3710")
        aes = AesCbc(key)
        with aes:
            self.assertEqual(plain, aes.decrypt(iv, ciphertext))
            self.assertEqual(plain, aes.decrypt(iv, ciphertext))  # Fresh mutable IV.
            with self.assertRaises(CryptoError):
                aes.decrypt(iv, ciphertext[:-1])
        with self.assertRaises(CryptoError):
            aes.decrypt(iv, ciphertext)

    @staticmethod
    def encrypt_test_page(key, salt, plain, pgno, explicit=False):
        # Test-only use of BCryptEncrypt, never used by the read core.
        iv = bytes(range(16))
        start = 16 if pgno == 1 else 0
        data = plain[start:4016]
        with AesCbc(key) as aes:
            fn = aes._api.BCryptEncrypt
            fn.argtypes = aes._api.BCryptDecrypt.argtypes
            fn.restype = ctypes.c_long
            src = ctypes.create_string_buffer(data, len(data))
            vec = ctypes.create_string_buffer(iv, 16)
            out = ctypes.create_string_buffer(len(data))
            count = ctypes.c_ulong()
            aes._check(fn(aes._key, src, len(data), None, vec, 16, out, len(data), ctypes.byref(count), 0))
            encrypted = out.raw
        prefix = (SQLITE_HEADER if explicit else salt) if pgno == 1 else b""
        page = prefix + encrypted + iv
        mac_key = hashlib.pbkdf2_hmac("sha512", key, bytes(v ^ 0x3A for v in salt), 2, 32)
        return page + hmac.new(mac_key, page[start:] + struct.pack("<I", pgno), "sha512").digest()

    def test_page_hmac_checks_every_page_and_its_number_before_decryption(self):
        key, salt = bytes(range(32)), bytes(range(16))
        plain1, plain2 = image()[:PAGE_SIZE], bytes(range(256)) * 16
        page1 = self.encrypt_test_page(key, salt, plain1, 1)
        page2 = self.encrypt_test_page(key, salt, plain2, 2)
        with PageCodec(key, page1) as codec:
            self.assertEqual(plain1[:4016] + bytes(80), codec.decrypt(page1, 1))
            self.assertEqual(plain2[:4016] + bytes(80), codec.decrypt(page2, 2))
            with self.assertRaisesRegex(ReadError, "PAGE_AUTHENTICATION_FAILED"):
                codec.decrypt(page2, 3)
            corrupt = bytearray(page2)
            corrupt[100] ^= 1
            with self.assertRaisesRegex(ReadError, "PAGE_AUTHENTICATION_FAILED"):
                codec.decrypt(bytes(corrupt), 2)
        self.assertEqual(bytearray(), codec._mac_key)
        with self.assertRaises(ReadError):
            codec.decrypt(page2, 2)

    def test_explicit_salt_layout_and_wrong_key(self):
        key, salt = bytes(range(32)), bytes(range(16))
        plain = image()[:PAGE_SIZE]
        page = self.encrypt_test_page(key, salt, plain, 1, explicit=True)
        with PageCodec(key + salt, page) as codec:
            self.assertEqual(plain[:4016] + bytes(80), codec.decrypt(page, 1))
        with self.assertRaisesRegex(ReadError, "PAGE_AUTHENTICATION_FAILED"):
            PageCodec(bytes(32) + salt, page)

    def test_encrypted_reserved_pages_through_memory_sqlite_and_group_reader(self):
        key, salt = bytes(range(32)), bytes(range(16))
        plain = reserved_image()
        encrypted = b"".join(self.encrypt_test_page(key, salt, plain[o:o + PAGE_SIZE], o // PAGE_SIZE + 1)
                             for o in range(0, len(plain), PAGE_SIZE))
        with PageCodec(key, encrypted[:PAGE_SIZE]) as codec:
            decoded = decode_snapshot(encrypted, b"", codec.decrypt, max_bytes=MAX_BYTES)
            events = engine().deliver((shard(bytes(decoded)),), lambda *_: True, limit=10)
        self.assertEqual(1, len(events))
        self.assertEqual("synthetic message", events[0].content)
        self.assertEqual(80, decoded[20])

    def test_wrong_later_page_never_reaches_consumer(self):
        key, salt = bytes(range(32)), bytes(range(16))
        plain = reserved_image()
        encrypted = bytearray(b"".join(
            self.encrypt_test_page(key, salt, plain[o:o + PAGE_SIZE], o // PAGE_SIZE + 1)
            for o in range(0, len(plain), PAGE_SIZE)))
        encrypted[PAGE_SIZE + 100] ^= 1
        called = []
        with PageCodec(key, bytes(encrypted[:PAGE_SIZE])) as codec:
            with self.assertRaisesRegex(ReadError, "PAGE_AUTHENTICATION_FAILED"):
                decoded = decode_snapshot(bytes(encrypted), b"", codec.decrypt, max_bytes=MAX_BYTES)
                engine().deliver((shard(bytes(decoded)),), lambda *_: called.append(True), limit=10)
        self.assertEqual([], called)


if __name__ == "__main__":
    unittest.main()
