"""Synthetic local delivery tests and explicitly bounded cross-language fixture."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from delivery import batch_id, deliver_once, group_id, prepare_delivery, split_sender
from reader import Cursor, ReadError, Scope
from receipts import LocalReceipts, SUFFIX, VERSION
from test_reader import ACCOUNT, GROUP_A, image, shard
from test_textdecode import raw_frame
from textdecode import ZstdDecoder

SCOPE = Scope(ACCOUNT, (GROUP_A,))
MANIFEST = {"shard_A": "generation_A"}
BASE = {("shard_A", GROUP_A): Cursor(0, 0)}
DESTINATION = "synthetic-workspace-A"


def names(group, sender):
    return "测试群 😀", "人工成员"


def open_store(path):
    return LocalReceipts(path, SCOPE, MANIFEST, allow_selected_message_storage=True)


def seed(store, count=1, text="明天下午两点交人工测试作业"):
    store.initialize(BASE)
    reader = store.restore_reader()
    rows = [(i, i, 1000 + i, text) for i in range(1, count + 1)]
    snapshots = (shard(image({GROUP_A: rows})),)
    while reader.deliver(snapshots, store.sink(reader), limit=100):
        pass


def ack(document, *, inserted=None, replayed=False):
    return {"version": 1, "destination": document["destination"],
        "wechat_account": document["wechat_account"], "batch_id": document["batch_id"],
        "event_ids": [m["event_id"] for m in document["messages"]], "accepted": True,
        "inserted": len(document["messages"]) if inserted is None else inserted,
        "replayed": replayed}


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        research = Path(__file__).resolve().parents[2] / ".review-research"
        research.mkdir(exist_ok=True)
        self.folder = tempfile.TemporaryDirectory(prefix="synthetic-wechat-delivery-", dir=research)
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / ("source" + SUFFIX)
        self.store = open_store(self.path)
        self.addCleanup(self.store.close)

    def test_sender_prefix_is_split_from_group_text(self):
        self.assertEqual(split_sender("wxid_33cd03o22:\n所有人注意"), ("wxid_33cd03o22", "所有人注意"))
        self.assertEqual(split_sender("custom_alias-1:\n多行\n正文"), ("custom_alias-1", "多行\n正文"))
        self.assertEqual(split_sender("我自己发的"), (None, "我自己发的"))
        self.assertEqual(split_sender("注意:\n不是发信人"), (None, "注意:\n不是发信人"))

    def test_sender_name_resolved_from_prefix_and_prefix_removed(self):
        seed(self.store, text="wxid_member:\n明天下午两点交作业")
        seen = []
        def resolve(group, sender):
            seen.append(sender); return "测试群", "班长备注"
        message = prepare_delivery(self.store, DESTINATION, resolve).document["messages"][0]
        self.assertEqual(seen, ["wxid_member"])
        self.assertEqual((message["sender_name"], message["text"]), ("班长备注", "明天下午两点交作业"))

    def test_text_time_names_namespace_and_ack_persist_across_reopen(self):
        seed(self.store)
        batch = prepare_delivery(self.store, DESTINATION, names)
        self.assertEqual(batch_id(batch.document), batch.document["batch_id"])
        self.assertEqual(1700000000000, batch.document["messages"][0]["sent_at"])
        self.assertEqual("测试群 😀", batch.document["messages"][0]["group_name"])
        self.assertTrue(group_id(ACCOUNT, GROUP_A).startswith("wechat:"))
        self.assertNotEqual(group_id(ACCOUNT, GROUP_A), group_id("other", GROUP_A))
        batch.acknowledge(self.store, ack(batch.document))
        self.store.close()
        with open_store(self.path) as reopened:
            self.assertIsNone(prepare_delivery(reopened, DESTINATION, names))
            self.assertEqual(1, len(reopened.stored_messages(limit=100)))
            self.assertEqual(Cursor(1, 1), reopened.restore_reader().cursors[("shard_A", GROUP_A)])

    def test_lost_transport_ack_keeps_pending_and_reuses_batch(self):
        seed(self.store)
        before = prepare_delivery(self.store, DESTINATION, names).document["batch_id"]
        def fail(_):
            raise OSError("synthetic private error")
        with self.assertRaisesRegex(ReadError, "^DELIVERY_NOT_ACKNOWLEDGED$"):
            deliver_once(self.store, DESTINATION, names, fail)
        self.assertEqual(before, prepare_delivery(self.store, DESTINATION, names).document["batch_id"])
        self.assertEqual({"delivered": 1, "inserted": 0, "replayed": True, "has_more": False, "deferred": 0},
            deliver_once(self.store, DESTINATION, names, lambda d: ack(d, inserted=0, replayed=True)))

    def test_ack_validation_rejects_other_destinations_accounts_ids_and_truthy_values(self):
        seed(self.store)
        batch = prepare_delivery(self.store, DESTINATION, names)
        original = ack(batch.document)
        for key, value in (("destination", "other"), ("wechat_account", "other"),
            ("batch_id", "a" * 64), ("event_ids", []), ("accepted", 1),
            ("version", True), ("inserted", True), ("inserted", 2), ("replayed", 1)):
            with self.subTest(key=key), self.assertRaisesRegex(ReadError, "ACK_MISMATCH"):
                batch.acknowledge(self.store, {**original, key: value})
        self.assertEqual(1, len(self.store.pending_delivery(DESTINATION, limit=100)))

    def test_ack_rows_rollback_on_local_failure_then_can_retry(self):
        seed(self.store, count=2)
        batch = prepare_delivery(self.store, DESTINATION, names)
        def fail(phase):
            if phase == "after_delivery_ack_rows":
                raise OSError("synthetic write failure")
        with patch.object(self.store, "_checkpoint", side_effect=fail), self.assertRaises(OSError):
            batch.acknowledge(self.store, ack(batch.document))
        self.assertEqual(2, len(self.store.pending_delivery(DESTINATION, limit=100)))
        batch.acknowledge(self.store, ack(batch.document))
        self.assertEqual((), self.store.pending_delivery(DESTINATION, limit=100))

    def test_ack_after_commit_failure_is_safe_on_reopen(self):
        seed(self.store)
        batch = prepare_delivery(self.store, DESTINATION, names)
        def fail(phase):
            if phase == "after_delivery_ack_commit":
                raise OSError("synthetic confirmation lost")
        with patch.object(self.store, "_checkpoint", side_effect=fail), self.assertRaises(OSError):
            batch.acknowledge(self.store, ack(batch.document))
        self.store.close()
        with open_store(self.path) as reopened:
            self.assertIsNone(prepare_delivery(reopened, DESTINATION, names))

    def test_one_destination_ack_does_not_ack_another_or_delete_raw_message(self):
        seed(self.store)
        batch = prepare_delivery(self.store, DESTINATION, names)
        batch.acknowledge(self.store, ack(batch.document))
        self.assertEqual(1, len(self.store.pending_delivery("other-space", limit=100)))
        self.assertEqual(1, len(self.store.stored_messages(limit=100)))

    def test_one_hundred_message_limit_and_total_text_limit_make_smaller_batches(self):
        seed(self.store, count=125)
        first = prepare_delivery(self.store, DESTINATION, names)
        self.assertEqual(100, len(first.document["messages"]))
        first.acknowledge(self.store, ack(first.document))
        self.assertEqual(25, len(prepare_delivery(self.store, DESTINATION, names).document["messages"]))
        self.store.close()
        self.path = self.path.with_name("large" + SUFFIX)
        self.store = open_store(self.path)
        self.addCleanup(self.store.close)
        seed(self.store, count=6, text="x" * 262144)
        batch = prepare_delivery(self.store, DESTINATION, names)
        self.assertEqual(4, len(batch.document["messages"]))

    def test_undecoded_or_nontext_fields_are_retained_unacknowledged(self):
        seed(self.store, text=b"\xffsynthetic")
        self.assertIsNone(prepare_delivery(self.store, DESTINATION, names))
        issue = self.store.delivery_issues(DESTINATION, limit=100)[0]
        self.assertEqual('DELIVERY_TEXT_NOT_DECODED', issue['reason'])
        self.store._conn.execute("UPDATE receipt_messages SET content='text',kind=3")
        self.store.retry_delivery_issues(DESTINATION, (issue['event_id'],))
        self.assertIsNone(prepare_delivery(self.store, DESTINATION, names))
        self.assertEqual('DELIVERY_MESSAGE_TYPE_UNSUPPORTED', self.store.delivery_issues(DESTINATION, limit=100)[0]['reason'])
        self.assertEqual(1, len(self.store.pending_delivery(DESTINATION, limit=100, include_issues=True)))

    @unittest.skipUnless(os.environ.get('WECHAT4_TEST_ZSTD_LIBRARY'), 'Explicit local Zstd library required')
    def test_compressed_text_and_conflicting_fields_do_not_guess_or_lose_raw_message(self):
        decoder = ZstdDecoder(os.environ['WECHAT4_TEST_ZSTD_LIBRARY'],
            max_input_bytes=262144, max_output_bytes=262144, max_window_log=18)
        text = ' \n人工中文 😀\x00\n '
        seed(self.store, text=raw_frame(text.encode()))
        batch = prepare_delivery(self.store, DESTINATION, names, zstd=decoder)
        self.assertEqual(text, batch.document['messages'][0]['text'])
        self.store._conn.execute('UPDATE receipt_messages SET compressed_content=?',
            (raw_frame(b'other synthetic text'),))
        self.assertIsNone(prepare_delivery(self.store, DESTINATION, names, zstd=decoder))
        issue = self.store.delivery_issues(DESTINATION, limit=100)[0]
        self.assertEqual('DELIVERY_TEXT_CONFLICT', issue['reason'])
        self.assertEqual(1, len(self.store.pending_delivery(DESTINATION, limit=100, include_issues=True)))
        self.store._conn.execute('UPDATE receipt_messages SET content=NULL,compressed_content=?',
            (raw_frame(text.encode()),))
        self.store.retry_delivery_issues(DESTINATION, (issue['event_id'],))
        batch = prepare_delivery(self.store, DESTINATION, names, zstd=decoder)
        self.assertEqual(text, batch.document['messages'][0]['text'])
        batch.acknowledge(self.store, ack(batch.document))
        self.assertEqual(1, len(self.store.stored_messages(limit=100)))

    def test_unknown_or_invalid_local_ack_cannot_remove_pending_records(self):
        seed(self.store)
        with self.assertRaisesRegex(ReadError, "UNKNOWN_EVENT"):
            self.store.acknowledge_delivery(DESTINATION, "b" * 64, ("a" * 64,))
        self.assertEqual(1, len(self.store.pending_delivery(DESTINATION, limit=100)))

    def test_exact_v1_migration_keeps_messages_cursors_and_initializes_pending(self):
        seed(self.store)
        before = self.store.restore_reader().cursors
        self.store._conn.execute("DROP TABLE receipt_activation")
        self.store._conn.execute("DROP TABLE receipt_delivery_issues")
        self.store._conn.execute("DROP TABLE receipt_deliveries")
        self.store._conn.execute("PRAGMA user_version=1")
        self.store.close()
        with open_store(self.path) as reopened:
            self.assertEqual(VERSION, reopened._conn.execute("PRAGMA user_version").fetchone()[0])
            self.assertEqual(before, reopened.restore_reader().cursors)
            self.assertEqual(1, len(reopened.pending_delivery(DESTINATION, limit=100)))

    def test_mixed_messages_across_candidate_pages_do_not_starve_normal_text(self):
        seed(self.store, count=250)
        self.store._conn.execute('UPDATE receipt_messages SET kind=3 WHERE event_id IN '
            '(SELECT event_id FROM receipt_messages ORDER BY timestamp,event_id LIMIT 220)')
        result = deliver_once(self.store, DESTINATION, names, lambda doc: ack(doc))
        self.assertEqual({'delivered': 30, 'inserted': 30, 'replayed': False,
                          'has_more': False, 'deferred': 220}, result)
        self.assertEqual(250, len(self.store.stored_messages(limit=1000)))
        issue = self.store.delivery_issues(DESTINATION, limit=100)[0]
        self.assertEqual({'event_id', 'group_id', 'reason'}, set(issue))

    def test_scan_budget_yields_then_continues_past_over_one_thousand_unsupported_rows(self):
        seed(self.store, count=1051)
        self.store._conn.execute('UPDATE receipt_messages SET kind=3 WHERE event_id IN '
            '(SELECT event_id FROM receipt_messages ORDER BY timestamp,event_id LIMIT 1050)')
        first = deliver_once(self.store, DESTINATION, names, lambda _: self.fail('no text yet'))
        self.assertEqual({'delivered': 0, 'inserted': 0, 'replayed': False,
                          'has_more': True, 'deferred': 1000}, first)
        second = deliver_once(self.store, DESTINATION, names, lambda doc: ack(doc))
        self.assertEqual(1, second['delivered'])
        self.assertEqual(1050, second['deferred'])
        self.assertFalse(second['has_more'])

    def test_deferred_records_survive_reopen_and_require_explicit_retry(self):
        seed(self.store, text=b'\xffsynthetic')
        before = self.store.restore_reader().cursors
        prepare_delivery(self.store, DESTINATION, names)
        issue = self.store.delivery_issues(DESTINATION, limit=100)[0]
        self.store.close()
        with open_store(self.path) as reopened:
            with patch('delivery._text') as decode:
                self.assertIsNone(prepare_delivery(reopened, DESTINATION, names))
                decode.assert_not_called()
            self.assertEqual(before, reopened.restore_reader().cursors)
            reopened._conn.execute("UPDATE receipt_messages SET content='fixed synthetic'")
            reopened.retry_delivery_issues(DESTINATION, (issue['event_id'],))
            result = deliver_once(reopened, DESTINATION, names, lambda doc: ack(doc))
            self.assertEqual(1, result['delivered'])
            self.assertEqual(0, result['deferred'])
            self.assertEqual(1, len(reopened.stored_messages(limit=100)))

    def test_issue_write_failure_is_not_acknowledged_and_source_progress_is_unchanged(self):
        seed(self.store, text=b'\xffsynthetic')
        before = self.store.restore_reader().cursors
        def fail(phase):
            if phase == 'after_delivery_issue_rows':
                raise OSError('synthetic write failure')
        with patch.object(self.store, '_checkpoint', side_effect=fail), self.assertRaises(OSError):
            prepare_delivery(self.store, DESTINATION, names)
        self.assertEqual({'pending': 1, 'deferred': 0}, self.store.delivery_status(DESTINATION))
        self.assertEqual(before, self.store.restore_reader().cursors)
        self.assertEqual(1, len(self.store.stored_messages(limit=100)))

    def test_retry_unknown_ids_or_write_failure_keeps_entire_issue_batch(self):
        seed(self.store, count=2, text=b'\xffsynthetic')
        prepare_delivery(self.store, DESTINATION, names)
        ids = tuple(row['event_id'] for row in self.store.delivery_issues(DESTINATION, limit=100))
        with self.assertRaisesRegex(ReadError, 'RETRY_NOT_FOUND'):
            self.store.retry_delivery_issues(DESTINATION, (ids[0], 'f' * 64))
        def fail(phase):
            if phase == 'after_delivery_retry_rows':
                raise OSError('synthetic retry failure')
        with patch.object(self.store, '_checkpoint', side_effect=fail), self.assertRaises(OSError):
            self.store.retry_delivery_issues(DESTINATION, ids)
        self.assertEqual({'pending': 0, 'deferred': 2}, self.store.delivery_status(DESTINATION))

    def test_deferred_message_cannot_be_acknowledged_by_an_older_prepared_batch(self):
        seed(self.store)
        batch = prepare_delivery(self.store, DESTINATION, names)
        event = batch.document['messages'][0]['event_id']
        self.store.defer_delivery(DESTINATION, event, 'DELIVERY_TEXT_CONFLICT')
        with self.assertRaisesRegex(ReadError, 'DEFERRED_EVENT'):
            batch.acknowledge(self.store, ack(batch.document))
        self.assertEqual({'pending': 0, 'deferred': 1}, self.store.delivery_status(DESTINATION))

    def test_v2_upgrade_preserves_existing_delivery_acknowledgements(self):
        seed(self.store, count=2)
        batch = prepare_delivery(self.store, DESTINATION, names)
        ids = tuple(m['event_id'] for m in batch.document['messages'])
        self.store.acknowledge_delivery(DESTINATION, batch.document['batch_id'], (ids[0],))
        self.store._conn.execute('DROP TABLE receipt_activation')
        self.store._conn.execute('DROP TABLE receipt_delivery_issues')
        self.store._conn.execute('PRAGMA user_version=2')
        self.store.close()
        with open_store(self.path) as reopened:
            self.assertEqual({'pending': 1, 'deferred': 0}, reopened.delivery_status(DESTINATION))
            self.assertEqual(ids[1], reopened.pending_delivery(DESTINATION, limit=100)[0].event_id)
            self.assertEqual(2, len(reopened.stored_messages(limit=100)))

    def test_wrong_binding_does_not_upgrade_another_accounts_v2_receipts(self):
        seed(self.store)
        self.store._conn.execute('DROP TABLE receipt_activation')
        self.store._conn.execute('DROP TABLE receipt_delivery_issues')
        self.store._conn.execute('PRAGMA user_version=2')
        self.store.close()
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ReadError, 'BINDING_MISMATCH'):
            LocalReceipts(self.path, Scope('synthetic_other_account', (GROUP_A,)), MANIFEST,
                          allow_selected_message_storage=True)
        self.assertEqual(before, self.path.read_bytes())
        with open_store(self.path) as reopened:
            self.assertEqual({'pending': 1, 'deferred': 0}, reopened.delivery_status(DESTINATION))

    def test_issue_and_retry_are_scoped_to_explicit_destination(self):
        seed(self.store)
        def fail(*_):
            raise OSError('synthetic names unavailable')
        self.assertIsNone(prepare_delivery(self.store, DESTINATION, fail))
        self.assertEqual(1, self.store.delivery_status(DESTINATION)['deferred'])
        other = prepare_delivery(self.store, 'other-space', names)
        other.acknowledge(self.store, ack(other.document))
        self.assertEqual({'pending': 0, 'deferred': 0}, self.store.delivery_status('other-space'))
        self.assertEqual(1, self.store.delivery_status(DESTINATION)['deferred'])

    def test_invalid_retry_keys_and_unknown_reason_cannot_hide_pending_rows(self):
        seed(self.store)
        for ids in ([], ([],), ('bad',), ('a' * 64, 'a' * 64)):
            with self.subTest(ids=ids), self.assertRaisesRegex(ReadError, 'RETRY_INVALID'):
                self.store.retry_delivery_issues(DESTINATION, ids)
        event = self.store.pending_delivery(DESTINATION, limit=100)[0].event_id
        with self.assertRaisesRegex(ReadError, 'ISSUE_INVALID'):
            self.store.defer_delivery(DESTINATION, event, 'raw synthetic error must not be stored')
        self.assertEqual({'pending': 1, 'deferred': 0}, self.store.delivery_status(DESTINATION))

    def test_pending_keyset_validates_cursor_and_reads_only_subsequent_candidates(self):
        seed(self.store, count=3)
        first = self.store.pending_delivery(DESTINATION, limit=1)[0]
        later = self.store.pending_delivery(DESTINATION, limit=100, after=(first.timestamp, first.event_id))
        self.assertEqual(2, len(later))
        for after in ((True, first.event_id), (1, 'bad'), (1,), []):
            with self.subTest(after=after), self.assertRaisesRegex(ReadError, 'QUERY_INVALID'):
                self.store.pending_delivery(DESTINATION, limit=100, after=after)


def transport_fixture():
    """Test only: bounded synthetic workspace, account and group are hardcoded."""
    raw = sys.stdin.buffer.read(4194305)
    if len(raw) > 4194304:
        raise ReadError('SYNTHETIC_FIXTURE_INPUT_LIMIT')
    request = json.loads(raw.decode('utf-8', errors='strict'))
    root = (Path(__file__).resolve().parents[2] / ".review-research").resolve()
    path = Path(request["path"]).resolve()
    if (path.parent.parent != root or not path.parent.name.startswith("synthetic-wechat-bridge-")
            or path.name != "source" + SUFFIX):
        raise ReadError("SYNTHETIC_FIXTURE_PATH_REQUIRED")
    with open_store(path) as store:
        action = request["action"]
        if action == "seed":
            count = request.get("count", 1)
            if type(count) is not int or not 1 <= count <= 125:
                raise ReadError("SYNTHETIC_FIXTURE_COUNT")
            text = request.get('text', '明天下午两点交人工测试作业')
            if not isinstance(text, str) or len(text.encode('utf-8')) > 262144:
                raise ReadError('SYNTHETIC_FIXTURE_TEXT_LIMIT')
            seed(store, count=count, text=text)
            unsupported = request.get('unsupported', 0)
            if type(unsupported) is not int or not 0 <= unsupported <= count:
                raise ReadError('SYNTHETIC_FIXTURE_COUNT')
            store._conn.execute('UPDATE receipt_messages SET kind=3 WHERE event_id IN '
                '(SELECT event_id FROM receipt_messages ORDER BY timestamp,event_id LIMIT ?)', (unsupported,))
            result = {"seeded": count}
        elif action == "prepare":
            batch = prepare_delivery(store, request["destination"], names)
            result = batch.document if batch else None
        elif action == "ack":
            batch = prepare_delivery(store, request["destination"], names)
            if batch is None:
                raise ReadError("SYNTHETIC_FIXTURE_NO_PENDING")
            batch.acknowledge(store, request["ack"])
            result = {"acknowledged": True}
        elif action == "pending":
            result = {"pending": len(store.pending_delivery(request["destination"], limit=100)),
                      "stored": len(store.stored_messages(limit=1000))}
        elif action == 'status':
            result = store.delivery_status(request['destination'])
        else:
            raise ReadError("SYNTHETIC_FIXTURE_ACTION")
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    if sys.argv[1:] == ["--transport-fixture"]:
        transport_fixture()
    else:
        unittest.main()
