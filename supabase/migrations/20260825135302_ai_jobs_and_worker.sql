-- ============================================================================
-- ai_jobs, ai_workers, and the jigged_ai_worker role
-- ============================================================================
-- The AI work queue. Every LLM call in the product becomes a row here, so no
-- request handler ever blocks on a model and Vercel's 60s maxDuration stops
-- being a factor.
--
-- TWO EXECUTORS, ONE LIFECYCLE.
--   executor='worker'  - claimed over an OUTBOUND connection by the desktop
--                        worker, which runs Ollama at localhost. There is no
--                        inbound tunnel; Vercel never talks to Ollama.
--   executor='backend' - worked inline by the FastAPI request that enqueued it
--                        (not-yet-migrated surfaces, still on Anthropic).
-- Both write the same status vocabulary, so every surface has one UX.
--
-- WHY A queued JOB DOES NOT EXPIRE ON A CLOCK. "Queued too long" is not a
-- failure; "no live worker can serve this" is. A 40-page drawing package is
-- twenty minutes of honest work, and a fixed TTL would sweep its back half
-- while the box is visibly running, showing the user "offline". Worker rows
-- therefore carry NO expires_at and are swept only on heartbeat staleness --
-- see sweep_ai_jobs(). Backend rows DO carry a clock, because they are worked
-- inline within milliseconds of insert.

-- ============================================================================
-- 1. The worker role
-- ============================================================================
-- NOLOGIN here, exactly like jigged_ai_readonly (20260527151536_baseline.sql:40-48),
-- so the GRANTs and CREATE POLICY statements below have something to bind to on a
-- local stack and on preview branches. LOGIN and a password are granted BY HAND in
-- the Supabase dashboard for production. That is the established pattern in this
-- repo and this migration does not invent a new one: there is no CREATE ROLE ... LOGIN
-- anywhere in the migration history, and a password in a migration file would be a
-- credential in git.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jigged_ai_worker') THEN
        CREATE ROLE "jigged_ai_worker" NOLOGIN;
    END IF;
END
$$;

-- NO `COMMENT ON ROLE`, deliberately: it needs superuser or ADMIN on the role, and
-- nothing in this migration history has ever issued one. A statement that works on a
-- local superuser stack and fails on hosted Postgres would block every migration
-- behind it -- the 2026-08-03 outage shape. The role's contract, recorded here instead:
--
--   jigged_ai_worker claims and reports ai_jobs, inserts ai_calls, and maintains its
--   own ai_workers heartbeat. It holds NOTHING else -- no SELECT on any tenant table,
--   and never the service-role key. The insights execute_sql tool runs on a SEPARATE
--   connection as jigged_ai_readonly, reusing that role's existing 29
--   ai_readonly_select policies rather than duplicating them onto this one.

GRANT USAGE ON SCHEMA public TO jigged_ai_worker;

-- ============================================================================
-- 2. ai_workers - the heartbeat
-- ============================================================================
CREATE TABLE public.ai_workers (
    worker_id      text        NOT NULL,
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    resident_model text,
    models         text[]      NOT NULL DEFAULT '{}',
    version        text,
    started_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT ai_workers_pkey PRIMARY KEY (worker_id),
    CONSTRAINT ai_workers_id_not_blank CHECK (length(btrim(worker_id)) > 0)
);

COMMENT ON TABLE public.ai_workers IS
  'Liveness registry for desktop AI workers. A row whose last_seen_at is inside 60 seconds means a worker is alive and can serve the models listed in `models`; anything staler is offline, and that is what drives the beta-offline UX and the queued-job sweep. READABLE BY authenticated, deliberately: the browser needs a live cross-tenant infrastructure signal, and the alternatives are worse -- a SECURITY DEFINER accessor would force a restatement of function_execute_leaks()''s allowlist (the four-times-bitten failure), and a backend endpoint would cost a Vercel invocation per dashboard load. What is exposed is a worker id, a model name and a timestamp: no tenant data, no credential.';

COMMENT ON COLUMN public.ai_workers.models IS
  'Every model this worker can serve. The queued-job sweep is model-aware against this array, so a live worker that does not load qwen3-vl:4b cannot keep a drawing job queued forever while looking alive.';
COMMENT ON COLUMN public.ai_workers.resident_model IS
  'What is loaded in VRAM right now. Passed back to claim_ai_jobs() as p_resident_model so equal-priority work does not trigger a 43-63 second model swap. Diagnostic only - the claim tie-break is what enforces it.';
COMMENT ON COLUMN public.ai_workers.last_seen_at IS
  'Updated every 15 seconds by the worker. The staleness threshold is 60 seconds -- four missed beats -- so a GC pause or one slow write never flips the UI. That 60s appears in exactly three places and they must agree: sweep_ai_jobs(), the frontend deadline rule, and this comment. On graceful shutdown the worker backdates this rather than deleting the row, so job provenance survives.';

ALTER TABLE public.ai_workers ENABLE ROW LEVEL SECURITY;

-- Readable by any signed-in user; see the table comment for why that exposure is
-- acceptable and why the alternatives are worse. anon gets nothing: the AI surfaces
-- are all behind auth.
CREATE POLICY ai_workers_read_liveness ON public.ai_workers
    FOR SELECT TO authenticated USING (true);

-- The worker maintains its own row. No USING clause distinction by worker_id: a
-- single-box deployment, and a worker that could not see its peers could not report
-- queue state coherently.
CREATE POLICY ai_workers_worker_manages_itself ON public.ai_workers
    FOR ALL TO jigged_ai_worker USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.ai_workers FROM anon, authenticated, service_role, jigged_ai_readonly;
GRANT  SELECT                         ON TABLE public.ai_workers TO authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_workers TO service_role;
GRANT  SELECT, INSERT, UPDATE         ON TABLE public.ai_workers TO jigged_ai_worker;

-- ============================================================================
-- 3. ai_jobs
-- ============================================================================
CREATE TABLE public.ai_jobs (
    id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    company_id     uuid        NOT NULL,
    requested_by   uuid,
    feature        text        NOT NULL,
    executor       text        NOT NULL,
    model          text        NOT NULL,
    status         text        NOT NULL DEFAULT 'queued',
    priority       smallint    NOT NULL DEFAULT 0,
    batch_key      uuid,
    attempt        smallint    NOT NULL DEFAULT 0,
    payload        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    result         jsonb,
    error          text,
    error_kind     text,
    request_id     uuid        NOT NULL,
    claimed_by     text,
    claimed_at     timestamptz,
    lease_expires_at timestamptz,
    -- BACKEND ROWS ONLY. A job still 'queued' 120s after INSERT means the enqueue
    -- request died in the narrow window between the INSERT and the running update.
    -- NULL for worker rows, deliberately: their deadline is "no live worker
    -- advertises this model", never a wall clock. See the file header.
    expires_at     timestamptz,
    finished_at    timestamptz,

    CONSTRAINT ai_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT ai_jobs_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    CONSTRAINT ai_jobs_requested_by_fk FOREIGN KEY (requested_by)
        REFERENCES auth.users(id) ON DELETE SET NULL,

    CONSTRAINT ai_jobs_status_check CHECK (status IN
        ('queued', 'claimed', 'running', 'succeeded', 'failed', 'timed_out')),
    CONSTRAINT ai_jobs_executor_check CHECK (executor IN ('worker', 'backend')),
    CONSTRAINT ai_jobs_error_kind_check CHECK (error_kind IS NULL OR error_kind IN
        ('ai_offline', 'provider', 'schema', 'timeout', 'page_out_of_range', 'internal')),
    CONSTRAINT ai_jobs_feature_not_blank CHECK (length(btrim(feature)) > 0),
    CONSTRAINT ai_jobs_model_not_blank   CHECK (length(btrim(model))   > 0),
    CONSTRAINT ai_jobs_attempt_nonneg    CHECK (attempt >= 0),
    CONSTRAINT ai_jobs_error_cap         CHECK (error IS NULL OR length(error) <= 2048),

    CONSTRAINT ai_jobs_only_backend_rows_carry_a_deadline
        CHECK ((executor = 'backend') = (expires_at IS NOT NULL)),

    -- EVERY in-flight row carries a lease, whichever executor holds it. Without this
    -- the backend path -- which never goes through claim_ai_jobs(), the only other
    -- thing that sets a lease -- leaves lease_expires_at NULL, and BOTH the sweep's
    -- lease branch and the frontend's "running past its lease" rule silently match
    -- nothing. A Vercel-killed job would then sit `running` until the poll wall,
    -- which is precisely the failure those two rules exist to catch. A CHECK rather
    -- than a test, because this invariant is what makes the lifecycle uniform.
    CONSTRAINT ai_jobs_in_flight_rows_carry_a_lease
        CHECK (status NOT IN ('claimed', 'running') OR lease_expires_at IS NOT NULL),

    -- The backend executor processes exactly ONE job per request, ever. A fanned-out
    -- batch on the backend would mean N Anthropic calls inside one 60s Vercel wall,
    -- which is not slow but fatal. Fan-out is worker-only BY CONSTRUCTION.
    CONSTRAINT ai_jobs_batches_are_worker_only
        CHECK (batch_key IS NULL OR executor = 'worker'),

    CONSTRAINT ai_jobs_terminal_states_are_final
        CHECK ((status IN ('succeeded', 'failed', 'timed_out')) = (finished_at IS NOT NULL)),
    CONSTRAINT ai_jobs_failure_states_its_reason
        CHECK (status NOT IN ('failed', 'timed_out')
               OR (error IS NOT NULL AND length(btrim(error)) > 0 AND error_kind IS NOT NULL)),
    CONSTRAINT ai_jobs_success_carries_a_result
        CHECK (status <> 'succeeded' OR result IS NOT NULL)
);

-- The claim path is the only hot query and it must never scan.
CREATE INDEX idx_ai_jobs_claimable ON public.ai_jobs (model, priority DESC, created_at)
    WHERE status = 'queued' AND executor = 'worker';
CREATE INDEX idx_ai_jobs_lease ON public.ai_jobs (lease_expires_at)
    WHERE status IN ('claimed', 'running');
-- Serves both queued sweep branches: the backend deadline and the worker's
-- "how long has this been waiting" check.
CREATE INDEX idx_ai_jobs_queued_age ON public.ai_jobs (created_at) WHERE status = 'queued';
CREATE INDEX idx_ai_jobs_company_recent ON public.ai_jobs (company_id, created_at DESC);
-- The batch aggregate the frontend polls for "3 of 12 pages".
CREATE INDEX idx_ai_jobs_batch ON public.ai_jobs (batch_key) WHERE batch_key IS NOT NULL;

COMMENT ON TABLE public.ai_jobs IS
  'The AI work queue. One row per LLM call, enqueued only by an authenticated request handler acting on an explicit user action. Worker rows are claimed by the desktop worker over an outbound connection; backend rows are worked inline by the enqueueing request. The browser may READ its own company''s rows (that is how status polling avoids costing a Vercel invocation) and may never write one. Never add this to supabase_realtime without a deliberate decision - it would be the first ALTER PUBLICATION in this schema.';

COMMENT ON COLUMN public.ai_jobs.executor IS
  'Resolved at enqueue from the feature''s chain: an ollama chain routes to the desktop worker, an anthropic chain is worked inline. The Vercel backend never talks to Ollama and the worker never sees a backend row (its RLS policy scopes it to executor=''worker''), so a misrouted job fails loudly instead of being quietly adopted.';
COMMENT ON COLUMN public.ai_jobs.model IS
  'A REAL column, not a payload key, because claim_ai_jobs() batches on it: one resident model on 8GB of VRAM, and a swap costs 43-63 seconds. Real columns are also type-checked through types/database.ts at every call site, while jsonb degrades to Json and checks nothing.';
COMMENT ON COLUMN public.ai_jobs.priority IS
  'Interactive surfaces enqueue at 10, batch surfaces at 0. Nothing preempts unless something assigns this. The claim orders by priority DESC before the resident-model tie-break, so an interactive arrival is worth a model swap and equal work is not.';
COMMENT ON COLUMN public.ai_jobs.batch_key IS
  'Groups the pages of one fanned-out package so they claim together under a single model load, and so the UI can report "3 of 12". Worker-only by CHECK. Fan-out happens at ENQUEUE, never at claim: a poll may discover work and must never create it.';
COMMENT ON COLUMN public.ai_jobs.lease_expires_at IS
  'When this worker''s (or this request''s) claim goes stale. Renewed every 60s across EVERY job a worker holds, not only the one executing - otherwise job 8 of a slow batch is swept before its turn arrives. The backend path sets ~90s when it marks running, comfortably past Vercel''s 60s wall.';
COMMENT ON COLUMN public.ai_jobs.expires_at IS
  'Backend rows only, enforced by CHECK. See the file header for why a worker row must not carry a clock.';
COMMENT ON COLUMN public.ai_jobs.claimed_by IS
  'Which worker holds or held this job. Deliberately NOT a foreign key to ai_workers: that registry is operational state a worker may prune, and an ON DELETE SET NULL would erase provenance from long-completed jobs.';
COMMENT ON COLUMN public.ai_jobs.request_id IS
  'Shared with every ai_calls row this job produces - both legs of a provider fallback and both halves of a schema retry - so one job''s true cost is a single GROUP BY.';
COMMENT ON COLUMN public.ai_jobs.payload IS
  'Feature-specific input. NEVER base64 image bytes: a 40-page drawing package would be a 100MB jsonb row. Images are referenced by Supabase Storage path plus a signed URL, and rendered in memory by the worker.';

CREATE TRIGGER ai_jobs_updated_at
    BEFORE UPDATE ON public.ai_jobs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 4. RLS and grants
-- ============================================================================
ALTER TABLE public.ai_jobs ENABLE ROW LEVEL SECURITY;

-- The browser polls its own company's jobs directly. This is what keeps status
-- polling off Vercel entirely: one indexed SELECT through PostgREST, no function
-- invocation, no AI credits, and provably credit-free because it is a table read.
CREATE POLICY ai_jobs_select_own_company ON public.ai_jobs
    FOR SELECT TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

-- The worker sees ONLY jobs routed to it. Cross-tenant by necessity -- one box
-- serves every shop -- but never able to touch a backend-executed row.
CREATE POLICY ai_jobs_worker_all ON public.ai_jobs
    FOR ALL TO jigged_ai_worker
    USING (executor = 'worker') WITH CHECK (executor = 'worker');

-- Satisfies tenant_tables_missing_write_gate() by EXISTENCE of a billing_gate_insert
-- policy, so nothing has to restate that guard -- restating one from a stale copy has
-- silently reverted entries in this repo four times. The gate's policies are TO
-- authenticated and the browser holds no INSERT grant, so today they are inert; they
-- are also correct (a lapsed shop should not spend inference) and become load-bearing
-- the day anyone adds a browser enqueue path.
SELECT public.apply_billing_write_gate('public.ai_jobs');

REVOKE ALL ON TABLE public.ai_jobs FROM anon, authenticated, service_role, jigged_ai_readonly;
-- Read-only for the browser: enqueue is server-side so the route can enforce the
-- feature flag and the per-company rate limit first.
GRANT  SELECT                 ON TABLE public.ai_jobs TO authenticated;
GRANT  SELECT, INSERT, UPDATE ON TABLE public.ai_jobs TO service_role;
-- No INSERT for the worker. It may claim and report; it may not create work.
GRANT  SELECT, UPDATE         ON TABLE public.ai_jobs TO jigged_ai_worker;

-- Not a no-op: the baseline auto-grants SELECT on every new public table to the AI
-- SQL role (20260527151536_baseline.sql:6431). Without this, LLM-generated SQL could
-- read the queue -- including other shops' payloads.
REVOKE ALL ON TABLE public.ai_jobs    FROM jigged_ai_readonly;
REVOKE ALL ON TABLE public.ai_workers FROM jigged_ai_readonly;
-- Same reason, for the ledger created in the previous migration.
REVOKE ALL ON TABLE public.ai_calls   FROM jigged_ai_readonly;

-- The worker's only write to the ledger -- and the GRANT alone is NOT enough.
-- ai_calls has RLS enabled, RLS is deny-by-default, and the RESTRICTIVE deny-all in
-- the previous migration names only the browser and AI-SQL roles. Without a matching
-- PERMISSIVE policy the worker holds INSERT and still gets "new row violates
-- row-level security policy": grants and RLS are different layers, and this table
-- needs both for the one role that writes it from outside service_role.
--
-- INSERT only, WITH CHECK (true), and no SELECT: the worker appends to the ledger and
-- has no reason to read it. That also means the audit writer must not use RETURNING.
GRANT INSERT ON TABLE public.ai_calls TO jigged_ai_worker;

CREATE POLICY ai_calls_worker_insert ON public.ai_calls
    FOR INSERT TO jigged_ai_worker WITH CHECK (true);

-- ============================================================================
-- 5. claim_ai_jobs - SECURITY INVOKER, batched by model
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_ai_jobs(
    p_worker_id      text,
    p_models         text[],
    p_resident_model text DEFAULT NULL,
    p_limit          integer DEFAULT 8,
    p_lease_seconds  integer DEFAULT 300
)
RETURNS TABLE (job_id uuid, company_id uuid, feature text, model text,
               payload jsonb, request_id uuid, attempt smallint)
LANGUAGE plpgsql
-- SECURITY INVOKER (the default), deliberately, and it buys three things:
--   1. RLS genuinely contains the worker. ai_jobs_worker_all limits it to
--      executor='worker' rows, so least privilege is a property of the database
--      rather than of this function's care.
--   2. function_execute_leaks() filters on pg_proc.prosecdef, so this needs no
--      allowlist entry -- and that guard's allowlist is the one that has been
--      silently reverted four times.
--   3. definer_writers_missing_write_gate() also filters on prosecdef. A DEFINER
--      version updating the now-gated ai_jobs would trip it unless its body
--      contained the literal string company_can_write.
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_model text;
    -- Clamped here, not trusted from the caller. The claim size IS the worst-case
    -- interactive latency, because preemption only happens at a claim boundary --
    -- so a worker passing 40 to "go faster" would silently disable the priority
    -- ordering below. Structural, like the CHECKs on the table.
    v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 8);
BEGIN
    -- ONE ordered pick decides the model, and the tie-break is where the two
    -- competing goals meet. `priority DESC` first, so an interactive job preempts a
    -- batch even when that means paying for a swap -- without it the resident model
    -- drains to empty first and preemption never happens at all. `(model = resident)
    -- DESC` second, so EQUAL work never causes a swap: a 40-page package amortises
    -- one load, which is the entire reason the claim batches by model.
    --
    -- Two different numbers, and conflating them is a mistake worth not repeating:
    --   THROUGHPUT COST of one interactive arrival mid-batch = two swaps, ~90s.
    --   INTERACTIVE LATENCY = v_limit x per-job time + one swap.
    -- The second is why v_limit is capped at 8 for every model.
    --
    -- No expires_at predicate. Worker rows carry none; their liveness gate is the
    -- heartbeat, in sweep_ai_jobs(). A clock here is what would make a healthy long
    -- batch unclaimable from page 5 onward.
    SELECT j.model INTO v_model
      FROM public.ai_jobs j
     WHERE j.status = 'queued'
       AND j.executor = 'worker'
       AND j.model = ANY(p_models)
     ORDER BY j.priority DESC, (j.model = p_resident_model) DESC, j.created_at
     LIMIT 1;

    -- Empty queue: no rows, no inference, no cost. This is the line that makes the
    -- polling carve-out true -- a poll may DISCOVER work and can never create it.
    IF v_model IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH picked AS (
        SELECT j.id
          FROM public.ai_jobs j
         WHERE j.status = 'queued'
           AND j.executor = 'worker'
           AND j.model = v_model
         ORDER BY j.priority DESC, j.batch_key NULLS LAST, j.created_at
         LIMIT v_limit
         -- OF j is required, not stylistic: a bare FOR UPDATE in a CTE that also
         -- reads a WITH query is an error. SKIP LOCKED is what makes two workers
         -- safe against double-claiming; this is the first use of the idiom in this
         -- schema, hence the note.
         FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE public.ai_jobs j
       SET status           = 'claimed',
           claimed_by       = p_worker_id,
           claimed_at       = now(),
           attempt          = j.attempt + 1,
           lease_expires_at = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30))
     WHERE j.id IN (SELECT id FROM picked)
    RETURNING j.id, j.company_id, j.feature, j.model, j.payload, j.request_id, j.attempt;
END;
$$;

COMMENT ON FUNCTION public.claim_ai_jobs(text, text[], text, integer, integer) IS
  'Atomically claims up to 8 queued worker jobs of a SINGLE model, preferring the caller''s resident model on equal priority so a batch amortises one 43-63s model load, and preferring higher priority over residency so an interactive question preempts a batch. SKIP LOCKED makes concurrent workers safe. SECURITY INVOKER so RLS scopes the caller to executor=''worker'' rows, which also puts it outside function_execute_leaks() and definer_writers_missing_write_gate() by construction. p_limit is clamped to 8 because claim size is the worst-case interactive latency.';

REVOKE EXECUTE ON FUNCTION public.claim_ai_jobs(text, text[], text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.claim_ai_jobs(text, text[], text, integer, integer)
  TO jigged_ai_worker, service_role;

-- ============================================================================
-- 6. sweep_ai_jobs - heartbeat-gated, lazy, no cron
-- ============================================================================
-- No scheduler exists in this repo and this migration does not add one. Expiry is
-- the house pattern: a predicate, swept opportunistically -- by the enqueue route
-- (as service_role, so it sees every row) and by each worker poll tick (as
-- jigged_ai_worker, so RLS scopes it to executor='worker').
--
-- THAT ASYMMETRY IS DELIBERATE AND HAS A CONSEQUENCE: nothing on the worker's path
-- can clean a stuck backend row. The frontend's deadline rule is what protects the
-- user there; the row itself is reconciled by the next enqueue.
CREATE OR REPLACE FUNCTION public.sweep_ai_jobs()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_total integer := 0;
    v_n     integer;
BEGIN
    -- 1. WORKER-QUEUED -> timed_out, gated on the HEARTBEAT, never on a clock.
    --    Swept only when no worker whose heartbeat is fresh advertises this job's
    --    model. Model-aware on purpose: a live worker that does not load
    --    qwen3-vl:4b must not keep a drawing job queued forever looking alive.
    --    The 60s age floor is one heartbeat window, so a transient blip cannot kill
    --    a just-enqueued job. That 60s must agree with ai_workers.last_seen_at's
    --    comment and the frontend deadline rule.
    UPDATE public.ai_jobs j
       SET status      = 'timed_out',
           error       = 'No AI worker is available to run this job.',
           error_kind  = 'ai_offline',
           finished_at = now()
     WHERE j.status = 'queued'
       AND j.executor = 'worker'
       AND j.created_at < now() - interval '60 seconds'
       AND NOT EXISTS (
           SELECT 1 FROM public.ai_workers w
            WHERE w.last_seen_at > now() - interval '60 seconds'
              AND j.model = ANY(w.models)
       );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;

    -- 2. BACKEND-QUEUED past expires_at. Here a clock IS right: a backend job is
    --    marked running within milliseconds of insert, so still-queued at 120s
    --    means the enqueue request died in that narrow window.
    UPDATE public.ai_jobs j
       SET status      = 'timed_out',
           error       = 'The request that started this job did not survive to run it.',
           error_kind  = 'timeout',
           finished_at = now()
     WHERE j.status = 'queued'
       AND j.executor = 'backend'
       AND j.expires_at < now();
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;

    -- 3. CLAIMED or RUNNING past lease_expires_at. Covers a dead worker and a
    --    Vercel-killed backend request identically -- but ONLY because the backend
    --    path sets a 90s lease when it marks running. This branch is inert for
    --    backend rows if that lease is ever dropped, which is why a CHECK enforces it.
    UPDATE public.ai_jobs j
       SET status      = 'timed_out',
           error       = 'The worker holding this job stopped responding.',
           error_kind  = 'timeout',
           finished_at = now()
     WHERE j.status IN ('claimed', 'running')
       AND j.lease_expires_at < now();
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_total := v_total + v_n;

    RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.sweep_ai_jobs() IS
  'Moves abandoned ai_jobs to timed_out and returns how many. Three branches: a worker-queued job whose model no live worker advertises (heartbeat-gated, NOT clock-gated -- a fixed TTL would sweep the back half of a healthy 40-page batch); a backend-queued job past its 120s deadline; and any claimed/running job past its lease. SECURITY INVOKER, so the enqueue route (service_role) sees every row while a worker sees only its own -- nothing on the worker path can clean a stuck backend row, and the frontend deadline rule is what covers that.';

REVOKE EXECUTE ON FUNCTION public.sweep_ai_jobs() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.sweep_ai_jobs() TO jigged_ai_worker, service_role;

-- ============================================================================
-- 7. Leak guard
-- ============================================================================
-- Same reasoning as ai_call_write_leaks() in the previous migration: no existing
-- CI guard can see these tables, and over-granting is silent. has_table_privilege(),
-- never information_schema.role_table_grants (provably vacuous under SET ROLE
-- service_role -- see 20260818142814).
CREATE OR REPLACE FUNCTION public.ai_job_write_leaks()
RETURNS TABLE(leak_kind text, detail text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  -- The browser may READ ai_jobs and nothing more. Enqueue is server-side so the
  -- route can enforce the feature flag and the rate limit first.
  SELECT 'browser_write'::text, p.priv::text
  FROM (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
  WHERE has_table_privilege('authenticated', 'public.ai_jobs', p.priv)

  UNION ALL
  SELECT 'anon_access'::text, ('ai_jobs:' || p.priv)::text
  FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
  WHERE has_table_privilege('anon', 'public.ai_jobs', p.priv)

  UNION ALL
  -- The AI SQL role must not reach the queue, the ledger, or the worker registry.
  -- The baseline's default privilege re-grants SELECT on every new public table, so
  -- this is the assertion that the REVOKEs above actually landed.
  SELECT 'ai_readonly_access'::text, (t.name || ':SELECT')::text
  FROM (VALUES ('public.ai_jobs'), ('public.ai_calls'), ('public.ai_workers')) t(name)
  WHERE has_table_privilege('jigged_ai_readonly', t.name, 'SELECT')

  UNION ALL
  -- The worker claims and reports. It never creates work, and it never touches a
  -- tenant table -- the insights SQL tool runs on a separate jigged_ai_readonly
  -- connection precisely so this role does not need those grants.
  SELECT 'worker_overgrant'::text, g.detail::text
  FROM (VALUES
        ('ai_jobs:INSERT',  'public.ai_jobs',  'INSERT'),
        ('ai_jobs:DELETE',  'public.ai_jobs',  'DELETE'),
        ('ai_calls:UPDATE', 'public.ai_calls', 'UPDATE'),
        ('ai_calls:DELETE', 'public.ai_calls', 'DELETE'),
        ('parts:SELECT',    'public.parts',    'SELECT'),
        ('customers:SELECT','public.customers','SELECT'),
        ('jobs:SELECT',     'public.jobs',     'SELECT')
       ) g(detail, tbl, priv)
  WHERE has_table_privilege('jigged_ai_worker', g.tbl, g.priv)

  UNION ALL
  SELECT 'rls_disabled'::text, c.relname::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('ai_jobs', 'ai_workers')
    AND NOT c.relrowsecurity

  UNION ALL
  -- The billing write-gate must stay applied. Asserting the POLICY exists is the
  -- same thing tenant_tables_missing_write_gate() checks, restated locally so this
  -- table's own test file can fail on it without depending on the global guard.
  SELECT 'billing_gate_missing'::text, 'ai_jobs'::text
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename = 'ai_jobs'
       AND p.policyname = 'billing_gate_insert')

  ORDER BY 1, 2;
$$;

COMMENT ON FUNCTION public.ai_job_write_leaks() IS
  'Lists any way the browser could write ai_jobs, any access anon or jigged_ai_readonly holds to the AI tables, any grant the worker role holds beyond claim/report, RLS left off, or the billing write-gate gone missing. A CI test asserts this returns no rows. LANGUAGE sql and SECURITY INVOKER, so it is outside function_execute_leaks() by construction.';

REVOKE EXECUTE ON FUNCTION public.ai_job_write_leaks() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ai_job_write_leaks() TO service_role;
