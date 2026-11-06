"""The farm's job queue: SQLite on the hub (docs/moonshot/shop-and-pipeline-plan.md §8).

Workers hold no source of truth. A worker leases jobs for `lease_s` seconds and extends the lease with
heartbeats; a lease that lapses (worker killed, laptop closed, network gone) puts the job back in the queue for
another worker, up to `max_attempts` leases. Work is deterministic and keyed by content hash, so a late result
from a worker whose lease lapsed is still accepted if the job isn't done yet: the first completion wins and
duplicates are ignored. That is what lets the travelling M4 Max report results on reconnect.

This is not Jigged's `ai_jobs` queue: nothing here touches Supabase or calls a model.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    payload       TEXT NOT NULL,
    inputs        TEXT NOT NULL DEFAULT '[]',
    requires      TEXT NOT NULL DEFAULT '{}',
    priority      INTEGER NOT NULL DEFAULT 100,
    grp           TEXT,
    state         TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased', 'done', 'failed')),
    worker        TEXT,
    lease_expires REAL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    result        TEXT,
    error         TEXT,
    created       REAL NOT NULL,
    updated       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_pick ON jobs (state, priority, created);
CREATE TABLE IF NOT EXISTS workers (
    name         TEXT PRIMARY KEY,
    capabilities TEXT NOT NULL,
    last_seen    REAL NOT NULL
);
"""


def eligible(job: dict, caps: dict, cached: set[str], worker: str | None = None) -> bool:
    """Can this worker, with these capabilities, run this job?

    caps: kinds (job kinds it runs), gpu_mem_gb, cache_only (true while away from home: it may only take jobs
    whose inputs it already holds, so it never pulls a scene pack over a hotspot). A job whose requires names a
    worker runs only there, as a per-machine benchmark must.
    """
    if (pinned := job["requires"].get("worker")) and pinned != worker:
        return False
    if job["kind"] not in caps.get("kinds", []):
        return False
    if job["requires"].get("gpu_mem_gb", 0) > caps.get("gpu_mem_gb", 0):
        return False
    if caps.get("cache_only") and not set(job["inputs"]) <= cached:
        return False
    return True


class Queue:
    def __init__(self, path: str | Path, lease_s: float = 120.0, max_attempts: int = 3,
                 clock: Callable[[], float] = time.time):
        self.lease_s, self.max_attempts, self.clock = lease_s, max_attempts, clock
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        for col in ("progress TEXT", "started REAL"):     # added 2026-11-02: what a running job last reported
            try:
                self._db.execute(f"ALTER TABLE jobs ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass                                      # already there

    def close(self) -> None:
        self._db.close()

    # --- reading ---

    @staticmethod
    def _job(row: sqlite3.Row) -> dict:
        d = dict(row)
        for k in ("payload", "inputs", "requires", "result", "progress"):
            if d.get(k) is not None:
                d[k] = json.loads(d[k])
        d["group"] = d.pop("grp")
        return d

    def get(self, job_id: str) -> dict | None:
        row = self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(row) if row else None

    def jobs(self, state: str | None = None, limit: int = 200) -> list[dict]:
        if state:
            rows = self._db.execute("SELECT * FROM jobs WHERE state = ? ORDER BY updated DESC LIMIT ?",
                                    (state, limit))
        else:
            rows = self._db.execute("SELECT * FROM jobs ORDER BY updated DESC LIMIT ?", (limit,))
        return [self._job(r) for r in rows]

    def status(self) -> dict:
        with self._lock:
            self._expire()
            by_state = dict(self._db.execute("SELECT state, COUNT(*) FROM jobs GROUP BY state").fetchall())
            by_group = {}
            for grp, state, n in self._db.execute(
                    "SELECT COALESCE(grp, '-'), state, COUNT(*) FROM jobs GROUP BY grp, state"):
                by_group.setdefault(grp, {})[state] = n
            workers = []
            for r in self._db.execute("SELECT * FROM workers ORDER BY name"):
                held = [x[0] for x in self._db.execute(
                    "SELECT id FROM jobs WHERE state = 'leased' AND worker = ?", (r["name"],))]
                workers.append({"name": r["name"], "capabilities": json.loads(r["capabilities"]),
                                "last_seen": r["last_seen"], "leased": held})
        return {"now": self.clock(), "by_state": by_state, "by_group": by_group, "workers": workers}

    # --- writing ---

    def submit(self, kind: str, payload: dict, inputs: Iterable[str] = (), requires: dict | None = None,
               priority: int = 100, group: str | None = None, job_id: str | None = None) -> str:
        """Add a job. Submitting an id that exists is a no-op, so content-hash ids deduplicate work."""
        jid, now = job_id or uuid.uuid4().hex, self.clock()
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO jobs (id, kind, payload, inputs, requires, priority, grp, created, updated)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (jid, kind, json.dumps(payload), json.dumps(list(inputs)), json.dumps(requires or {}),
                 priority, group, now, now))
        return jid

    def lease(self, worker: str, capabilities: dict, cached: Iterable[str] = (), max_jobs: int = 1) -> list[dict]:
        cached, now = set(cached), self.clock()
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                self._expire()
                self._db.execute(
                    "INSERT INTO workers (name, capabilities, last_seen) VALUES (?, ?, ?)"
                    " ON CONFLICT(name) DO UPDATE SET capabilities = excluded.capabilities,"
                    " last_seen = excluded.last_seen", (worker, json.dumps(capabilities), now))
                picked = []
                if max_jobs > 0:
                    for row in self._db.execute(
                            "SELECT * FROM jobs WHERE state = 'queued' ORDER BY priority, created"):
                        job = self._job(row)
                        if eligible(job, capabilities, cached, worker):
                            picked.append(job)
                            if len(picked) == max_jobs:
                                break
                for job in picked:
                    self._db.execute(
                        "UPDATE jobs SET state = 'leased', worker = ?, lease_expires = ?, attempts = attempts + 1,"
                        " updated = ? WHERE id = ?", (worker, now + self.lease_s, now, job["id"]))
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
        return [self.get(j["id"]) for j in picked]

    def heartbeat(self, worker: str, job_ids: Iterable[str], progress: dict | None = None) -> list[str]:
        """Extend the worker's leases, and keep what each running job last reported (progress: job id -> {stage,
        done, total, since}; the first report marks the job started). Returns the ids it no longer holds, so it
        can stop working on them."""
        now, lost = self.clock(), []
        with self._lock:
            self._expire()
            self._db.execute("UPDATE workers SET last_seen = ? WHERE name = ?", (now, worker))
            for jid in job_ids:
                cur = self._db.execute(
                    "UPDATE jobs SET lease_expires = ?, updated = ? WHERE id = ? AND state = 'leased' AND worker = ?",
                    (now + self.lease_s, now, jid, worker))
                if cur.rowcount == 0:
                    lost.append(jid)
            for jid, p in (progress or {}).items():
                self._db.execute("UPDATE jobs SET progress = ?, started = COALESCE(started, ?) WHERE id = ? AND "
                                 "state = 'leased' AND worker = ?", (json.dumps(p), now, jid, worker))
        return lost

    def complete(self, worker: str, job_id: str, result: dict) -> bool:
        """Record a result. False if the job is already done (a duplicate) or doesn't exist."""
        now = self.clock()
        with self._lock:
            cur = self._db.execute(
                "UPDATE jobs SET state = 'done', worker = ?, result = ?, error = NULL, lease_expires = NULL,"
                " updated = ? WHERE id = ? AND state != 'done'", (worker, json.dumps(result), now, job_id))
            return cur.rowcount == 1

    def fail(self, worker: str, job_id: str, error: str) -> str | None:
        """A worker reports a failure. Requeued while attempts remain, else failed. Returns the new state."""
        now = self.clock()
        with self._lock:
            row = self._db.execute("SELECT state, worker, attempts FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row or row["state"] != "leased" or row["worker"] != worker:
                return None
            state = "queued" if row["attempts"] < self.max_attempts else "failed"
            self._db.execute(
                "UPDATE jobs SET state = ?, worker = CASE WHEN ? = 'queued' THEN NULL ELSE worker END,"
                " lease_expires = NULL, error = ?, updated = ? WHERE id = ?", (state, state, error, now, job_id))
            return state

    def _expire(self) -> None:
        """Lapsed leases go back to the queue, or fail after max_attempts. Caller holds the lock."""
        now = self.clock()
        self._db.execute(
            "UPDATE jobs SET state = 'failed', error = 'lease lapsed ' || attempts || ' times', lease_expires = NULL,"
            " updated = ? WHERE state = 'leased' AND lease_expires < ? AND attempts >= ?",
            (now, now, self.max_attempts))
        self._db.execute(
            "UPDATE jobs SET state = 'queued', worker = NULL, lease_expires = NULL, updated = ?"
            " WHERE state = 'leased' AND lease_expires < ?", (now, now))
