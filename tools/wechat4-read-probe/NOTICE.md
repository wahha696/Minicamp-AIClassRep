# Protocol and source notice

The experimental Config.Cipher marker, XOR material and object-layout knowledge
used by acquisition.py are derived from the db.py implementation published in
**wechatauto-replica**, version 1.2.5.1, commit
`fbfb02677f8f5c8d52be166dc2a662a836f1354d`, by the upstream project contributors.

Source: https://github.com/fanyuantaier/wechatauto-replica/blob/fbfb02677f8f5c8d52be166dc2a662a836f1354d/wechatauto/db.py

That repository provides the Apache License, Version 2.0; a copy is included as
LICENSE-APACHE-2.0. Its README's additional research-use wording and final product
distribution requirements remain an open review item; this notice does not claim
the complete product or upstream package has been cleared for redistribution.

Local changes: independent read/query Win32 wrappers, explicit process/scope
checks, bounded/chunked marker scanning, no account fallback or key persistence,
shared-lock capture and strict committed-prefix validation, memory-only decoding,
and synthetic verification. No upstream package imports, GUI or sending paths.

SQLite file formats and lock offsets are based on its primary documentation and
public source; Tencent SQLCipher commit f049bed provides corroborating protocol
evidence. It is not evidence of the exact library embedded in a WeChat release.

textdecode.py independently binds the stable Zstandard C API described in
facebook/zstd v1.5.7 lib/zstd.h and doc/zstd_compression_format.md. Candidate
WeChat Zstandard field knowledge also comes from the fixed db.py source above;
its lossy UTF-8, guessed-offset salvage and placeholder heuristics are not used.
No standalone libzstd DLL or Zstandard source code is copied into this tool.
Production compressed-text decoding uses python-zstandard 0.25.0 through
zstd_package.py, installed into the portable Python runtime by
scripts/fastjudge-setup.mjs from classrep-fastjudge/requirements.txt. Users do not
need to locate a DLL on the developer's machine. Package distributions include
their own native decoder and license notices. The operator-supplied-library
path in textdecode.py is only used by optional native-API tests; it is not the
production worker dependency.

account_candidate.py independently implements the experimental global_config
landmark, pointer chain and wxid string-layout knowledge from the same pinned
db.py source above. It streams an explicitly selected module, does not follow
the nearby cipher/key field, and always returns login_verified=false. An account
candidate is not a live-login attestation. The candidate contact table/column
knowledge used by catalog.py also comes from that fixed source; the catalog
uses an independent restricted, memory-only query and explicit scope/budgets.
Neither module imports the upstream package or enables its UIA, process-writing,
GUI, account fallback, disk cache or sending functionality. Version compatibility
and redistribution review remain separate unresolved gates.

window_observation.py independently binds the public Win32/UI Automation ABI.
The experimental mmui::MainWindow / mmui::LoginWindow class-name hypotheses
are from wechatauto/uia_driver.py at the same upstream commit. Only root class,
process ID and native handle getters are used; the upstream accessibility gate
writing, names/titles, control traversal, patterns and GUI behavior are excluded.
Root class observations never grant a login or identify an account.

static_types.py / static_type_probe.py independently parse an explicitly fixed
installed PE file without loading it. PE/COFF and AMD64 unwind-layout knowledge
comes from Microsoft's PE Format and x64 exception-handling documentation.
Candidate Qt-5 QArrayData/QMetaObject layouts are based on Qt qtbase v5.15.2
src/corelib/tools/qarraydata.h and src/corelib/kernel/qobjectdefs.h; no Qt source
or binary is copied into the implementation. The narrow accessor-byte pattern
was independently observed by static disassembly of the user's installed
Weixin.dll 4.1.15.50. No instruction or function from that image is executed.
No DLL, runtime memory, keys or plaintext databases are copied/distributed.
Static function/table references are hypotheses, not verified live objects or
authentication; program hash/version checks do not establish a live login.

static_window_map.py / window_map_snapshot.py use independently observed narrow
x64 instructions and structural hypotheses from the same installed image.
Qt qtbase v5.15.2 src/widgets/kernel/qwidget.cpp, qwidget_p.h and
src/corelib/tools/qhash.h provide primary reference for lifecycle/map semantics.
No Qt implementation or installed DLL is included. The exact 123-byte lookup
fingerprint is research data, not executable code invoked by this tool. The
snapshot helper has no native-process entrypoint; synthetic observations and
stable HWND/object relationships never authenticate an account or login.

managed_windows.py and identity_snapshot.py combine these independently observed
structures with read-only Win32 handle ownership and bounded account-candidate
checks. identity_calibration_probe.py only emits comparison/count metadata;
identity_bound_capture.py bounds an explicitly scoped in-memory capture session.
No third-party package or target executable code is invoked. The single-build
lifecycle samples do not attest network login, atomicity or other versions;
all research observations retain login_verified=false. Production identity,
transport trust and distribution review remain separate requirements.

identity_discovery.py independently uses Microsoft's documented PROCESSENTRY32W,
Process32FirstW/Process32NextW and Toolhelp module enumeration APIs with limited
process-query rights. Enumeration retains only candidate WeChat PIDs; it does
not inspect process memory, account folders or message databases. Exact profile
hash verification remains the worker's separate installed-file check.
identity_worker.py and the Node owned-child channel are original bounded local
protocol implementations; no upstream process server or network listener is used.
