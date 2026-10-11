"""Explicit local transport contract; no automatic listener, HTTP or AI calls.

Caller supplies destination, display-name resolver and transport. Raw receipt
messages stay on disk until a later business retention policy is implemented.
An acknowledgement marks business ingestion only, never AI completion.
"""
from dataclasses import dataclass, field
import hashlib
import re
import struct

from reader import ReadError
from receipts import DELIVERY_ISSUE_REASONS
from textdecode import ZSTD_MAGIC, decode_field


def _digest(fields):
    digest = hashlib.sha256()
    for value in fields:
        data = value.encode("utf-8", errors="strict")
        digest.update(struct.pack(">I", len(data)))
        digest.update(data)
    return digest.hexdigest()


def group_id(account, group):
    return "wechat:" + _digest(("wechat-group-v1", account, group))


def batch_id(document):
    fields = ["wechat-delivery-v1", document["destination"], document["wechat_account"],
              str(len(document["messages"]))]
    for msg in document["messages"]:
        fields.extend((msg["event_id"], msg["group_id"], msg["group_name"],
                       msg["sender_name"], msg["text"], str(msg["sent_at"])))
    return _digest(fields)


def _utf8(value, maximum):
    if not isinstance(value, str):
        raise ReadError("DELIVERY_TEXT_INVALID")
    try:
        data = value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise ReadError("DELIVERY_TEXT_INVALID") from None
    if len(data) > maximum:
        raise ReadError("DELIVERY_TEXT_LIMIT")
    return len(data)


def _text(msg, zstd):
    # Nontext and undecodable records remain saved and unacknowledged. No guessed
    # placeholder/OCR/field precedence policy is introduced by this prototype.
    if msg.kind != 1:
        raise ReadError("DELIVERY_MESSAGE_TYPE_UNSUPPORTED")
    fields = [decode_field(msg.content, zstd=zstd)]
    compressed = msg.compressed_content
    if compressed is not None and compressed != b'' and compressed != '':
        if type(compressed) is not bytes or not compressed.startswith(ZSTD_MAGIC):
            raise ReadError("DELIVERY_COMPRESSED_FIELD_UNSUPPORTED")
        fields.append(decode_field(compressed, zstd=zstd))
    if any(result.text is None for result in fields):
        raise ReadError("DELIVERY_TEXT_NOT_DECODED")
    texts = {result.text for result in fields if result.text}
    if len(texts) > 1:
        raise ReadError("DELIVERY_TEXT_CONFLICT")
    return next(iter(texts), "")


@dataclass(frozen=True, repr=False)
class DeliveryBatch:
    document: dict = field(repr=False)

    def acknowledge(self, store, acknowledgement):
        doc = self.document
        ids = tuple(m["event_id"] for m in doc["messages"])
        keys = {"version", "destination", "wechat_account", "batch_id", "event_ids",
                "accepted", "inserted", "replayed"}
        if (not isinstance(acknowledgement, dict) or set(acknowledgement) != keys
                or type(acknowledgement["version"]) is not int or acknowledgement["version"] != 1
                or acknowledgement["destination"] != doc["destination"]
                or acknowledgement["wechat_account"] != doc["wechat_account"]
                or acknowledgement["batch_id"] != doc["batch_id"]
                or not isinstance(acknowledgement["event_ids"], list)
                or acknowledgement["event_ids"] != list(ids)
                or acknowledgement["accepted"] is not True
                or type(acknowledgement["inserted"]) is not int
                or not 0 <= acknowledgement["inserted"] <= len(ids)
                or type(acknowledgement["replayed"]) is not bool
                or (acknowledgement["replayed"] and acknowledgement["inserted"] != 0)
                or doc["batch_id"] != batch_id(doc)
                or store.scope.account != doc["wechat_account"]):
            raise ReadError("DELIVERY_ACK_MISMATCH")
        store.acknowledge_delivery(doc["destination"], doc["batch_id"], ids)


_SENDER_PREFIX = re.compile(r"([A-Za-z][A-Za-z0-9_-]{0,127}):\n")


def split_sender(text):
    """Group text from others is stored as "<username>:\\n<body>"; own messages have no prefix."""
    match = _SENDER_PREFIX.match(text)
    return (match.group(1), text[match.end():]) if match else (None, text)


def _message(msg, names, zstd):
    if (not re.fullmatch(r"[A-Za-z0-9_-]+@chatroom", msg.group)
            or not 0 <= msg.timestamp <= 9007199254740):
        raise ReadError("DELIVERY_MESSAGE_METADATA_INVALID")
    sender, text = split_sender(_text(msg, zstd))
    size = _utf8(text, 262144)
    try:
        group_name, sender_name = names(msg.group, sender)
    except Exception:
        raise ReadError("DELIVERY_NAMES_UNAVAILABLE") from None
    _utf8(group_name, 4096)
    _utf8(sender_name, 4096)
    return {"event_id": msg.event_id, "group_id": msg.group,
        "group_name": group_name, "sender_name": sender_name, "text": text,
        "sent_at": msg.timestamp * 1000}, size


def prepare_delivery(store, destination, names, *, zstd=None):
    store._destination(destination)
    _utf8(store.scope.account, 256)
    document = {"version": 1, "destination": destination, "wechat_account": store.scope.account,
                "messages": []}
    text_bytes = 0
    after = None
    full = False
    # Bounded research scan: deferred rows do not starve subsequent normal text.
    # Caller uses deliver_once.has_more to schedule another turn after this budget.
    for _ in range(10):
        rows = store.pending_delivery(destination, limit=100, after=after)
        if not rows:
            break
        for msg in rows:
            try:
                message, size = _message(msg, names, zstd)
            except ReadError as error:
                reason = str(error)
                if reason not in DELIVERY_ISSUE_REASONS:
                    raise
                # Storage errors propagate; never pretend a failed quarantine was saved.
                store.defer_delivery(destination, msg.event_id, reason)
                after = (msg.timestamp, msg.event_id)
                continue
            if text_bytes + size > 1048576:
                full = True
                break
            document["messages"].append(message)
            text_bytes += size
            after = (msg.timestamp, msg.event_id)
            if len(document["messages"]) == 100:
                full = True
                break
        if full or len(rows) < 100:
            break
    if not document["messages"]:
        return None
    document["batch_id"] = batch_id(document)
    return DeliveryBatch(document)


def deliver_once(store, destination, names, send, *, zstd=None):
    batch = prepare_delivery(store, destination, names, zstd=zstd)
    if batch is None:
        status = store.delivery_status(destination)
        return {"delivered": 0, "inserted": 0, "replayed": False,
                "has_more": status["pending"] > 0, "deferred": status["deferred"]}
    try:
        acknowledgement = send(batch.document)
    except Exception:
        raise ReadError("DELIVERY_NOT_ACKNOWLEDGED") from None
    batch.acknowledge(store, acknowledgement)
    status = store.delivery_status(destination)
    return {"delivered": len(batch.document["messages"]),
            "inserted": acknowledgement["inserted"], "replayed": acknowledgement["replayed"],
            "has_more": status["pending"] > 0, "deferred": status["deferred"]}
