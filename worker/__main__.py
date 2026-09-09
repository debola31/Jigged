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

WHAT MAKES IT SAFE TO SLEEP. macOS freezes this process rather than killing it,
and the pooler drops the socket while it is frozen. The first statement on wake
therefore raises, and for a while that raise escaped run() and ended the process
-- one nap killed the worker until someone noticed. A batch that fails is now
logged and the loop carries on; WorkerDb reconnects on the next statement and the
lease sweep collects whatever the batch still held.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
import sys
import time
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

from worker import branches as worker_branches  # noqa: E402
from worker import config as worker_config  # noqa: E402
from worker import status as worker_status  # noqa: E402
from worker.db import WorkerDb  # noqa: E402

logging.basicConfig(
    level=os.getenv("WORKER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("worker")

LEASE_RENEW_SECONDS = 60


class Worker:
    """One process, every database the shop's AI answers for.

    Production always, and since 2026-09-09 every live Supabase preview branch
    beside it (worker/branches.py), because a preview deployment enqueues into its
    own branch and a worker that polls production alone leaves every preview
    reading "insights are temporarily unavailable".

    The databases are kept in dicts keyed by project ref rather than one `self.db`,
    and each carries its OWN heartbeat clock: `ai_workers` is per database, so
    beating production must not silence a branch. What stays single is what the
    box itself is: one resident model, one Ollama slot, one job at a time.
    """

    def __init__(self, cfg: worker_config.Config) -> None:
        self.cfg = cfg
        self.dbs: dict[str, WorkerDb] = {}
        self.served: dict[str, worker_branches.Served] = {}
        self.resident_model: str | None = None
        self.held: list[dict[str, Any]] = []
        # Which database the held batch came from. Execution is serial, so one ref
        # is never ambiguous -- and lease renewal has to reach the right database.
        self.held_ref: str | None = None
        self._stopping = False
        self._last_heartbeat: dict[str, float] = {}
        self._last_renew = 0.0
        self._last_discovery = 0.0
        # Per-database reachability AS THIS PROCESS SEES IT -- not staleness.
        # The Wi-Fi-drop shape is a live process whose beats are all failing,
        # and only the except branch in _tick_heartbeat can tell that apart
        # from health. Published by _publish; nothing else reads it.
        self._db_health: dict[str, dict[str, Any]] = {}
        self._started_at = worker_status.now_iso()
        self._commit: str | None = None
        self._last_job: dict[str, Any] | None = None

    # ------------------------------------------------------------- provider

    def _chain(self, model: str) -> list[Any]:
        """One local provider for the model the JOB was enqueued with.

        Built from the job row rather than resolved from env, and that matters for
        correctness rather than convenience: the claim batches by model, so honouring
        anything other than the model on the row would break the batching it just
        paid for.

        The NATIVE adapter: it pins the 32K context window per request and turns an
        over-long prompt into a visible failure, where the /v1 path silently cut the
        schema off the front. OLLAMA_CONTEXT_LENGTH on the box is now belt-and-braces.
        """
        from services.llm.ollama_provider import OllamaProvider

        return [
            OllamaProvider(
                base_url=self.cfg.ollama_base_url,
                model=model,
                timeout_s=self.cfg.request_timeout_s,
            )
        ]

    async def _audit(self, row: dict[str, Any]) -> None:
        """Ledger writer for this process: libpq as jigged_ai_worker, not PostgREST.

        Into the database the job came from, so a branch's attempts are that
        branch's ledger and production's stay production's.
        """
        db = self.dbs.get(self.held_ref or "")
        if db is None:
            logger.warning("no database in hand for the ai_calls row; dropped")
            return
        await asyncio.to_thread(db.insert_ai_call, row)

    # ------------------------------------------------------------ lifecycle

    def stop(self, *_: Any) -> None:
        if not self._stopping:
            logger.info("shutdown requested; finishing the current job")
        self._stopping = True

    def _tick_heartbeat(self, force: bool = False) -> None:
        """Beat into EVERY database served, each on its own clock.

        `ai_workers` lives in each database and each route reads its own, so a
        preview only stops saying "offline" once the beat lands there. One clock
        for all of them would let a single beat satisfy the gate and starve the
        rest; one failure must not skip the others, hence the per-database try.
        """
        now = time.monotonic()
        for ref, db in list(self.dbs.items()):
            if not force and now - self._last_heartbeat.get(ref, 0.0) < self.cfg.heartbeat_seconds:
                continue
            try:
                db.heartbeat(
                    self.cfg.worker_id, list(self.cfg.models), self.resident_model, self.cfg.version
                )
                self._last_heartbeat[ref] = now
                self._db_health[ref] = {
                    "reachable": True, "last_ok_at": worker_status.now_iso(), "error": None,
                }
            except Exception as exc:  # noqa: BLE001 - a missed beat is not fatal
                # last_ok_at is CARRIED FORWARD, never cleared: "unreachable since
                # 11:49" is a diagnosis and "unreachable" on its own is not.
                prev = self._db_health.get(ref) or {}
                self._db_health[ref] = {
                    "reachable": False,
                    "last_ok_at": prev.get("last_ok_at"),
                    "error": str(exc)[:200],
                }
                logger.warning("heartbeat failed on %s: %s", self._label(ref), exc)

    def _tick_leases(self) -> None:
        now = time.monotonic()
        if not self.held or now - self._last_renew < LEASE_RENEW_SECONDS:
            return
        db = self.dbs.get(self.held_ref or "")
        if db is None:
            return
        try:
            n = db.renew_leases(self.cfg.worker_id, self.cfg.lease_seconds)
            self._last_renew = now
            logger.debug("renewed %s lease(s)", n)
        except Exception as exc:  # noqa: BLE001
            logger.warning("lease renewal failed on %s: %s", self._label(self.held_ref), exc)

    def _label(self, ref: str | None) -> str:
        """What to call a database in a log line. A wrong-database run has to LOOK wrong."""
        served = self.served.get(ref or "")
        return f"{served.label} ({ref})" if served else str(ref)

    def _publish(self, *, stopped: bool = False) -> None:
        """Say on disk what only this process knows.

        NOT an IPC surface: nothing reads back in, and a reader that finds this
        file missing or stale must cope. Three call sites -- the ready banner, every
        _keepalive tick (which runs DURING a job, which is why busy/held/
        resident_model stay true through a 480 s generation), and the end of
        _shutdown.

        IT CANNOT RAISE, AND THAT IS THE POINT OF THE CATCH. One of those call
        sites is inside _keepalive, whose body is unguarded: an exception there
        kills the task, and with it the heartbeat and lease renewal, so the box
        would read offline within 60 seconds and jobs would be swept mid-run.
        Letting a convenience file take production down that way would invert every
        priority this process has. status.write() already swallows OSError; this
        covers everything else, loudly enough to be found in the log.
        """
        try:
            self._publish_unguarded(stopped=stopped)
        except Exception as exc:  # noqa: BLE001 - never worth the heartbeat
            logger.warning("status file not written: %s", exc)

    def _publish_unguarded(self, *, stopped: bool = False) -> None:
        databases = [
            {
                "ref": s.ref, "label": s.label, "is_default": s.is_default,
                **(self._db_health.get(s.ref)
                   or {"reachable": False, "last_ok_at": None, "error": "no beat yet"}),
            }
            for s in self._rotation()
        ]
        worker_status.write(worker_status.snapshot(
            worker_id=self.cfg.worker_id, version=self.cfg.version,
            models=self.cfg.models, resident_model=self.resident_model,
            ollama_base_url=self.cfg.ollama_base_url,
            heartbeat_seconds=self.cfg.heartbeat_seconds,
            repo=_ROOT, commit=self._commit, started_at=self._started_at,
            databases=databases, busy=bool(self.held), held=len(self.held),
            last_job=self._last_job, stopped=stopped,
        ))

    async def _keepalive(self) -> None:
        """Heartbeat and lease renewal on their own task, so they happen DURING a job.

        Both used to tick only between jobs. A 116 s question then made the box
        read as offline to every new question -- the heartbeat went stale at 60 s
        and the route answered 503 "insights are unavailable" -- until the answer
        landed; and with 480 s calls a single job could outlive its own 300 s
        lease and be swept mid-run. The model call is an awaited HTTP request, so
        the loop is free to beat while it runs. Measured 2026-09-07 on the
        eight-turn re-test: two 503s in the middle of a healthy run.
        """
        while not self._stopping:
            await asyncio.sleep(self.cfg.heartbeat_seconds)
            self._tick_heartbeat(force=True)
            self._tick_leases()
            self._publish()

    # ----------------------------------------------------------------- work

    async def _run_one(self, job: dict[str, Any], served: worker_branches.Served) -> None:
        from services.ai_features import JobContext, handler_for
        from services.ai_features.base import result_kind
        from services.llm.errors import LLMChainExhausted, LLMError, LLMErrorEcho

        job_id = str(job["job_id"])
        feature, model = job["feature"], job["model"]
        started = time.perf_counter()
        logger.info("running %s (%s / %s) on %s", job_id, feature, model, self._label(served.ref))

        db = self.dbs[served.ref]
        await asyncio.to_thread(db.mark_running, job_id, self.cfg.lease_seconds)
        try:
            handler = handler_for(feature)
        except LookupError as exc:
            await asyncio.to_thread(db.mark_failed, job_id, str(exc), "internal")
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
                    # WHICH DATABASE THIS JOB'S SQL RUNS AGAINST. Named per job
                    # rather than left to the environment, because this process
                    # serves several: the sandbox DSN was built from the same ref
                    # as the queue this job was claimed from, so a preview's
                    # question cannot reach production's data.
                    readonly_dsn=served.sandbox_dsn,
                )
            )
        except LLMChainExhausted as exc:
            # A local chain that failed is this box, and this box is the thing that
            # is meant to fail visibly. 'ai_offline' is what the UI reads to say so;
            # 'context_overflow' is the prompt no longer fitting the window, which
            # the user fixes by starting a new conversation.
            if exc.is_offline:
                kind = "ai_offline"
            elif exc.is_context_overflow:
                kind = "context_overflow"
            else:
                kind = "provider"
            await asyncio.to_thread(db.mark_failed, job_id, str(exc), kind)
            logger.warning("job %s failed (%s): %s", job_id, kind, exc)
            return
        except LLMErrorEcho as exc:
            # Ahead of the generic LLMError branch: the provider answered fine,
            # so filing this as 'provider' would hide the failure the gate exists
            # to make countable.
            await asyncio.to_thread(db.mark_failed, job_id, str(exc), "error_echo")
            logger.warning("job %s produced no answer: %s", job_id, exc)
            return
        except LLMError as exc:
            await asyncio.to_thread(db.mark_failed, job_id, str(exc), "provider")
            logger.warning("job %s failed: %s", job_id, exc)
            return
        except Exception as exc:  # noqa: BLE001 - every failure becomes a terminal row
            await asyncio.to_thread(db.mark_failed, job_id, str(exc), "internal")
            logger.exception("job %s raised", job_id)
            return

        # A question the model answered with a report settles as one: result_kind
        # reads the handler's verdict and the UPDATE flips the row's kind with it.
        await asyncio.to_thread(db.mark_succeeded, job_id, result, result_kind(result))
        elapsed = time.perf_counter() - started
        self._last_job = {
            "job_id": job_id, "feature": feature, "model": model,
            "seconds": round(elapsed, 1), "finished_at": worker_status.now_iso(),
        }
        logger.info("finished %s in %.1fs", job_id, elapsed)

    async def _drain(self, batch: list[dict[str, Any]], served: worker_branches.Served) -> None:
        """Run a claimed batch, one job at a time.

        Serial on purpose: NUM_PARALLEL=1 on the box, one resident model, and two
        concurrent generations on one GPU are slower than two sequential ones plus
        a memory risk. The batch exists to amortise the model LOAD, not to overlap
        inference. That is a property of the BOX, not of a database, so serving
        several changes nothing here: one batch, from one database, at a time.
        """
        self.held = list(batch)
        self.held_ref = served.ref
        self._last_renew = time.monotonic()
        try:
            for job in batch:
                if self._stopping:
                    break
                self.resident_model = job["model"]
                await self._run_one(job, served)
                self._tick_heartbeat()
                self._tick_leases()
        finally:
            self.held = []
            self.held_ref = None

    async def _adopt(self, served: worker_branches.Served) -> bool:
        """Start serving one database. False means not this pass, and that is fine.

        Production is connected eagerly by run() and a failure there is fatal, the
        way a missing DSN is: a shop box that cannot reach its own queue should say
        so loudly. A BRANCH is best effort -- it may be healthy per the API and
        still refuse the seed's login for a moment -- so it is logged and retried
        at the next discovery rather than taking the process down with it.
        """
        db = WorkerDb(served.queue_dsn)
        try:
            await asyncio.to_thread(db.connect)
        except Exception as exc:  # noqa: BLE001 - see the docstring
            logger.warning("cannot serve %s yet: %s", self._label(served.ref), exc)
            db.close()
            return False
        self.dbs[served.ref] = db
        self.served[served.ref] = served
        return True

    async def _retire(self, ref: str) -> None:
        """Stop serving one database, closing the sandbox pool it opened.

        A branch goes when its PR closes and Supabase deletes it. Standing down
        first keeps `ai_workers` honest there for whatever remains of its life.
        """
        from tools.sql_executor import close_pool

        served = self.served.pop(ref, None)
        db = self.dbs.pop(ref, None)
        self._last_heartbeat.pop(ref, None)
        self._db_health.pop(ref, None)
        if db is not None:
            with contextlib.suppress(Exception):
                db.stand_down(self.cfg.worker_id)
            db.close()
        if served is not None:
            await close_pool(served.sandbox_dsn)
        logger.info("no longer serving %s", self._label(ref))

    async def _discover(self, force: bool = False) -> list[worker_branches.Served]:
        """Ask Supabase which databases exist, and reconcile what is being served.

        Never lets a discovery failure shrink the list: branches.discover always
        returns production, and an unreachable API returns no branches rather than
        an empty world, so the worst case is that a new preview joins late.

        Returns what was discovered -- production first -- so startup can insist on
        production without asking twice.
        """
        now = time.monotonic()
        if not force and now - self._last_discovery < self.cfg.discover_seconds:
            return list(self.served.values())
        self._last_discovery = now

        discovered = await asyncio.to_thread(worker_branches.discover, self.cfg)
        wanted = {s.ref: s for s in discovered}
        for ref in [r for r in self.dbs if r not in wanted]:
            await self._retire(ref)
        for ref, served in wanted.items():
            if ref in self.dbs:
                continue
            if await self._adopt(served):
                logger.info("now serving %s", self._label(ref))
                self._tick_heartbeat(force=True)
        return discovered

    def _rotation(self) -> list[worker_branches.Served]:
        """Production first, every pass. A preview never delays the shop's own question."""
        return sorted(self.served.values(), key=lambda s: (not s.is_default, s.label))

    async def run(self) -> None:
        from tools.sql_executor import describe_dsn

        # One pass adopts everything reachable; discover() always returns
        # production first, from the environment.
        production = (await self._discover(force=True))[0]
        if production.ref not in self.dbs:
            # Best effort for a branch, fatal for production: the LaunchAgent
            # restarts the process, which is the right response to a box that
            # cannot reach its own queue.
            raise RuntimeError(
                f"cannot connect to the production queue at {describe_dsn(production.queue_dsn)}"
            )
        self._tick_heartbeat(force=True)
        # ONCE. This names the code this process IMPORTED, which is what it will go
        # on running until it restarts, however far the checkout moves underneath.
        self._commit = worker_status.head_commit(_ROOT)
        keepalive = asyncio.create_task(self._keepalive())
        # EVERY database is in the banner because "which database answered" is not
        # something anyone should have to infer from a wrong number later.
        logger.info(
            "worker %s ready; models=%s commit=%s ollama=%s serving %s",
            self.cfg.worker_id, ", ".join(self.cfg.models),
            (self._commit or "unknown")[:8], self.cfg.ollama_base_url,
            "; ".join(
                f"{s.label} -> {describe_dsn(s.sandbox_dsn)}" for s in self._rotation()
            ),
        )
        # Publish immediately rather than waiting for the first keepalive tick, so
        # the file is truthful from the moment the banner says ready.
        self._publish()

        while not self._stopping:
            await self._discover()
            worked = False
            failed = 0

            for served in self._rotation():
                if self._stopping:
                    break
                db = self.dbs.get(served.ref)
                if db is None:
                    continue
                try:
                    db.sweep()
                    batch = db.claim(
                        self.cfg.worker_id,
                        list(self.cfg.models),
                        self.resident_model,
                        self.cfg.claim_limit,
                        self.cfg.lease_seconds,
                    )
                except Exception as exc:  # noqa: BLE001 - a queue may be briefly unreachable
                    # One database being unreachable must not stop the others: the
                    # box slept, a pooler recycled a socket, or a branch is being
                    # torn down. The next statement reconnects.
                    logger.warning("claim failed on %s: %s", self._label(served.ref), exc)
                    failed += 1
                    continue

                if not batch:
                    # Nothing to do, and therefore nothing done. No model is called,
                    # no ai_calls row is written, no cost is incurred.
                    continue

                worked = True
                logger.info(
                    "claimed %s job(s) of %s on %s",
                    len(batch), batch[0]["model"], self._label(served.ref),
                )
                try:
                    await self._drain(batch, served)
                except Exception:  # noqa: BLE001 - a batch failing must not end the worker
                    # A report over a dead connection -- the box slept, or the pooler
                    # recycled the socket. Nothing is lost: the lease sweep times out
                    # whatever this batch still held, and the next statement
                    # reconnects. Same shape as the `claim failed` branch above.
                    logger.exception("batch failed; the lease sweep collects what was held")

            self._tick_heartbeat()
            if not worked:
                await asyncio.sleep(self.cfg.poll_seconds * (2 if failed else 1))

        keepalive.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await keepalive
        await self._shutdown()

    async def _shutdown(self) -> None:
        from tools.sql_executor import close_pool

        for ref, db in list(self.dbs.items()):
            try:
                released = db.release_unstarted(self.cfg.worker_id)
                if released:
                    logger.info(
                        "released %s unstarted job(s) back to the queue on %s",
                        released, self._label(ref),
                    )
                db.stand_down(self.cfg.worker_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("shutdown housekeeping failed on %s: %s", self._label(ref), exc)
            finally:
                db.close()
        await close_pool()
        logger.info("worker %s stopped", self.cfg.worker_id)
        self._publish(stopped=True)


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
