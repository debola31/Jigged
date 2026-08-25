"""The worker loop: sweep, claim, run, report, heartbeat.

    conda run -n jigged python -m worker

WHAT MAKES THIS SAFE TO RUN. It creates no work. claim_ai_jobs() returns nothing
on an empty queue, and this process does nothing when it returns nothing -- which
is the line that makes CLAUDE.md's "never invoke an AI endpoint from a polling
loop" carve-out true rather than a lawyer's reading. A poll may DISCOVER work; it
may never originate it.

WHAT MAKES IT SAFE TO KILL. Ctrl-C releases unstarted claims back to `queued`,
fails whatever was mid-flight as `ai_offline`, and backdates the heartbeat -- so
the UI reaches its offline state within one poll instead of after a two-minute
silence.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time
from decimal import Decimal
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# The worker runs the SAME feature handlers and the SAME provider layer as the
# backend, so a bug cannot diverge between them. api/ goes on the path the way
# index.py does it, which is also why those modules import as `services.x`.
_ROOT = Path(__file__).resolve().parents[1]
_API_DIR = _ROOT / "api"
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from worker import config as worker_config  # noqa: E402
from worker.db import WorkerDb  # noqa: E402

logging.basicConfig(
    level=os.getenv("WORKER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("worker")

LEASE_RENEW_SECONDS = 60


class Worker:
    def __init__(self, cfg: worker_config.Config) -> None:
        self.cfg = cfg
        self.db = WorkerDb(cfg.database_url)
        self.resident_model: str | None = None
        self.held: list[dict[str, Any]] = []
        self._stopping = False
        self._last_heartbeat = 0.0
        self._last_renew = 0.0

    # ------------------------------------------------------------- provider

    def _chain(self, model: str) -> list[Any]:
        """One local provider for the model the JOB was enqueued with.

        Built from the job row rather than resolved from env, and that matters for
        correctness rather than convenience: the claim batches by model, so honouring
        anything other than the model on the row would break the batching it just
        paid for.
        """
        from services.llm.openai_compat import OpenAICompatProvider

        return [
            OpenAICompatProvider(
                base_url=self.cfg.ollama_base_url,
                api_key=None,
                model=model,
                price_in_per_mtok=Decimal("0"),
                price_out_per_mtok=Decimal("0"),
                name="ollama",
                timeout_s=self.cfg.request_timeout_s,
                # `think: false` is the NATIVE /api/chat knob and does nothing here.
                # The unconditional <think> strip is the actual guarantee either way.
                extra_body={"reasoning_effort": "none"},
            )
        ]

    async def _audit(self, row: dict[str, Any]) -> None:
        """Ledger writer for this process: libpq as jigged_ai_worker, not PostgREST."""
        await asyncio.to_thread(self.db.insert_ai_call, row)

    # ------------------------------------------------------------ lifecycle

    def stop(self, *_: Any) -> None:
        if not self._stopping:
            logger.info("shutdown requested; finishing the current job")
        self._stopping = True

    def _tick_heartbeat(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_heartbeat < self.cfg.heartbeat_seconds:
            return
        try:
            self.db.heartbeat(
                self.cfg.worker_id, list(self.cfg.models), self.resident_model, self.cfg.version
            )
            self._last_heartbeat = now
        except Exception as exc:  # noqa: BLE001 - a missed beat is not fatal
            logger.warning("heartbeat failed: %s", exc)

    def _tick_leases(self) -> None:
        now = time.monotonic()
        if not self.held or now - self._last_renew < LEASE_RENEW_SECONDS:
            return
        try:
            n = self.db.renew_leases(self.cfg.worker_id, self.cfg.lease_seconds)
            self._last_renew = now
            logger.debug("renewed %s lease(s)", n)
        except Exception as exc:  # noqa: BLE001
            logger.warning("lease renewal failed: %s", exc)

    # ----------------------------------------------------------------- work

    async def _run_one(self, job: dict[str, Any]) -> None:
        from services.ai_features import JobContext, handler_for
        from services.llm.errors import LLMChainExhausted, LLMError

        job_id = str(job["job_id"])
        feature, model = job["feature"], job["model"]
        started = time.perf_counter()
        logger.info("running %s (%s / %s)", job_id, feature, model)

        await asyncio.to_thread(self.db.mark_running, job_id, self.cfg.lease_seconds)
        try:
            handler = handler_for(feature)
        except LookupError as exc:
            await asyncio.to_thread(self.db.mark_failed, job_id, str(exc), "internal")
            logger.error("no handler for %s: %s", feature, exc)
            return

        try:
            result = await handler(
                JobContext(
                    feature=feature,
                    company_id=str(job["company_id"]),
                    request_id=str(job["request_id"]),
                    payload=job.get("payload") or {},
                    chain=self._chain(model),
                    audit_writer=self._audit,
                )
            )
        except LLMChainExhausted as exc:
            # A local chain that failed is this box, and this box is the thing that
            # is meant to fail visibly. 'ai_offline' is what the UI reads to say so.
            kind = "ai_offline" if exc.is_offline else "provider"
            await asyncio.to_thread(self.db.mark_failed, job_id, str(exc), kind)
            logger.warning("job %s failed (%s): %s", job_id, kind, exc)
            return
        except LLMError as exc:
            await asyncio.to_thread(self.db.mark_failed, job_id, str(exc), "provider")
            logger.warning("job %s failed: %s", job_id, exc)
            return
        except Exception as exc:  # noqa: BLE001 - every failure becomes a terminal row
            await asyncio.to_thread(self.db.mark_failed, job_id, str(exc), "internal")
            logger.exception("job %s raised", job_id)
            return

        await asyncio.to_thread(self.db.mark_succeeded, job_id, result)
        logger.info("finished %s in %.1fs", job_id, time.perf_counter() - started)

    async def _drain(self, batch: list[dict[str, Any]]) -> None:
        """Run a claimed batch, one job at a time.

        Serial on purpose: NUM_PARALLEL=1 on the box, one resident model, and two
        concurrent generations on one GPU are slower than two sequential ones plus
        a memory risk. The batch exists to amortise the model LOAD, not to overlap
        inference.
        """
        self.held = list(batch)
        self._last_renew = time.monotonic()
        try:
            for job in batch:
                if self._stopping:
                    break
                self.resident_model = job["model"]
                await self._run_one(job)
                self._tick_heartbeat()
                self._tick_leases()
        finally:
            self.held = []

    async def run(self) -> None:
        self.db.connect()
        self._tick_heartbeat(force=True)
        # The sandbox target is in the banner because "which database answered"
        # is not something anyone should have to infer from a wrong number later.
        from tools.sql_executor import describe_dsn

        logger.info(
            "worker %s ready; models=%s ollama=%s sandbox=%s",
            self.cfg.worker_id, ", ".join(self.cfg.models), self.cfg.ollama_base_url,
            describe_dsn(self.cfg.readonly_database_url),
        )

        while not self._stopping:
            try:
                self.db.sweep()
                batch = self.db.claim(
                    self.cfg.worker_id,
                    list(self.cfg.models),
                    self.resident_model,
                    self.cfg.claim_limit,
                    self.cfg.lease_seconds,
                )
            except Exception as exc:  # noqa: BLE001 - the queue may be briefly unreachable
                logger.warning("claim failed: %s", exc)
                await asyncio.sleep(self.cfg.poll_seconds * 2)
                self._tick_heartbeat()
                continue

            if not batch:
                # Nothing to do, and therefore nothing done. No model is called, no
                # ai_calls row is written, no cost is incurred.
                self._tick_heartbeat()
                await asyncio.sleep(self.cfg.poll_seconds)
                continue

            logger.info("claimed %s job(s) of %s", len(batch), batch[0]["model"])
            await self._drain(batch)

        await self._shutdown()

    async def _shutdown(self) -> None:
        try:
            released = self.db.release_unstarted(self.cfg.worker_id)
            if released:
                logger.info("released %s unstarted job(s) back to the queue", released)
            self.db.stand_down(self.cfg.worker_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("shutdown housekeeping failed: %s", exc)
        finally:
            self.db.close()
        logger.info("worker %s stopped", self.cfg.worker_id)


def load_env(root: Path = _ROOT) -> None:
    """Populate os.environ from .env.local, the shell still winning over it.

    Nothing else does this: the worker is started from a shell rather than by Vercel,
    and api/index.py's load_dotenv covers the backend only -- so until this existed, a
    fully-populated .env.local still failed at startup.

    ONE FILE NOW, and that is the whole point of WORKER_READONLY_DATABASE_URL. This
    used to read worker/.env first and .env.local second, because both defined
    AI_READONLY_DATABASE_URL with different values and the LOAD ORDER decided which
    database the SQL sandbox got. Naming the worker's copy apart deleted the
    collision, and the ordering rule with it. override=False keeps the shell ahead of
    the file, which is the only precedence left. A missing file is not an error --
    the shell alone still works.
    """
    load_dotenv(root / ".env.local", override=False)


def export_sandbox_dsn(cfg: worker_config.Config) -> None:
    """Point tools.sql_executor at the WORKER's read-only DSN.

    That module reads AI_READONLY_DATABASE_URL at pool creation and the pool is lazy,
    so this has to be in place before the first insights job -- not before the first
    import.

    ASSIGNMENT, NEVER setdefault. .env.local defines AI_READONLY_DATABASE_URL as the
    local stack for the backend's own use, and load_env() has already put it in
    os.environ by the time this runs. A setdefault would therefore find it present,
    do nothing, and leave every query this worker runs pointed at 127.0.0.1 -- which
    on a shop box is a refused connection, and on a developer box is the WRONG SHOP'S
    DATABASE answering. It was a setdefault while worker/.env existed, where it was
    right for the same reason it is wrong now.
    """
    os.environ["AI_READONLY_DATABASE_URL"] = cfg.readonly_database_url


def main() -> int:
    load_env()

    try:
        cfg = worker_config.load()
    except worker_config.WorkerMisconfigured as exc:
        logger.error("%s", exc)
        return 2

    export_sandbox_dsn(cfg)

    worker = Worker(cfg)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, worker.stop)
    asyncio.run(worker.run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
