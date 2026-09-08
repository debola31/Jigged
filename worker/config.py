"""Worker configuration, read once at startup.

Unlike the backend -- which reads env inside functions so tests can monkeypatch a
running app -- the worker is a long-lived process started from a shell. Reading
once and failing loudly at startup is better here: a missing DSN discovered on
the first claim would leave jobs queued and the UI showing "offline" with no
explanation on the box itself.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


class WorkerMisconfigured(RuntimeError):
    """Startup refused. Always names the variable and what it is for."""


@dataclass(frozen=True)
class Config:
    worker_id: str
    database_url: str
    readonly_database_url: str
    ollama_base_url: str
    models: tuple[str, ...]
    # Claimed leases must outlast the slowest single job comfortably; the loop
    # renews across EVERY held job every 60s regardless.
    lease_seconds: int = 300
    heartbeat_seconds: int = 15
    poll_seconds: float = 2.0
    # Capped at 8 in SQL too. Claim size IS the worst-case interactive latency,
    # because preemption only happens at a claim boundary.
    claim_limit: int = 8
    # Per model call. MEASURED, not guessed: on the 48 GB M4 Max the FIRST call
    # to a cold qwen3:32b -- load plus the ~13K-token prefill -- ran past 120 s and
    # was reported as `ai_offline` while the box was alive; the warm median was 25 s
    # because the prefix cache absorbs the prefill. 480 covers the cold path: this box
    # prefills uncached at ~100 tokens/s, and a long thread's evicted prefix is ~18K. The
    # cost is a hung Ollama taking four minutes to fail a job, which the UI never
    # waits for: its offline verdict comes from the heartbeat, not from this.
    request_timeout_s: float = 480.0
    version: str = "1"
    extra: dict = field(default_factory=dict)


def _require(name: str, purpose: str) -> str:
    value = os.getenv(name)
    if not value:
        raise WorkerMisconfigured(f"{name} is not set. It is {purpose}.")
    return value


def load() -> Config:
    readonly = _require(
        "WORKER_READONLY_DATABASE_URL",
        "the read-only connection the insights execute_sql sandbox runs on, as "
        "jigged_ai_readonly. Named apart from AI_READONLY_DATABASE_URL deliberately: "
        "one .env.local holds both, and that one is the LOCAL stack",
    )
    # The separate NAME is the actual fix here. AI_READONLY_DATABASE_URL is the local
    # postgres SUPERUSER, which is BYPASSRLS -- every tenant-scoping guarantee in the
    # SQL sandbox off, queries silently returning other companies' rows. Fine on a
    # local stack, catastrophic for a worker serving real shops. While both processes
    # read one name, the only thing standing between them was load order. Now nothing
    # the backend sets can reach this value, and the check below is a backstop for a
    # hand-pasted DSN rather than the guarantee itself.
    if "://postgres:" in readonly and "127.0.0.1" not in readonly and "localhost" not in readonly:
        raise WorkerMisconfigured(
            "WORKER_READONLY_DATABASE_URL points at the `postgres` superuser on a "
            "non-local host. That role is BYPASSRLS, so the SQL sandbox's per-company "
            "scoping would silently do nothing. Use the jigged_ai_readonly role."
        )

    return Config(
        worker_id=_require("WORKER_ID", "how this box identifies itself in ai_workers"),
        database_url=_require(
            "WORKER_DATABASE_URL",
            "the queue connection, as the least-privilege jigged_ai_worker role -- "
            "never the service-role key",
        ),
        readonly_database_url=readonly,
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1"),
        models=tuple(
            m.strip() for m in os.getenv("WORKER_MODELS", "qwen3:8b").split(",") if m.strip()
        ),
        lease_seconds=int(os.getenv("WORKER_LEASE_SECONDS", "300")),
        version=os.getenv("WORKER_VERSION", "1"),
    )


__all__ = ["Config", "WorkerMisconfigured", "load"]
