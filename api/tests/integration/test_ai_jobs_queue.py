"""ai_jobs: the AI work queue, asserted from the database's side.

WHAT THIS GUARDS, AND WHY MOST OF IT IS TIMING. The queue's hard problems are not
CRUD, they are the three questions a job's row has to answer correctly while
nobody is watching:

  * "has this been abandoned?"  -- and the first draft of this design got it
    wrong. A fixed 120s TTL on a queued job conflates "nobody is home" with "the
    queue is busy": a 40-page package is twenty minutes of honest work, so pages
    5 onward would sweep to timed_out under a perfectly healthy worker while the
    UI showed "offline". The deadline is heartbeat staleness, never a clock, and
    test_a_queued_job_survives_a_long_healthy_queue is the regression.
  * "who owns this right now?" -- SKIP LOCKED, the first use of the idiom in this
    schema, so it is proven under real concurrent connections rather than assumed.
  * "which model should I load?"  -- a swap costs 43-63 seconds on one 8GB card,
    so the claim must batch by model AND still let an interactive question preempt
    a batch. Those two goals fight, and the tie-break is where they meet.

Runs as the real jigged_ai_worker role over libpq, not as a superuser, so its RLS
and its grants are genuinely exercised. That role is NOLOGIN in the migration and
gets LOGIN from supabase/seed.sql, which is local/preview only.

Needs a live local Supabase (see docs/testing/README.md).
"""
from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import psycopg2
import pytest

pytestmark = pytest.mark.integration

DB_URL = os.getenv(
    "TEST_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
# Same host/db, different role. seed.sql grants this role LOGIN on local and
# preview only; production sets its password by hand in the Supabase dashboard.
WORKER_URL = DB_URL.replace("postgres:postgres@", "jigged_ai_worker:postgres@", 1)


def _connect(dsn: str = DB_URL):
    try:
        return psycopg2.connect(dsn)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No Postgres at {dsn.split('@')[-1]}: {exc}")


@contextmanager
def rolled_back(dsn: str = DB_URL):
    """A transaction that is always discarded, so timing fixtures never leak."""
    conn = _connect(dsn)
    try:
        conn.autocommit = False
        with conn.cursor() as cur:
            yield cur
    finally:
        conn.rollback()
        conn.close()


def _company(cur) -> str:
    cur.execute("INSERT INTO public.companies (name) VALUES (%s) RETURNING id",
                (f"ai-queue-{uuid.uuid4().hex[:8]}",))
    return cur.fetchone()[0]


def _worker(cur, worker_id="desktop-1", models=("qwen3:8b",), seen="now()", resident=None):
    cur.execute(
        f"INSERT INTO public.ai_workers (worker_id, models, resident_model, last_seen_at)"
        f" VALUES (%s, %s, %s, {seen})"
        f" ON CONFLICT (worker_id) DO UPDATE SET models = EXCLUDED.models,"
        f" resident_model = EXCLUDED.resident_model, last_seen_at = EXCLUDED.last_seen_at",
        (worker_id, list(models), resident),
    )


def _job(cur, company, *, executor="worker", model="qwen3:8b", feature="insights",
         age="0 seconds", priority=0, status="queued", batch_key=None,
         lease=None, expires="120 seconds"):
    cur.execute(
        "INSERT INTO public.ai_jobs (company_id, feature, executor, model, status, priority,"
        " batch_key, request_id, created_at, expires_at, lease_expires_at)"
        " VALUES (%s,%s,%s,%s,%s,%s,%s, gen_random_uuid(), now() - %s::interval,"
        "         CASE WHEN %s = 'backend' THEN now() - %s::interval + %s::interval END,"
        "         CASE WHEN %s IS NULL THEN NULL ELSE now() + %s::interval END)"
        " RETURNING id",
        (company, feature, executor, model, status, priority, batch_key,
         age, executor, age, expires, lease, lease),
    )
    return cur.fetchone()[0]


def _status(cur, job_id) -> tuple:
    cur.execute("SELECT status, error_kind FROM public.ai_jobs WHERE id = %s", (job_id,))
    return cur.fetchone()


# ------------------------------------------------------- the sweep, branch 1


def test_a_queued_job_survives_a_long_healthy_queue():
    """THE REGRESSION. Twenty minutes queued behind a busy batch, with a live worker
    that serves this model, is not a failure -- it is a queue doing its job.

    A fixed expires_at would sweep this, and the user would be shown "offline"
    while the box was visibly working. Queued-to-timed_out means "no live worker
    can take this", and nothing else.
    """
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b",), resident="qwen3:8b")
        job = _job(cur, co, age="20 minutes")

        cur.execute("SELECT public.sweep_ai_jobs()")
        assert _status(cur, job) == ("queued", None), "a healthy long-queued job was swept"


def test_a_queued_job_is_still_claimable_after_a_long_healthy_wait():
    """The other half of the same bug: the first draft also filtered the claim on
    expires_at, so page 5 onward became unclaimable as well as swept. Surviving the
    sweep is worthless if nothing can pick the job up.
    """
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b",), resident="qwen3:8b")
        _job(cur, co, age="20 minutes")

        cur.execute(
            "SELECT count(*) FROM public.claim_ai_jobs('desktop-1', %s, 'qwen3:8b', 8, 300)",
            (["qwen3:8b"],),
        )
        assert cur.fetchone()[0] == 1


def test_a_job_is_swept_when_no_worker_is_alive():
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b",), seen="now() - interval '10 minutes'")
        job = _job(cur, co, age="5 minutes")

        cur.execute("SELECT public.sweep_ai_jobs()")
        assert _status(cur, job) == ("timed_out", "ai_offline")


def test_a_live_worker_that_cannot_serve_the_model_does_not_keep_the_job_alive():
    """The staleness gate is MODEL-aware, not merely executor-aware. A worker that
    is up but has never loaded qwen3-vl:4b would otherwise keep a drawing job queued
    forever while looking alive -- offline in effect, pending in the UI.
    """
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b",), resident="qwen3:8b")
        job = _job(cur, co, model="qwen3-vl:4b", feature="drawings", age="5 minutes")

        cur.execute("SELECT public.sweep_ai_jobs()")
        assert _status(cur, job) == ("timed_out", "ai_offline")


def test_a_job_younger_than_one_heartbeat_window_is_left_alone():
    """One heartbeat window of grace, so a worker restarting between beats does not
    kill the question somebody just asked."""
    with rolled_back() as cur:
        co = _company(cur)
        job = _job(cur, co, age="5 seconds")  # no worker at all
        cur.execute("SELECT public.sweep_ai_jobs()")
        assert _status(cur, job) == ("queued", None)


# --------------------------------------------- the sweep, branches 2 and 3


def test_a_backend_job_stuck_queued_is_swept_on_its_own_clock():
    """Backend rows DO carry a deadline, and here a clock is right: a backend job is
    marked running within milliseconds of insert, so still-queued at 120s means the
    enqueue request died in that narrow window."""
    with rolled_back() as cur:
        co = _company(cur)
        job = _job(cur, co, executor="backend", model="claude-sonnet-4-6", age="5 minutes")
        cur.execute("SELECT public.sweep_ai_jobs()")
        assert _status(cur, job) == ("timed_out", "timeout")


def test_a_vercel_killed_backend_job_is_collected_by_the_lease_branch():
    """This test would have failed before the backend path was made to set a lease.

    claim_ai_jobs() is the only OTHER thing that sets lease_expires_at and it is
    worker-only, so a backend row abandoned in `running` had a NULL lease -- and both
    the sweep's lease branch and the frontend's "running past its lease" rule matched
    nothing at all. A CHECK now makes the lease mandatory for any in-flight row.
    """
    with rolled_back() as cur:
        co = _company(cur)
        cur.execute(
            "INSERT INTO public.ai_jobs (company_id, feature, executor, model, status,"
            " request_id, expires_at, lease_expires_at)"
            " VALUES (%s,'insights','backend','claude-sonnet-4-6','running',"
            "         gen_random_uuid(), now() + interval '2 minutes',"
            "         now() - interval '10 seconds') RETURNING id",
            (co,),
        )
        job = cur.fetchone()[0]
        cur.execute("SELECT public.sweep_ai_jobs()")
        assert _status(cur, job) == ("timed_out", "timeout")


def test_an_in_flight_row_cannot_exist_without_a_lease():
    """The CHECK that makes the branch above possible. Without it the invariant is a
    convention, and conventions are what the NULL lease slipped through."""
    with rolled_back() as cur:
        co = _company(cur)
        with pytest.raises(psycopg2.errors.CheckViolation) as exc:
            cur.execute(
                "INSERT INTO public.ai_jobs (company_id, feature, executor, model, status,"
                " request_id, expires_at)"
                " VALUES (%s,'insights','backend','claude-sonnet-4-6','running',"
                "         gen_random_uuid(), now() + interval '2 minutes')",
                (co,),
            )
        assert "in_flight_rows_carry_a_lease" in str(exc.value)


def test_the_worker_sweep_cannot_see_a_stuck_backend_row():
    """The isolation is deliberate -- a misrouted job must fail loudly rather than be
    quietly adopted -- but it has a consequence worth pinning: NOTHING on the worker's
    path can clean a stuck backend row, because sweep_ai_jobs() is SECURITY INVOKER
    and the worker's policy scopes it to executor='worker'.

    That gap is why the frontend's deadline rule exists. If this test ever starts
    failing because the worker CAN see backend rows, that rule's justification has
    changed and it needs re-reading.
    """
    with rolled_back() as cur:
        co = _company(cur)
        cur.execute(
            "INSERT INTO public.ai_jobs (company_id, feature, executor, model, status,"
            " request_id, expires_at, lease_expires_at)"
            " VALUES (%s,'insights','backend','claude-sonnet-4-6','running',"
            "         gen_random_uuid(), now() + interval '2 minutes',"
            "         now() - interval '10 seconds') RETURNING id",
            (co,),
        )
        job = cur.fetchone()[0]
        cur.execute("COMMIT")  # the worker connection needs to see it

    try:
        with _connect(WORKER_URL) as wconn, wconn.cursor() as wcur:
            wcur.execute("SELECT public.sweep_ai_jobs()")
            wconn.commit()
        with rolled_back() as cur:
            assert _status(cur, job)[0] == "running", (
                "the worker swept a backend row it should not be able to see"
            )
        # service_role's path (superuser here) does collect it.
        with rolled_back() as cur:
            cur.execute("SELECT public.sweep_ai_jobs()")
            assert _status(cur, job) == ("timed_out", "timeout")
    finally:
        conn = _connect()
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.ai_jobs WHERE id = %s", (job,))
            cur.execute("DELETE FROM public.companies WHERE name LIKE 'ai-queue-%'")
        conn.close()


# ------------------------------------------------------------- the claim


def test_the_claim_is_capped_at_eight_however_deep_the_queue():
    """Claim size IS the worst-case interactive latency, because preemption only
    happens at a claim boundary. A 40-job claim would make the priority ordering
    below decorative, so the cap is enforced in SQL rather than trusted from the
    worker -- a worker passing 40 to "go faster" would silently disable preemption.
    """
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b",), resident="qwen3:8b")
        for _ in range(40):
            _job(cur, co)

        cur.execute(
            "SELECT count(*) FROM public.claim_ai_jobs('desktop-1', %s, 'qwen3:8b', 40, 300)",
            (["qwen3:8b"],),
        )
        assert cur.fetchone()[0] == 8


def test_a_claim_never_mixes_models():
    """One resident model on 8GB. A mixed batch would mean a swap mid-batch, which is
    43-63 seconds of nothing happening, repeatedly."""
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b", "qwen3-vl:4b"), resident="qwen3:8b")
        for _ in range(4):
            _job(cur, co, model="qwen3:8b")
            _job(cur, co, model="qwen3-vl:4b", feature="drawings")

        cur.execute(
            "SELECT count(DISTINCT model) FROM"
            " public.claim_ai_jobs('desktop-1', %s, 'qwen3:8b', 8, 300)",
            (["qwen3:8b", "qwen3-vl:4b"],),
        )
        assert cur.fetchone()[0] == 1


def test_equal_priority_work_never_causes_a_model_swap():
    """The residency tie-break. A 40-page package must amortise ONE model load, which
    is the entire reason the claim batches by model at all."""
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b", "qwen3-vl:4b"), resident="qwen3-vl:4b")
        _job(cur, co, model="qwen3:8b", age="10 minutes")            # older
        _job(cur, co, model="qwen3-vl:4b", feature="drawings")        # newer, resident

        cur.execute(
            "SELECT DISTINCT model FROM"
            " public.claim_ai_jobs('desktop-1', %s, 'qwen3-vl:4b', 8, 300)",
            (["qwen3:8b", "qwen3-vl:4b"],),
        )
        assert cur.fetchone()[0] == "qwen3-vl:4b", "residency lost to an older job"


def test_an_interactive_job_preempts_a_batch_even_at_the_cost_of_a_swap():
    """The other side of the tie-break, and the reason priority is assigned at all.
    Without this the resident model drains to empty first and preemption at claim
    boundaries never happens -- an insights question would wait out the package.
    """
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b", "qwen3-vl:4b"), resident="qwen3-vl:4b")
        for _ in range(20):
            _job(cur, co, model="qwen3-vl:4b", feature="drawings", priority=0)
        _job(cur, co, model="qwen3:8b", feature="insights", priority=10)

        cur.execute(
            "SELECT DISTINCT model FROM"
            " public.claim_ai_jobs('desktop-1', %s, 'qwen3-vl:4b', 8, 300)",
            (["qwen3:8b", "qwen3-vl:4b"],),
        )
        assert cur.fetchone()[0] == "qwen3:8b", "priority 10 did not preempt the batch"


def test_an_empty_queue_claims_nothing():
    """The line that makes the polling carve-out true. A poll may DISCOVER work; it
    can never create it, and on an empty queue it does nothing at all."""
    with rolled_back() as cur:
        _worker(cur, models=("qwen3:8b",), resident="qwen3:8b")
        cur.execute(
            "SELECT count(*) FROM public.claim_ai_jobs('desktop-1', %s, 'qwen3:8b', 8, 300)",
            (["qwen3:8b"],),
        )
        assert cur.fetchone()[0] == 0


def test_every_claimed_job_carries_a_lease_and_one_attempt():
    with rolled_back() as cur:
        co = _company(cur)
        _worker(cur, models=("qwen3:8b",), resident="qwen3:8b")
        for _ in range(3):
            _job(cur, co)
        cur.execute("SELECT count(*) FROM public.claim_ai_jobs('desktop-1', %s, 'qwen3:8b', 8, 300)",
                    (["qwen3:8b"],))
        cur.execute(
            "SELECT count(*) FROM public.ai_jobs"
            " WHERE status='claimed' AND (lease_expires_at IS NULL OR attempt <> 1)"
        )
        assert cur.fetchone()[0] == 0


# -------------------------------------------------------------- concurrency


def test_two_workers_never_claim_the_same_job():
    """SKIP LOCKED is the first use of the idiom in this schema, so it is proven under
    real concurrent connections rather than assumed from the SQL.

    Without it the second claimer BLOCKS on the first's row locks and then claims the
    same rows once they commit -- every job runs twice and every job is billed twice.
    """
    conn = _connect()
    conn.autocommit = True
    marker = f"conc-{uuid.uuid4().hex[:8]}"
    with conn.cursor() as cur:
        cur.execute("INSERT INTO public.companies (name) VALUES (%s) RETURNING id", (marker,))
        co = cur.fetchone()[0]
        for wid in ("c-1", "c-2", "c-3", "c-4"):
            cur.execute(
                "INSERT INTO public.ai_workers (worker_id, models, resident_model)"
                " VALUES (%s, %s, 'qwen3:8b') ON CONFLICT (worker_id) DO NOTHING",
                (f"{marker}-{wid}", ["qwen3:8b"]),
            )
        cur.execute(
            "INSERT INTO public.ai_jobs (company_id, feature, executor, model, request_id)"
            " SELECT %s, 'insights', 'worker', 'qwen3:8b', gen_random_uuid()"
            " FROM generate_series(1, 20)",
            (co,),
        )

    def claim(wid: str) -> list:
        c = psycopg2.connect(WORKER_URL)
        c.autocommit = True
        try:
            with c.cursor() as cur:
                cur.execute(
                    "SELECT job_id FROM public.claim_ai_jobs(%s, %s, 'qwen3:8b', 8, 300)",
                    (f"{marker}-{wid}", ["qwen3:8b"]),
                )
                return [r[0] for r in cur.fetchall()]
        finally:
            c.close()

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            claimed = [j for batch in pool.map(claim, ["c-1", "c-2", "c-3", "c-4"]) for j in batch]

        assert len(claimed) == len(set(claimed)), "the same job was claimed twice"
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*), coalesce(max(attempt), 0) FROM public.ai_jobs"
                " WHERE company_id = %s AND status = 'claimed'", (co,))
            n, max_attempt = cur.fetchone()
        assert n == len(claimed)
        assert max_attempt == 1, "a job was claimed more than once"
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.ai_jobs WHERE company_id = %s", (co,))
            cur.execute("DELETE FROM public.ai_workers WHERE worker_id LIKE %s", (f"{marker}-%",))
            cur.execute("DELETE FROM public.companies WHERE id = %s", (co,))
        conn.close()


# ------------------------------------------------------- the worker's reach


def test_the_worker_role_holds_exactly_what_it_needs_and_nothing_more():
    """Least privilege as a property rather than an intention. The worker claims and
    reports; the insights SQL tool runs on a SEPARATE jigged_ai_readonly connection,
    precisely so this role never needs a grant on a tenant table.
    """
    with rolled_back(WORKER_URL) as cur:
        cur.execute("SELECT current_user")
        assert cur.fetchone()[0] == "jigged_ai_worker"

        for table in ("parts", "customers", "jobs", "quotes", "companies"):
            with pytest.raises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(f"SELECT count(*) FROM public.{table}")
            cur.execute("ROLLBACK")


def test_the_worker_cannot_create_work():
    """A poll may discover work and may never create it. Enforced by the absence of an
    INSERT grant, not by the worker's restraint."""
    with rolled_back(WORKER_URL) as cur:
        with pytest.raises(psycopg2.errors.InsufficientPrivilege):
            cur.execute(
                "INSERT INTO public.ai_jobs (company_id, feature, executor, model, request_id)"
                " VALUES (gen_random_uuid(),'x','worker','y',gen_random_uuid())"
            )


def test_the_worker_can_append_to_the_ledger_but_never_read_or_edit_it():
    """Found the hard way: the worker held INSERT on ai_calls and still could not
    write, because RLS is deny-by-default and the RESTRICTIVE deny named only the
    browser roles. Grants and RLS are different layers and this needed both.
    """
    with rolled_back(WORKER_URL) as cur:
        cur.execute(
            "INSERT INTO public.ai_calls (feature, provider, model, tokens_in, tokens_out,"
            " latency_ms, est_cost_usd, request_id, success)"
            " VALUES ('insights','ollama','qwen3:8b',700,120,1200,0,gen_random_uuid(),true)"
        )
        for stmt in ("SELECT count(*) FROM public.ai_calls",
                     "UPDATE public.ai_calls SET model = 'x'"):
            with pytest.raises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(stmt)
            cur.execute("ROLLBACK")


def test_the_worker_cannot_see_a_backend_job():
    with rolled_back() as cur:
        co = _company(cur)
        _job(cur, co, executor="backend", model="claude-sonnet-4-6")
        cur.execute("COMMIT")
    try:
        with rolled_back(WORKER_URL) as cur:
            cur.execute("SELECT count(*) FROM public.ai_jobs WHERE executor = 'backend'")
            assert cur.fetchone()[0] == 0
    finally:
        conn = _connect()
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.ai_jobs WHERE executor = 'backend'")
            cur.execute("DELETE FROM public.companies WHERE name LIKE 'ai-queue-%'")
        conn.close()


# --------------------------------------------------------- shape and guards


def test_a_fanned_out_batch_cannot_be_backend_executed():
    """The backend executor processes exactly ONE job per request, ever. N inline
    Anthropic calls inside one 60s Vercel wall is not slow, it is fatal -- so fan-out
    is worker-only by CHECK rather than by care."""
    with rolled_back() as cur:
        co = _company(cur)
        with pytest.raises(psycopg2.errors.CheckViolation) as exc:
            cur.execute(
                "INSERT INTO public.ai_jobs (company_id, feature, executor, model,"
                " batch_key, request_id, expires_at)"
                " VALUES (%s,'drawings','backend','claude-sonnet-4-6', gen_random_uuid(),"
                "         gen_random_uuid(), now() + interval '2 minutes')",
                (co,),
            )
        assert "batches_are_worker_only" in str(exc.value)


def test_only_backend_rows_carry_a_deadline():
    with rolled_back() as cur:
        co = _company(cur)
        with pytest.raises(psycopg2.errors.CheckViolation) as exc:
            cur.execute(
                "INSERT INTO public.ai_jobs (company_id, feature, executor, model,"
                " request_id, expires_at)"
                " VALUES (%s,'insights','worker','qwen3:8b', gen_random_uuid(),"
                "         now() + interval '2 minutes')",
                (co,),
            )
        assert "only_backend_rows_carry_a_deadline" in str(exc.value)


def test_nothing_can_reach_the_queue_that_should_not(supabase_admin):
    rows = supabase_admin.rpc("ai_job_write_leaks", {}).execute().data
    assert rows == [], f"the AI queue is reachable: {rows}"


@pytest.mark.parametrize("violation, expected_kind", [
    ("GRANT INSERT ON public.ai_jobs TO authenticated", "browser_write"),
    ("GRANT SELECT ON public.ai_jobs TO anon", "anon_access"),
    ("GRANT SELECT ON public.ai_calls TO jigged_ai_readonly", "ai_readonly_access"),
    ("GRANT SELECT ON public.parts TO jigged_ai_worker", "worker_overgrant"),
    ("ALTER TABLE public.ai_jobs DISABLE ROW LEVEL SECURITY", "rls_disabled"),
    ("DROP POLICY billing_gate_insert ON public.ai_jobs", "billing_gate_missing"),
])
def test_the_queue_guard_actually_fires_when_the_posture_is_broken(violation, expected_kind):
    with rolled_back() as cur:
        cur.execute(violation)
        cur.execute("SELECT leak_kind FROM public.ai_job_write_leaks()")
        kinds = {r[0] for r in cur.fetchall()}
        assert expected_kind in kinds, (
            f"{violation!r} went unnoticed by ai_job_write_leaks(); saw {kinds or 'nothing'}"
        )


def test_the_write_gate_guard_still_passes_with_the_new_tables(supabase_admin):
    """The global guard, re-asserted here so this table's own file fails on it.

    ai_jobs takes apply_billing_write_gate() rather than an exempt-list entry: the
    guard is satisfied by the EXISTENCE of a billing_gate_insert policy, so nothing
    had to restate it -- and restating a guard from a stale copy has silently
    reverted entries in this repo four times.
    """
    assert supabase_admin.rpc("tenant_tables_missing_write_gate", {}).execute().data == []
    assert supabase_admin.rpc("function_execute_leaks", {}).execute().data == []
    assert supabase_admin.rpc("definer_writers_missing_write_gate", {}).execute().data == []


# ------------------------------------------------------------ tenant scoping


def test_a_shop_can_read_its_own_jobs(supabase_admin, seeded_user_a):
    supabase_admin.table("ai_jobs").insert({
        "company_id": seeded_user_a["company_id"], "feature": "insights",
        "executor": "worker", "model": "qwen3:8b", "request_id": str(uuid.uuid4()),
    }).execute()
    rows = (
        seeded_user_a["client"].table("ai_jobs").select("id, feature, status")
        .eq("company_id", seeded_user_a["company_id"]).execute()
    ).data
    assert len(rows) >= 1


def test_a_shop_cannot_read_another_shops_jobs(supabase_admin, seeded_user_a, seeded_user_b):
    """ai_jobs.payload carries the question a shop asked. Cross-tenant readability
    here would be worse than a normal leak: it is other people's words."""
    res = supabase_admin.table("ai_jobs").insert({
        "company_id": seeded_user_b["company_id"], "feature": "insights",
        "executor": "worker", "model": "qwen3:8b", "request_id": str(uuid.uuid4()),
        "payload": {"question": "what did we quote Acme last month?"},
    }).execute()
    b_job = res.data[0]["id"]

    got = seeded_user_a["client"].table("ai_jobs").select("id").eq("id", b_job).execute()
    assert got.data == [], "one shop could read another shop's AI job"


def test_the_browser_cannot_enqueue_its_own_job(seeded_user_a):
    """Enqueue is server-side so the route can enforce the feature flag and the
    per-company rate limit first. A browser that could INSERT would bypass both."""
    with pytest.raises(Exception) as exc:
        seeded_user_a["client"].table("ai_jobs").insert({
            "company_id": seeded_user_a["company_id"], "feature": "insights",
            "executor": "worker", "model": "qwen3:8b", "request_id": str(uuid.uuid4()),
        }).execute()
    assert "42501" in str(exc.value).lower() or "permission" in str(exc.value).lower()
