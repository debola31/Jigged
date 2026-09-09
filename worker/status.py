"""What this process is, on disk, for anything on the box that has to ask.

THE WORKER HAS NO IPC SURFACE AND THIS DOES NOT GIVE IT ONE. Nothing reads back
into the process. This is a one-way publication, replaced atomically, that a
reader may find missing, stale, or truncated and must survive all three.

WHY A LOCAL FILE WHEN `ai_workers` ALREADY EXISTS. That table is the liveness
registry and stays the authority for the product -- it is what the browser reads
and what sweep_ai_jobs() enforces. It cannot answer the question a person AT this
Mac has: an idle worker emits no log lines, launchd only knows whether a pid
exists, and neither says which databases are being served, what is running now,
or which commit this process actually imported. That is what this publishes.

WHAT IT DELIBERATELY DOES NOT PUBLISH: a staleness verdict. "Offline" is 60
seconds of missed beats, and that number is already pinned in several places that
must agree -- sweep_ai_jobs(), WORKER_STALE_AFTER_MS in utils/insightsAccess.ts,
ai_workers.last_seen_at's column comment, and api/services/ai_jobs.py. A reader on
THIS box does not need it: `reachable` below is not "is the beat fresh", it is
"did the beat this process last attempted actually land", which is a fact the
process observes directly and no clock can disagree with. That distinction is not
pedantry -- the two answers differ in the failure that actually happens here. A
Wi-Fi drop leaves the process alive, this file fresh, and db.heartbeat() raising;
a freshness rule would call that healthy.
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA = 1

# ~/Library/Application Support, NOT ~/Library/Logs. The log directory is a single
# append sink named in the LaunchAgent plist's StandardOutPath; a mutable state file
# in there is the first thing any future rotation deletes and the first thing a
# person rm -rf's while debugging. Same filesystem either way, so os.replace stays
# atomic.
DEFAULT_PATH = Path.home() / "Library/Application Support/Jigged/worker-status.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def path() -> Path:
    """Where the document lives. Overridable so tests never touch the real one."""
    return Path(os.getenv("JIGGED_STATUS_FILE") or DEFAULT_PATH)


def head_commit(repo: Path) -> str | None:
    """The checkout's HEAD. Read ONCE at startup -- see `commit` in snapshot()."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo), capture_output=True, text=True, timeout=5, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


def snapshot(
    *,
    worker_id: str,
    version: str | None,
    models: Any,
    resident_model: str | None,
    ollama_base_url: str,
    heartbeat_seconds: float,
    repo: Path,
    commit: str | None,
    started_at: str,
    databases: list[dict[str, Any]],
    busy: bool,
    held: int,
    last_job: dict[str, Any] | None = None,
    stopped: bool = False,
) -> dict[str, Any]:
    """The document. PURE, so the schema is testable without starting a loop."""
    production = next((d for d in databases if d.get("is_default")), None)
    return {
        "schema": SCHEMA,
        "worker_id": worker_id,
        "pid": os.getpid(),
        "version": version,
        "repo": str(repo),
        # ONCE, AT STARTUP, NOT PER TICK. worker/__main__.py puts api/ on sys.path
        # and the feature handlers are imported from there, so this names the code
        # this process is RUNNING. `git rev-parse HEAD` read later names the code
        # ON DISK. After a pull those differ, and that difference IS the "you
        # forgot to restart after the merge" bug -- invisible if only one is kept.
        "commit": commit,
        "started_at": started_at,
        "written_at": now_iso(),
        "heartbeat_seconds": heartbeat_seconds,
        "models": list(models),
        "resident_model": resident_model,
        "ollama_base_url": ollama_base_url,
        # PRODUCTION'S VERDICT, NOT AN AGGREGATE. Measured over 19 hours of log,
        # 79 of 132 heartbeat/claim failures were dead preview branches whose
        # Supabase project had been torn down -- noise a developer causes and the
        # shop never feels. One glyph cannot mean both "your preview is gone" and
        # "the shop's queue is unreachable", so it means the second.
        "reachable": bool(production and production.get("reachable")),
        "busy": busy,
        "held": held,
        "last_job": last_job,
        "stopped": stopped,
        "databases": list(databases),
    }


def write(payload: dict[str, Any], target: Path | None = None) -> None:
    """Publish atomically, and NEVER raise into the caller.

    Temp file in the destination directory plus os.replace, so a reader sees either
    the whole previous document or the whole new one -- never a half-written one.
    Both paths are on the same filesystem, which is what makes replace atomic.

    Swallowing OSError is deliberate rather than lazy: this file exists to make a
    person's menu bar honest, and a full disk or a bad permission on it is not a
    reason to stop answering a shop's questions.
    """
    dest = target or path()
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=str(dest.parent), prefix=".worker-status-", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(payload, fh)
            os.replace(tmp, dest)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise
    except OSError:
        pass
