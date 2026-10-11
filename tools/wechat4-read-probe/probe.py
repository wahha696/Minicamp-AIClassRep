"""Only runtime self-checks. Live reading is deliberately not exposed yet."""
import argparse
import json
import sqlite3
import sys


def main():
    parser = argparse.ArgumentParser(description="Memory read prototype: no live WeChat access.")
    parser.add_argument("--check-runtime", action="store_true", required=True)
    parser.parse_args()
    available = hasattr(sqlite3.Connection, "deserialize")
    print(json.dumps({"python": sys.version.split()[0], "sqlite": sqlite3.sqlite_version,
                      "memory_deserialize": available, "windows_cng": sys.platform == "win32",
                      "live_read_enabled": False}, ensure_ascii=False))
    return 0 if available and sys.platform == "win32" else 2


if __name__ == "__main__":
    raise SystemExit(main())
