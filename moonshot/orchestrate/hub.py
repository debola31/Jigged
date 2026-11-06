"""The hub: the job queue over HTTP, the content-addressed blob store, and the dashboard. Runs on the Windows PC.

    conda run -n jigged python -m moonshot.orchestrate.hub [--port 8765]
    conda run -n jigged python -m moonshot.orchestrate.hub put <file>      # store a blob, print its sha256

Workers reach it over the tailnet. Every request that changes state, and every blob download, needs the bearer
token in <data root>/queue/token (created on first start; copied to each worker once). GET / and GET /status are
open on the tailnet, read-only.

Stdlib only, so a worker needs nothing installed to talk to it.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from moonshot.config import HUB_PORT, data_root
from moonshot.orchestrate.dashboard import render_dashboard
from moonshot.orchestrate.queue import Queue

SHA256_HEX = set("0123456789abcdef")


def queue_dir(root: Path) -> Path:
    d = root / "queue"
    d.mkdir(parents=True, exist_ok=True)
    return d


def token_for(root: Path) -> str:
    p = queue_dir(root) / "token"
    if not p.exists():
        p.write_text(secrets.token_hex(32))
    return p.read_text().strip()


def blob_dir(root: Path) -> Path:
    d = root / "blobs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def put_blob(root: Path, path: Path) -> str:
    """Copy a file into the blob store under its sha256; the hash is its name everywhere from now on."""
    digest = sha256_file(path)
    dest = blob_dir(root) / digest
    if not dest.exists():
        shutil.copyfile(path, dest)
    return digest


def make_handler(queue: Queue, root: Path, token: str):
    blobs = blob_dir(root)

    class Handler(BaseHTTPRequestHandler):
        server_version = "moonshot-hub/1"

        def log_message(self, fmt, *args):            # quiet: the dashboard is the log
            pass

        def _send(self, code: int, body: bytes, ctype: str = "application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj) -> None:
            self._send(code, json.dumps(obj).encode())

        def _authed(self) -> bool:
            if secrets.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}"):
                return True
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "bad or missing token"})
            return False

        def do_GET(self):
            if self.path == "/":
                return self._send(HTTPStatus.OK, render_dashboard(queue, root / "takes").encode(),
                                  "text/html; charset=utf-8")
            if self.path == "/status":
                return self._json(HTTPStatus.OK, {**queue.status(), "recent": queue.jobs(limit=50)})
            if self.path.startswith("/blobs/"):
                if not self._authed():
                    return
                digest = self.path.removeprefix("/blobs/")
                p = blobs / digest
                if len(digest) != 64 or not set(digest) <= SHA256_HEX or not p.is_file():
                    return self._json(HTTPStatus.NOT_FOUND, {"error": "no such blob"})
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(p.stat().st_size))
                self.end_headers()
                with open(p, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self):
            if not self._authed():
                return
            if self.path == "/blobs":
                return self._put_blob()
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            except json.JSONDecodeError:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "body is not JSON"})
            try:
                if self.path == "/jobs":
                    jid = queue.submit(body["kind"], body.get("payload", {}), body.get("inputs", []),
                                       body.get("requires"), body.get("priority", 100), body.get("group"),
                                       body.get("id"))
                    return self._json(HTTPStatus.OK, {"id": jid})
                if self.path == "/lease":
                    jobs = queue.lease(body["worker"], body.get("capabilities", {}), body.get("cached", []),
                                       body.get("max_jobs", 1))
                    return self._json(HTTPStatus.OK, {"jobs": jobs, "lease_s": queue.lease_s})
                if self.path == "/heartbeat":
                    return self._json(HTTPStatus.OK, {"lost": queue.heartbeat(body["worker"], body.get("jobs", []),
                                                                              body.get("progress"))})
                if self.path == "/complete":
                    return self._json(HTTPStatus.OK, {"accepted": queue.complete(body["worker"], body["job"],
                                                                                 body.get("result", {}))})
                if self.path == "/fail":
                    return self._json(HTTPStatus.OK, {"state": queue.fail(body["worker"], body["job"],
                                                                          body.get("error", ""))})
            except KeyError as e:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": f"missing field {e}"})
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def _put_blob(self):
            """A worker's result file: stored under its sha256, which the worker states (X-Sha256) and the hub checks,
            so a truncated upload is refused rather than stored under the wrong name."""
            want = self.headers.get("X-Sha256", "")
            if len(want) != 64 or not set(want) <= SHA256_HEX:
                return self._json(HTTPStatus.BAD_REQUEST, {"error": "X-Sha256 must be the file's sha256"})
            left = int(self.headers.get("Content-Length", 0))
            tmp = blobs / f".{want}.{secrets.token_hex(8)}.part"
            h = hashlib.sha256()
            with open(tmp, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        break
                    h.update(chunk)
                    f.write(chunk)
                    left -= len(chunk)
            if h.hexdigest() != want:
                tmp.unlink(missing_ok=True)
                return self._json(HTTPStatus.BAD_REQUEST, {"error": f"arrived with hash {h.hexdigest()[:12]}"})
            os.replace(tmp, blobs / want)
            return self._json(HTTPStatus.OK, {"digest": want})

    return Handler


def serve(root: Path, port: int = HUB_PORT, host: str = "0.0.0.0", lease_s: float = 120.0) -> ThreadingHTTPServer:
    queue = Queue(queue_dir(root) / "queue.db", lease_s=lease_s)
    server = ThreadingHTTPServer((host, port), make_handler(queue, root, token_for(root)))
    server.queue = queue
    return server


def main(argv: list[str]) -> None:
    root = data_root()
    if argv[:1] == ["put"]:
        for f in argv[1:]:
            print(put_blob(root, Path(f)), f)
        return
    port = int(argv[argv.index("--port") + 1]) if "--port" in argv else HUB_PORT
    server = serve(root, port)
    print(f"[hub] serving on :{port}, data root {root}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main(sys.argv[1:])
