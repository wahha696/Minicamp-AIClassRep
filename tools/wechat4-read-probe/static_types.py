"""Bounded offline PE/Qt-5 metadata research. Never loads or executes an image.

Results describe installed program bytes, not live instances, an account or a
login. No process, GUI, database, network, disassembler or third-party imports.
"""
from __future__ import annotations

import bisect
import hashlib
import math
import struct
import time
from dataclasses import dataclass, field

from reader import ReadError
from static_window_map import WindowMapper, find_window_mappers

READ, WRITE, EXECUTE = 0x40000000, 0x80000000, 0x20000000
CLASSES = ("mmui::MainWindow", "mmui::LoginWindow")


@dataclass(frozen=True, repr=False)
class Section:
    rva: int
    virtual_size: int
    raw: int
    raw_size: int
    flags: int


class PEImage:
    def __init__(self, image, *, max_file_bytes, max_image_bytes):
        if (type(max_file_bytes) is not int or max_file_bytes <= 0
                or type(max_image_bytes) is not int or max_image_bytes <= 0):
            raise ReadError("EXPLICIT_STATIC_IMAGE_BUDGET_REQUIRED")
        if type(image) is not bytes or not 64 <= len(image) <= max_file_bytes:
            raise ReadError("STATIC_IMAGE_TYPE_OR_SIZE_INVALID")
        self.image = image
        if image[:2] != b"MZ":
            raise ReadError("STATIC_PE_HEADER_INVALID")
        pe = self.unpack("<I", 0x3C)[0]
        if pe < 64 or self.take(pe, 4) != b"PE\0\0":
            raise ReadError("STATIC_PE_HEADER_INVALID")
        machine, count = self.unpack("<HH", pe + 4)
        optional_size = self.unpack("<H", pe + 20)[0]
        optional = pe + 24
        self.take(optional, optional_size)
        if machine != 0x8664 or not 1 <= count <= 96 or optional_size < 112:
            raise ReadError("STATIC_AMD64_PE_REQUIRED")
        if self.unpack("<H", optional)[0] != 0x20B:
            raise ReadError("STATIC_AMD64_PE_REQUIRED")
        self.base = self.unpack("<Q", optional + 24)[0]
        self.size, headers = self.unpack("<II", optional + 56)
        if not 0x10000 <= self.base < self.base + self.size <= 0x800000000000 or self.size > max_image_bytes:
            raise ReadError("STATIC_IMAGE_ADDRESS_OR_SIZE_INVALID")
        directory_count = self.unpack("<I", optional + 108)[0]
        if directory_count > 16 or 112 + directory_count * 8 > optional_size:
            raise ReadError("STATIC_PE_DIRECTORY_INVALID")
        self.exception = self.unpack("<II", optional + 112 + 3 * 8) if directory_count > 3 else (0, 0)
        table = optional + optional_size
        self.take(table, count * 40)
        if not table + count * 40 <= headers <= len(image) or headers > self.size:
            raise ReadError("STATIC_PE_HEADER_INVALID")
        sections = []
        for index in range(count):
            at = table + index * 40
            virtual, rva, raw_size, raw = self.unpack("<IIII", at + 8)
            flags = self.unpack("<I", at + 36)[0]
            span = max(virtual, raw_size)
            if not span or rva < headers or rva + span > self.size:
                raise ReadError("STATIC_PE_SECTION_INVALID")
            if raw_size:
                if raw < headers:
                    raise ReadError("STATIC_PE_SECTION_INVALID")
                self.take(raw, raw_size)
            sections.append(Section(rva, virtual, raw, raw_size, flags))
        self.sections = tuple(sections)
        for index, first in enumerate(sections):
            for second in sections[index + 1:]:
                if (max(first.rva, second.rva) < min(first.rva + max(first.virtual_size, first.raw_size),
                                                   second.rva + max(second.virtual_size, second.raw_size))
                        or first.raw_size and second.raw_size and
                        max(first.raw, second.raw) < min(first.raw + first.raw_size, second.raw + second.raw_size)):
                    raise ReadError("STATIC_PE_OVERLAPPING_SECTIONS")

    def take(self, offset, size):
        if type(offset) is not int or type(size) is not int or size <= 0 or not 0 <= offset < offset + size <= len(self.image):
            raise ReadError("STATIC_PE_FILE_BOUNDS")
        return memoryview(self.image)[offset:offset + size]

    def unpack(self, fmt, offset):
        return struct.unpack(fmt, self.take(offset, struct.calcsize(fmt)))

    def locate(self, rva, size=1, *, readonly=False, executable=False, data=False):
        if type(rva) is not int or type(size) is not int or size <= 0:
            raise ReadError("STATIC_PE_RVA_BOUNDS")
        found = [section for section in self.sections
                 if section.rva <= rva < rva + size <= section.rva + section.raw_size]
        if len(found) != 1:
            raise ReadError("STATIC_PE_RVA_BOUNDS")
        section = found[0]
        if (not section.flags & READ or readonly and section.flags & (WRITE | EXECUTE)
                or data and section.flags & EXECUTE
                or executable and (not section.flags & EXECUTE or section.flags & WRITE)):
            raise ReadError("STATIC_PE_SECTION_PERMISSION")
        return section.raw + rva - section.rva

    def at(self, rva, fmt, **permissions):
        return self.unpack(fmt, self.locate(rva, struct.calcsize(fmt), **permissions))

    def find(self, pattern, *, readonly=False, executable=False, data=False, limit, guard):
        found = []
        for section in self.sections:
            if (not section.flags & READ or readonly and section.flags & (WRITE | EXECUTE)
                    or data and section.flags & EXECUTE
                    or executable and (not section.flags & EXECUTE or section.flags & WRITE)):
                continue
            start, end = section.raw, section.raw + section.raw_size
            while start < end:
                guard()
                offset = self.image.find(pattern, start, end)
                if offset < 0:
                    break
                if len(found) >= limit:
                    raise ReadError("STATIC_REFERENCE_LIMIT")
                found.append(section.rva + offset - section.raw)
                start = offset + 1
        return tuple(found)


@dataclass(frozen=True, repr=False)
class QtAccessor:
    function_rva: int
    dynamic_meta_target_rva: int
    pointer_table_candidates: tuple[int, ...]
    table_method_rvas: tuple[tuple[int, tuple[int, ...]], ...] = ()


@dataclass(frozen=True, repr=False)
class StaticType:
    class_name: str
    string_rva: int
    string_header_rva: int
    metaobject_rva: int
    metadata_rva: int
    metacall_rva: int
    reference_function_rvas: tuple[int, ...]
    pointer_table_candidates: tuple[int, ...]
    qt_accessor_candidates: tuple[QtAccessor, ...]


@dataclass(frozen=True, repr=False)
class StaticReport:
    sha256: str
    file_bytes: int
    image_bytes: int
    types: tuple[StaticType, ...]
    window_mapper_candidates: tuple[WindowMapper, ...] = ()
    login_verified: bool = field(default=False, init=False)


def analyze_types(image, *, expected_sha256, max_file_bytes, max_image_bytes,
                  max_references, max_functions, max_seconds, clock=time.monotonic):
    """Identify metadata candidates in a fixed image. Never infer live state.

    Only the two fixed class names are queried. Function/table links remain
    hypotheses: this is not a complete x64 disassembler or ABI verification.
    """
    if (not isinstance(expected_sha256, str) or len(expected_sha256) != 64
            or any(char not in "0123456789abcdef" for char in expected_sha256)):
        raise ReadError("EXPLICIT_STATIC_HASH_REQUIRED")
    if (type(max_references) is not int or not 1 <= max_references <= 500000
            or type(max_functions) is not int or not 1 <= max_functions <= 1000000
            or type(max_seconds) not in (int, float) or not math.isfinite(max_seconds)
            or not 0 < max_seconds <= 30):
        raise ReadError("EXPLICIT_STATIC_ANALYSIS_BUDGET_REQUIRED")
    deadline = clock() + max_seconds
    def guard():
        if clock() >= deadline:
            raise ReadError("STATIC_ANALYSIS_TIME_EXCEEDED")
    guard()
    pe = PEImage(image, max_file_bytes=max_file_bytes, max_image_bytes=max_image_bytes)
    digest = hashlib.sha256(image).hexdigest()
    guard()
    if digest != expected_sha256:
        raise ReadError("STATIC_PROGRAM_HASH_CHANGED")

    functions = []
    exception_rva, exception_size = pe.exception
    if exception_rva or exception_size:
        if not exception_rva or not exception_size or exception_size % 12 or exception_size // 12 > max_functions:
            raise ReadError("STATIC_EXCEPTION_DIRECTORY_INVALID")
        data = pe.take(pe.locate(exception_rva, exception_size, readonly=True), exception_size)
        for begin, end, unwind in struct.iter_unpack("<III", data):
            guard()
            if begin >= end or functions and begin < functions[-1][1] or not unwind:
                raise ReadError("STATIC_EXCEPTION_DIRECTORY_INVALID")
            pe.locate(begin, end - begin, executable=True)
            pe.locate(unwind, 4, readonly=True)
            functions.append((begin, end))
    starts = [begin for begin, _ in functions]
    # RIP-relative LEA into any 64-bit register, kept as a candidate reference
    # only: raw-byte hits are not proof of an instruction boundary or accessor.
    lea_sites = []
    rax_sites = []
    for rex in (0x48, 0x4C):
        for register in range(8):
            hits = pe.find(bytes((rex, 0x8D, 0x05 + register * 8)), executable=True,
                           limit=max_references - len(lea_sites), guard=guard)
            lea_sites.extend(hits)
            if rex == 0x48 and register == 0:
                rax_sites.extend(hits)
    references = {}
    for site in lea_sites:
        guard()
        try:
            destination = site + 7 + pe.at(site + 3, "<i", executable=True)[0]
        except ReadError:
            continue
        index = bisect.bisect_right(starts, site) - 1
        if index >= 0 and functions[index][0] <= site and site + 7 <= functions[index][1]:
            references.setdefault(destination, set()).add(functions[index][0])

    results = []
    for name in CLASSES:
        guard()
        encoded = name.encode("ascii")
        strings = pe.find(encoded + b"\0", data=True, limit=max_references, guard=guard)
        if len(strings) != 1:
            raise ReadError("STATIC_CLASS_STRING_MISSING_OR_AMBIGUOUS")
        string_rva = strings[0]
        signature = struct.pack("<iIII", -1, len(encoded), 0, 0)
        headers = []
        for header in pe.find(signature, data=True, limit=max_references, guard=guard):
            if header % 8:
                continue
            try:
                delta = pe.at(header + 16, "<q", data=True)[0]
                if header + delta == string_rva and 24 <= delta <= 65536:
                    # The string and its offset header must lie in the same section.
                    pe.locate(header, delta + len(encoded) + 1, data=True)
                    headers.append(header)
            except ReadError:
                continue
        if len(headers) != 1:
            raise ReadError("STATIC_QT_STRING_HEADER_MISSING_OR_AMBIGUOUS")
        header = headers[0]
        candidates = []
        for pointer in pe.find(struct.pack("<Q", pe.base + header), data=True,
                               limit=max_references, guard=guard):
            guard()
            meta = pointer - 8
            if meta % 8:
                continue
            try:
                super_meta, string_data, metadata, metacall, related, extra = pe.at(meta, "<6Q", data=True)
                if string_data != pe.base + header or related or extra:
                    continue
                revision, class_index = pe.at(metadata - pe.base, "<II", data=True)
                if revision != 8 or class_index != 0 or not super_meta or not metacall:
                    continue
                pe.locate(super_meta - pe.base, 48, data=True)
                pe.locate(metadata - pe.base, 14 * 4, data=True)
                pe.locate(metacall - pe.base, executable=True)
                candidates.append((meta, metadata - pe.base, metacall - pe.base))
            except ReadError:
                continue
        if len(candidates) != 1:
            raise ReadError("STATIC_QT_METAOBJECT_MISSING_OR_AMBIGUOUS")
        meta, metadata, metacall = candidates[0]
        reference_functions = tuple(sorted(references.get(meta, ())))
        def pointer_tables(functions):
            tables = set()
            for function in functions:
                for pointer in pe.find(struct.pack("<Q", pe.base + function), data=True,
                                       limit=max_references, guard=guard):
                    if pointer % 8:
                        continue
                    try:
                        # Plausible first three QObject virtual methods only;
                        # this does not locate or validate any live instance.
                        entries = pe.at(pointer, "<3Q", data=True)
                        for address in entries:
                            pe.locate(address - pe.base, executable=True)
                        tables.add(pointer)
                    except ReadError:
                        continue
            return tuple(sorted(tables))

        accessors = []
        for site in rax_sites:
            guard()
            try:
                if site + 7 + pe.at(site + 3, "<i", executable=True)[0] != meta:
                    continue
                start = site - 15
                raw = pe.take(pe.locate(start, 23, executable=True), 23)
                # Exact observed leaf/tail-call pattern. Exception tables omit
                # some such functions; never invent a boundary from padding alone.
                if (start % 16 or pe.at(start - 1, "<B", executable=True)[0] != 0xCC
                        or raw[:11] != b"\x48\x8b\x49\x08\x48\x83\x79\x28\0\x0f\x85"
                        or raw[15:18] != b"\x48\x8d\x05" or raw[22] != 0xC3):
                    continue
                branch = start + 15 + struct.unpack_from("<i", raw, 11)[0]
                pe.locate(branch, executable=True)
            except ReadError:
                continue
            # Budget errors while finding tables are fatal, never treated as
            # a nonmatching byte pattern that can silently omit a candidate.
            tables = pointer_tables((start,))
            methods = tuple((table, tuple(address - pe.base for address in pe.at(table, "<3Q", data=True)))
                            for table in tables)
            accessors.append(QtAccessor(start, branch, tables, methods))
        results.append(StaticType(name, string_rva, header, meta, metadata, metacall,
                                  reference_functions, pointer_tables(reference_functions), tuple(accessors)))
    guard()
    mappers = find_window_mappers(pe, functions, max_references=max_references, guard=guard)
    return StaticReport(digest, len(image), pe.size, tuple(results), mappers)
