"""Offline candidate for the observed QWidget::find-style x64 lookup.

The exact body is independently observed in the pinned 4.1.15.50 image. Only
its RIP displacement varies. This is not a generic Qt ABI or login detector.
"""
from dataclasses import dataclass, field
import struct

from reader import ReadError


LOOKUP_BODY = bytes.fromhex(
    "50488b05000000004885c0746a48c70424000000004c8b0841837914007458"
    "458b51204c89ca4585d274394989c849c1e81f4131c8453341244489c031d2"
    "41f7f248c1e203490351080f1f8000000000488b124c39ca740c443b420875f2"
    "483b4a1075ec488d42184c39ca4889e1480f45c8488b0159c331c059c3")


@dataclass(frozen=True, repr=False)
class WindowMapper:
    lookup_rva: int
    global_rva: int
    body: bytes
    login_verified: bool = field(default=False, init=False)


def find_window_mappers(pe, functions, *, max_references, guard):
    """Return every exact candidate, including ambiguity, without reading BSS.

    The global is a virtual writable cell and may be outside materialized file
    bytes. Validate its section bounds; do not manufacture zero-filled content.
    """
    boundaries = {(start, end) for start, end in functions}
    result = []
    for site in pe.find(LOOKUP_BODY[:4], executable=True, limit=max_references, guard=guard):
        guard()
        try:
            raw = bytes(pe.take(pe.locate(site, len(LOOKUP_BODY), executable=True), len(LOOKUP_BODY)))
        except ReadError:
            continue
        if (raw[:4] != LOOKUP_BODY[:4] or raw[8:] != LOOKUP_BODY[8:]
                or (site, site + len(raw)) not in boundaries):
            continue
        cell = site + 8 + struct.unpack_from("<i", raw, 4)[0]
        sections = [s for s in pe.sections if s.rva <= cell < cell + 8 <= s.rva + max(s.virtual_size, s.raw_size)]
        if (cell % 8 or len(sections) != 1 or sections[0].flags & 0xE0000000 != 0xC0000000):
            continue
        result.append(WindowMapper(site, cell, raw))
    guard()
    return tuple(result)
