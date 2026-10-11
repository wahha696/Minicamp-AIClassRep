"""Group names/IDs from an explicitly supplied, already decrypted contact image.

No account discovery, live login proof, process/file/UI/network access or group
membership/history queries. Importing this module performs no I/O.
"""
from __future__ import annotations

import re
import sqlite3
import ntpath
from dataclasses import dataclass

from acquisition import CipherProfile, Consent, read_selected_snapshots
from native import FileIdentity, NativeProcess, ProcessIdentity, normal_path
from reader import MemoryDatabase, ReadError
from snapshot import Snapshotter


@dataclass(frozen=True, repr=False)
class GroupEntry:
    group_id: str
    name: str | None


class ContactDatabase(MemoryDatabase):
    """Restrict even accidental queries to the two approved contact columns."""

    @staticmethod
    def _authorize(action, table, column, database, _trigger):
        if action == sqlite3.SQLITE_SELECT:
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_READ and database == "main":
            allowed = {"sqlite_master": {"name", "type"}, "contact": {"username", "nick_name"}}
            if column in allowed.get(table, set()):
                return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_FUNCTION and column == "glob":
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY


class ContactNameDatabase(MemoryDatabase):
    """Sender display names only: username, nickname and the user's own remark."""

    @staticmethod
    def _authorize(action, table, column, database, _trigger):
        if action == sqlite3.SQLITE_SELECT:
            return sqlite3.SQLITE_OK
        if action == sqlite3.SQLITE_READ and database == "main":
            allowed = {"sqlite_master": {"name", "type"}, "contact": {"username", "nick_name", "remark"}}
            if column in allowed.get(table, set()):
                return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY


def _display(value, max_name_bytes):
    if not isinstance(value, str) or "\0" in value or not value.strip():
        return None
    value = value.strip()
    return value if len(value.encode("utf-8")) <= max_name_bytes else None


@dataclass(frozen=True, repr=False)
class AccountCatalog:
    groups: tuple
    nickname: str | None


def read_own_nickname(image, account, *, max_name_bytes=1024):
    """Exact self row only; never use remarks or another contact as the account name."""
    with ContactDatabase(image) as database:
        rows = database.query("SELECT nick_name FROM contact WHERE username=? LIMIT 2", (account,))
    return _display(rows[0]['nick_name'], max_name_bytes) if len(rows) == 1 else None


def read_contact_names(image, *, max_image_bytes, max_rows, max_name_bytes):
    """username -> remark (preferred) or nickname. Rows without a usable name are omitted."""
    if (type(max_rows) is not int or not 1 <= max_rows <= 1000000
            or type(max_name_bytes) is not int or not 1 <= max_name_bytes <= 65536):
        raise ReadError("EXPLICIT_CONTACT_CATALOG_BUDGET_REQUIRED")
    if type(image) not in (bytes, bytearray) or not image or len(image) > max_image_bytes:
        raise ReadError("CONTACT_IMAGE_BUDGET_OR_TYPE_INVALID")
    with ContactNameDatabase(image) as database:
        schema = database.query("SELECT type FROM sqlite_master WHERE name=?", ("contact",))
        if len(schema) != 1 or schema[0]["type"] != "table":
            raise ReadError("CONTACT_SCHEMA_UNSUPPORTED")
        try:
            rows = database.query("SELECT username,nick_name,remark FROM contact LIMIT ?", (max_rows + 1,))
        except ReadError:
            try:  # Older layouts without a remark column still provide nicknames.
                rows = [{"username": r["username"], "nick_name": r["nick_name"], "remark": None} for r in
                        database.query("SELECT username,nick_name FROM contact LIMIT ?", (max_rows + 1,))]
            except (ReadError, UnicodeError):
                raise ReadError("CONTACT_CATALOG_QUERY_FAILED") from None
        except UnicodeError:
            raise ReadError("CONTACT_CATALOG_QUERY_FAILED") from None
    if len(rows) > max_rows:
        raise ReadError("CONTACT_CATALOG_GROUP_LIMIT")
    result = {}
    for row in rows:
        username = row["username"]
        if not isinstance(username, str) or not re.fullmatch(r"[\w-]{1,256}", username) or username.endswith("@chatroom"):
            continue
        name = _display(row["remark"], max_name_bytes) or _display(row["nick_name"], max_name_bytes)
        if name is not None:
            result[username] = name
    return result


def _validate_budgets(max_image_bytes, max_groups, max_name_bytes):
    if (type(max_image_bytes) is not int or max_image_bytes <= 0
            or type(max_groups) is not int or not 1 <= max_groups <= 10000
            or type(max_name_bytes) is not int or not 1 <= max_name_bytes <= 65536):
        raise ReadError("EXPLICIT_CONTACT_CATALOG_BUDGET_REQUIRED")


def read_groups(image, *, max_image_bytes, max_groups, max_name_bytes):
    """Return a complete bounded catalog, or fail without returning partial rows.

    Budgets are caller-specified research limits, not ordinary-user defaults.
    The caller separately authorizes/validates the account, file and snapshot.
    Neither a contact row nor a decryption key is proof of a current login.
    """
    _validate_budgets(max_image_bytes, max_groups, max_name_bytes)
    if type(image) not in (bytes, bytearray) or not image or len(image) > max_image_bytes:
        raise ReadError("CONTACT_IMAGE_BUDGET_OR_TYPE_INVALID")
    with ContactDatabase(image) as database:
        schema = database.query("SELECT type FROM sqlite_master WHERE name=?", ("contact",))
        if len(schema) != 1 or schema[0]["type"] != "table":
            raise ReadError("CONTACT_SCHEMA_UNSUPPORTED")
        try:
            rows = database.query(
                "SELECT username,nick_name FROM contact WHERE username GLOB ? "
                "ORDER BY username LIMIT ?", ("*@chatroom", max_groups + 1))
        except (ReadError, UnicodeError):
            raise ReadError("CONTACT_CATALOG_QUERY_FAILED") from None
    if len(rows) > max_groups:
        raise ReadError("CONTACT_CATALOG_GROUP_LIMIT")
    result, identifiers = [], set()
    for row in rows:
        group_id, name = row["username"], row["nick_name"]
        if (not isinstance(group_id, str) or not re.fullmatch(r"[\w-]+@chatroom", group_id)
                or len(group_id.encode("utf-8")) > 256 or group_id in identifiers):
            raise ReadError("CONTACT_GROUP_ID_INVALID_OR_DUPLICATE")
        if name is not None and (not isinstance(name, str) or "\0" in name
                or len(name.encode("utf-8")) > max_name_bytes):
            raise ReadError("CONTACT_GROUP_NAME_INVALID_OR_LIMIT")
        identifiers.add(group_id)
        result.append(GroupEntry(group_id, name if name and name.strip() else None))
    return tuple(result)


@dataclass(frozen=True, repr=False)
class ContactScope:
    """Selected account folder for catalog acquisition, never a logged-in user."""
    account: str

    def check_account(self, account):
        if account != self.account:
            raise ReadError("ACCOUNT_MISMATCH")


def acquire_groups(*, account, root, expected_process, expected_file, consent,
                   cipher_profile, vfs_profile, approve_contact_metadata=False,
                   scan_bytes, scan_seconds, scan_hits, snapshot_bytes, snapshot_seconds,
                   max_groups, max_name_bytes,
                   process_factory=NativeProcess, snapshotter_factory=Snapshotter, read_names=False, own_account=None):
    """One-shot opt-in read of exactly contact/contact.db and its WAL/SHM.

    Call only after obtaining the user's concrete file/budget approval. Boolean
    flags cannot grant permission by themselves. No process/account discovery or
    fallback, polling, messages, persistence, upload or login attestation.
    """
    if approve_contact_metadata is not True:
        raise ReadError("CONTACT_METADATA_CONFIRMATION_REQUIRED")
    # Name rows are bounded by read_contact_names; the 10000 limit is for group catalogs.
    _validate_budgets(snapshot_bytes, 1 if read_names else max_groups, max_name_bytes)
    if (not isinstance(account, str) or not account or account in (".", "..")
            or ntpath.basename(account) != account or ":" in account or "\0" in account
            or account.strip() != account or len(account.encode("utf-8", "replace")) > 256
            or account.encode("utf-8", "replace").decode("utf-8") != account):
        raise ReadError("EXPLICIT_ACCOUNT_SELECTION_REQUIRED")
    if not isinstance(root, str):
        raise ReadError("ACCOUNT_ROOT_MISMATCH")
    canonical = normal_path(root)
    if (ntpath.basename(canonical) != "db_storage"
            or ntpath.basename(ntpath.dirname(canonical)) != account.lower()):
        raise ReadError("ACCOUNT_ROOT_MISMATCH")
    if (not isinstance(expected_file, FileIdentity) or not isinstance(expected_process, ProcessIdentity)
            or not isinstance(consent, Consent) or not isinstance(cipher_profile, CipherProfile)):
        raise ReadError("EXPLICIT_CONTACT_IDENTITIES_REQUIRED")
    shards = read_selected_snapshots(ContactScope(account), consent, expected_process, cipher_profile,
        vfs_profile=vfs_profile, root=canonical,
        selected_databases={"contact/contact.db": ("contact/contact.db", expected_file)},
        scan_bytes=scan_bytes, scan_seconds=scan_seconds, scan_hits=scan_hits,
        snapshot_bytes=snapshot_bytes, snapshot_seconds=snapshot_seconds,
        process_factory=process_factory, snapshotter_factory=snapshotter_factory)
    try:
        if len(shards) != 1 or shards[0].account != account or shards[0].shard_id != "contact/contact.db":
            raise ReadError("CONTACT_CAPTURE_SCOPE_MISMATCH")
        if read_names:
            return read_contact_names(shards[0].image, max_image_bytes=snapshot_bytes,
                max_rows=max_groups, max_name_bytes=max_name_bytes)
        groups = read_groups(shards[0].image, max_image_bytes=snapshot_bytes,
            max_groups=max_groups, max_name_bytes=max_name_bytes)
        if own_account is not None:
            try:
                nickname = read_own_nickname(shards[0].image, own_account, max_name_bytes=max_name_bytes)
            except (ReadError, UnicodeError):
                nickname = None
            return AccountCatalog(groups, nickname)
        return groups
    finally:
        del shards


def acquire_contact_names(**options):
    """Same approved contact.db read as acquire_groups; returns sender display names."""
    return acquire_groups(**options, read_names=True)
