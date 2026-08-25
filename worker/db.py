"""The worker's queue connection, as jigged_ai_worker over libpq.

WHAT THIS ROLE CAN DO, AND THEREFORE WHAT THIS MODULE CAN DO: claim and report
ai_jobs, insert ai_calls, maintain its own ai_workers row. Nothing else. It holds
no SELECT on any tenant table and never the service-role key -- the insights SQL
sandbox runs on a SECOND connection as jigged_ai_readonly, reusing that role's 29
existing ai_readonly_select policies rather than duplicating them onto this one.

Every statement here runs through RLS, because claim_ai_jobs() and sweep_ai_jobs()
are SECURITY INVOKER. That is what makes "the worker can only see executor='worker'
rows" a property of the database rather than of this file's care.
"""
from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)


class WorkerDb:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._conn: Any = None

    def connect(self) -> None:
        self._conn = psycopg2.connect(self._dsn)
        # Autocommit: each statement here is its own unit of work, and holding a
        # transaction open across a 30-second model call would pin the claim's row
        # locks for the whole generation -- which is exactly what SKIP LOCKED is
        # meant to avoid.
        self._conn.autocommit = True

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    @contextmanager
    def _cursor(self) -> Iterator[Any]:
        if self._conn is None or self._conn.closed:
            self.connect()
        try:
            with self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                yield cur
        except psycopg2.OperationalError:
            # A dropped connection must not end the worker: the box may have slept,
            # or Supabase may have recycled the pooler. Reconnect on the next call.
            logger.warning("worker db connection lost; will reconnect")
            self.close()
            raise

    # ------------------------------------------------------------- heartbeat

    def heartbeat(self, worker_id: str, models: list[str], resident_model: str | None,
                  version: str) -> None:
        """Say we are alive, and say which models we can serve.

        `models` is what the sweep checks against, and it checks per MODEL: a worker
        that is up but has never loaded qwen3-vl:4b must not keep a drawing job
        queued forever while looking alive. Advertising a model we cannot actually
        serve is therefore worse than advertising nothing.
        """
        with self._cursor() as cur:
            cur.execute(
                "INSERT INTO public.ai_workers (worker_id, models, resident_model, version,"
                " last_seen_at) VALUES (%s, %s, %s, %s, now())"
                " ON CONFLICT (worker_id) DO UPDATE SET models = EXCLUDED.models,"
                " resident_model = EXCLUDED.resident_model, version = EXCLUDED.version,"
                " last_seen_at = now()",
                (worker_id, models, resident_model, version),
            )

    def stand_down(self, worker_id: str) -> None:
        """Backdate the heartbeat on a clean shutdown.

        BACKDATE, DO NOT DELETE. ai_jobs.claimed_by names this worker on rows it has
        already completed, and deleting the registry row would erase that provenance
        from the historical record. Backdating reads as offline within one poll,
        which is the whole point of a graceful shutdown.
        """
        with self._cursor() as cur:
            cur.execute(
                "UPDATE public.ai_workers SET last_seen_at = now() - interval '1 hour',"
                " resident_model = NULL WHERE worker_id = %s",
                (worker_id,),
            )

    # ----------------------------------------------------------------- queue

    def sweep(self) -> int:
        """Reconcile abandoned jobs -- OURS ONLY.

        RLS scopes this to executor='worker'. A stuck BACKEND row is invisible here
        and stays that way: the enqueue route's service_role sweep collects it, and
        the frontend's deadline rule is what protects the person watching it.
        """
        with self._cursor() as cur:
            cur.execute("SELECT public.sweep_ai_jobs() AS n")
            return int((cur.fetchone() or {}).get("n") or 0)

    def claim(self, worker_id: str, models: list[str], resident_model: str | None,
              limit: int, lease_seconds: int) -> list[dict[str, Any]]:
        with self._cursor() as cur:
            cur.execute(
                "SELECT * FROM public.claim_ai_jobs(%s, %s, %s, %s, %s)",
                (worker_id, models, resident_model, limit, lease_seconds),
            )
            return [dict(r) for r in cur.fetchall()]

    def renew_leases(self, worker_id: str, lease_seconds: int) -> int:
        """Extend EVERY job this worker holds, not just the one executing.

        Renewing only the running job is a real bug at batch scale: claim 8 pages at
        30 seconds each and job 8 sits `claimed` with a stale lease for three and a
        half minutes before it is even started, so the sweep times it out mid-queue.
        The lease means "this worker is alive and still owns these", not "this one is
        executing".
        """
        with self._cursor() as cur:
            cur.execute(
                "UPDATE public.ai_jobs SET lease_expires_at = now() + make_interval(secs => %s)"
                " WHERE claimed_by = %s AND status IN ('claimed', 'running')",
                (lease_seconds, worker_id),
            )
            return cur.rowcount

    def release_unstarted(self, worker_id: str) -> int:
        """Hand back what we claimed but never began, on shutdown.

        Better than letting them lease-expire: another worker (or this one after a
        restart) can take them immediately, and the user sees a slightly longer wait
        rather than a failure.
        """
        with self._cursor() as cur:
            cur.execute(
                "UPDATE public.ai_jobs SET status = 'queued', claimed_by = NULL,"
                " claimed_at = NULL, lease_expires_at = NULL"
                " WHERE claimed_by = %s AND status = 'claimed'",
                (worker_id,),
            )
            return cur.rowcount

    def mark_running(self, job_id: str, lease_seconds: int) -> None:
        with self._cursor() as cur:
            cur.execute(
                "UPDATE public.ai_jobs SET status = 'running',"
                " lease_expires_at = now() + make_interval(secs => %s) WHERE id = %s",
                (lease_seconds, job_id),
            )

    def mark_succeeded(self, job_id: str, result: dict[str, Any]) -> None:
        with self._cursor() as cur:
            cur.execute(
                "UPDATE public.ai_jobs SET status = 'succeeded', result = %s,"
                " finished_at = now() WHERE id = %s",
                (json.dumps(result), job_id),
            )

    def mark_failed(self, job_id: str, error: str, error_kind: str) -> None:
        with self._cursor() as cur:
            cur.execute(
                "UPDATE public.ai_jobs SET status = 'failed', error = %s, error_kind = %s,"
                " finished_at = now() WHERE id = %s",
                ((error or "unknown failure")[:2048], error_kind, job_id),
            )

    # ---------------------------------------------------------------- ledger

    def insert_ai_call(self, row: dict[str, Any]) -> None:
        """Append one attempt to the ledger.

        NO RETURNING CLAUSE: the worker holds INSERT and deliberately not SELECT, so
        asking for the row back would fail on a permission the role is not meant to
        have. est_cost_usd arrives as a string and Postgres casts it into numeric
        without losing a digit.
        """
        with self._cursor() as cur:
            cur.execute(
                "INSERT INTO public.ai_calls (feature, provider, model, tokens_in, tokens_out,"
                " latency_ms, est_cost_usd, request_id, success, error)"
                " VALUES (%(feature)s, %(provider)s, %(model)s, %(tokens_in)s, %(tokens_out)s,"
                " %(latency_ms)s, %(est_cost_usd)s, %(request_id)s, %(success)s, %(error)s)",
                row,
            )


__all__ = ["WorkerDb"]
