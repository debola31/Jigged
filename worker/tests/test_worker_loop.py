"""The loop outlives a connection that died while the box was asleep.

macOS freezes the process on sleep rather than killing it. On wake the frozen
Ollama request usually completes, and the first thing the worker does is REPORT
-- a write over a socket the pooler dropped minutes ago. Before the guard under
test, that raise escaped run(), the process exited, and nothing on the shop box
restarted it: one nap killed the worker until someone noticed the ask bar had
been saying "offline" all afternoon.
"""
from __future__ import annotations

import asyncio

import psycopg2

from worker import config as worker_config
from worker.__main__ import Worker


class _DbThatDiesOnReport:
    """Hands out one job, dies on its first write, then stops the loop."""

    def __init__(self) -> None:
        self.claims = 0
        self.worker: Worker | None = None

    def connect(self) -> None:
        pass

    def close(self) -> None:
        pass

    def heartbeat(self, *args, **kwargs) -> None:
        pass

    def sweep(self) -> int:
        return 0

    def renew_leases(self, *args, **kwargs) -> int:
        return 0

    def release_unstarted(self, *args, **kwargs) -> int:
        return 0

    def stand_down(self, *args, **kwargs) -> None:
        pass

    def insert_ai_call(self, *args, **kwargs) -> None:
        pass

    def claim(self, *args, **kwargs) -> list[dict]:
        self.claims += 1
        if self.claims == 1:
            return [{
                "job_id": "job-1", "feature": "insights", "model": "qwen3:32b",
                "company_id": "co-1", "request_id": "rid-1", "payload": {"question": "x"},
            }]
        assert self.worker is not None
        self.worker.stop()
        return []

    def mark_running(self, job_id: str, lease_seconds: int) -> None:
        raise psycopg2.OperationalError("server closed the connection unexpectedly")

    def mark_succeeded(self, *args, **kwargs) -> None:
        raise AssertionError("mark_running raised, so nothing should be reported")

    def mark_failed(self, *args, **kwargs) -> None:
        raise AssertionError("mark_running raised, so nothing should be reported")


def _config() -> worker_config.Config:
    return worker_config.Config(
        worker_id="desktop-1",
        database_url="postgresql://jigged_ai_worker:pw@remote:5432/postgres",
        readonly_database_url="postgresql://jigged_ai_readonly:pw@remote:5432/postgres",
        ollama_base_url="http://localhost:11434/v1",
        models=("qwen3:32b",),
        poll_seconds=0.0,
    )


def test_a_write_over_a_dead_connection_does_not_end_the_loop():
    worker = Worker(_config())
    db = _DbThatDiesOnReport()
    db.worker = worker
    worker.db = db  # type: ignore[assignment]

    asyncio.run(worker.run())  # escaped as OperationalError before the guard existed

    assert db.claims == 2, "the loop did not come back for the next claim"



class _DbCountingBeats(_DbThatDiesOnReport):
    """One job that takes a while; counts what the worker did meanwhile."""

    def __init__(self) -> None:
        super().__init__()
        self.beats = 0
        self.renewals = 0

    def heartbeat(self, *args, **kwargs) -> None:
        self.beats += 1

    def renew_leases(self, *args, **kwargs) -> int:
        self.renewals += 1
        return 1

    def mark_running(self, job_id: str, lease_seconds: int) -> None:
        pass

    def mark_succeeded(self, *args, **kwargs) -> None:
        pass


def test_the_heartbeat_and_the_lease_renewal_keep_going_during_a_job(monkeypatch):
    """A 116 s question made the box read as offline to the next question: the
    heartbeat ticked only between jobs and went stale at 60 s, so the route
    answered 503 twice in the middle of a healthy run. With 480 s calls a job
    could also outlive its 300 s lease. Both now beat on their own task."""
    import worker.__main__ as worker_main

    db = _DbCountingBeats()
    cfg = worker_config.Config(
        worker_id="desktop-1",
        database_url="postgresql://jigged_ai_worker:pw@remote:5432/postgres",
        readonly_database_url="postgresql://jigged_ai_readonly:pw@remote:5432/postgres",
        ollama_base_url="http://localhost:11434/v1",
        models=("qwen3:32b",),
        poll_seconds=0.0,
        heartbeat_seconds=0.01,
    )
    w = Worker(cfg)
    db.worker = w
    w.db = db  # type: ignore[assignment]
    monkeypatch.setattr(worker_main, "LEASE_RENEW_SECONDS", 0.0)

    async def slow_job(job):
        await asyncio.sleep(0.12)

    monkeypatch.setattr(w, "_run_one", slow_job)
    asyncio.run(w.run())

    # Before: one beat at start and one after the job. During a 0.12 s job at a
    # 0.01 s cadence there are several more, and the held lease is renewed.
    assert db.beats >= 5, db.beats
    assert db.renewals >= 1, db.renewals
