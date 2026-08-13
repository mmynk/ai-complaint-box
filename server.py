#!/usr/bin/env python3
"""Serve the complaint box register: one page, one read-only JSON feed."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
STATIC_DIRECTORY = ROOT / "static"
INDEX_FILE = ROOT / "index.html"

# The writer (the complain skill) resolves the database the same way. This pair of
# rules is the whole contract between the two sides; change them together.
DB_ENVIRONMENT_VARIABLE = "AI_COMPLAINT_DB"
DEFAULT_DB_PATH = Path.home() / ".local" / "share" / "ai-complaint-box" / "complaints.db"

DEFAULT_LIMIT = 500
MAX_LIMIT = 2000

CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def resolve_db_path() -> Path:
    override = os.environ.get(DB_ENVIRONMENT_VARIABLE, "").strip()
    return Path(override).expanduser() if override else DEFAULT_DB_PATH


def read_complaints(db_path: Path, limit: int) -> dict:
    """Return the newest complaints first, and an empty register when none exist."""
    if not db_path.exists():
        return {"ready": False, "complaints": []}
    # Read-only so the register can never corrupt or lock what the skill writes.
    uri = "file:{}?mode=ro".format(quote(str(db_path)))
    connection = sqlite3.connect(uri, uri=True, timeout=5)
    try:
        rows = connection.execute(
            "SELECT id, created_at, body FROM complaints ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    except sqlite3.DatabaseError as error:
        return {"ready": False, "complaints": [], "error": str(error)}
    finally:
        connection.close()
    return {
        "ready": True,
        "complaints": [
            {"id": row[0], "created_at": row[1], "body": row[2]} for row in rows
        ],
    }


def clamp_limit(raw: str) -> int:
    try:
        return max(1, min(MAX_LIMIT, int(raw)))
    except (TypeError, ValueError):
        return DEFAULT_LIMIT


class RegisterHandler(BaseHTTPRequestHandler):
    server_version = "ComplaintBox/1.0"
    db_path = DEFAULT_DB_PATH

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        route = urlparse(self.path)
        if route.path in ("/", "/index.html"):
            self.send_file(INDEX_FILE)
        elif route.path == "/api/complaints":
            query = parse_qs(route.query)
            limit = clamp_limit(query.get("limit", [str(DEFAULT_LIMIT)])[0])
            payload = read_complaints(self.db_path, limit)
            payload["db"] = str(self.db_path)
            self.send_json(payload)
        elif route.path.startswith("/static/"):
            self.send_static(route.path[len("/static/") :])
        else:
            self.send_plain(HTTPStatus.NOT_FOUND, "no such page")

    def send_static(self, relative: str) -> None:
        candidate = (STATIC_DIRECTORY / relative).resolve()
        if STATIC_DIRECTORY not in candidate.parents or not candidate.is_file():
            self.send_plain(HTTPStatus.NOT_FOUND, "no such file")
            return
        self.send_file(candidate)

    def send_file(self, path: Path) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            self.send_plain(HTTPStatus.NOT_FOUND, "no such file")
            return
        self.send_bytes(
            HTTPStatus.OK,
            CONTENT_TYPES.get(path.suffix, "application/octet-stream"),
            body,
        )

    def send_json(self, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_bytes(HTTPStatus.OK, "application/json; charset=utf-8", body)

    def send_plain(self, status: HTTPStatus, message: str) -> None:
        self.send_bytes(status, "text/plain; charset=utf-8", message.encode("utf-8"))

    def send_bytes(self, status: HTTPStatus, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        """Stay quiet: the page polls, so per-request logs bury real errors."""


def dump(db_path: Path) -> int:
    """Print the register as JSON, in the same shape the page receives."""
    payload = read_complaints(db_path, MAX_LIMIT)
    payload["db"] = str(db_path)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if not payload["ready"]:
        print("no readable cabinet at {}".format(db_path), file=sys.stderr)
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--db", help="override the complaint database path")
    parser.add_argument(
        "--dump",
        action="store_true",
        help="print every complaint as JSON and exit, without serving the page",
    )
    arguments = parser.parse_args()

    RegisterHandler.db_path = (
        Path(arguments.db).expanduser() if arguments.db else resolve_db_path()
    )

    if arguments.dump:
        return dump(RegisterHandler.db_path)

    server = ThreadingHTTPServer((arguments.host, arguments.port), RegisterHandler)
    print("Bureau of Agent Grievances")
    print("  register  http://{}:{}".format(arguments.host, arguments.port))
    print("  database  {}".format(RegisterHandler.db_path))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nregister closed")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
