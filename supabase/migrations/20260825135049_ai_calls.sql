-- ============================================================================
-- ai_calls - the per-attempt AI spend ledger
-- ============================================================================
-- One row per provider call attempt: which feature asked, which provider and
-- model answered, what it cost, how long it took, and whether it worked.
--
-- APPEND-ONLY, AND BACKEND-WRITE ONLY. The browser has no read path and no
-- write path. This is the only record of what the AI layer costs and which
-- provider served a request, so a row that can be edited after the fact is a
-- row that cannot settle an argument with a vendor invoice, and a failed
-- attempt that can be quietly deleted is a reliability history that always
-- looks clean.
--
-- ONE ROW PER ATTEMPT, NOT PER REQUEST. A fallback chain that tries two
-- providers writes two rows; a schema-validation retry writes two more. They
-- share a request_id. Both attempts were billed, so hiding the failed one
-- under-reports the bill and destroys the only evidence a model is drifting
-- off-schema.
--
-- THREE DELIBERATE OMISSIONS from the standard new-table shape, so their
-- absence reads as a decision rather than an oversight:
--   * no updated_at trigger - there is no UPDATE path. That is the point.
--   * no deleted_at - a soft-deleted cost record is a cost record you cannot sum.
--   * no company_id - and therefore no apply_billing_write_gate(). This is a
--     PLATFORM cost ledger, not a tenant one. Per-tenant AI attribution lives in
--     ai_chat_queries, which already carries company_id and a policy. Adding one
--     here would pull the table into tenant_tables_missing_write_gate()'s scope
--     and imply a per-tenant read path that does not and should not exist.
--   * no prompt or response text - ai_chat_queries already stores those, scoped
--     and policied. A second unscoped copy of customer data is not worth it.

-- ============================================================================
-- 1. Table
-- ============================================================================
CREATE TABLE public.ai_calls (
    id            uuid          NOT NULL DEFAULT gen_random_uuid(),
    created_at    timestamptz   NOT NULL DEFAULT now(),
    feature       text          NOT NULL,
    provider      text          NOT NULL,
    model         text          NOT NULL,
    tokens_in     integer       NOT NULL,
    tokens_out    integer       NOT NULL,
    latency_ms    integer       NOT NULL,
    est_cost_usd  numeric(12,8) NOT NULL,
    request_id    uuid          NOT NULL,
    success       boolean       NOT NULL,
    error         text,

    CONSTRAINT ai_calls_pkey PRIMARY KEY (id),

    CONSTRAINT ai_calls_feature_not_blank  CHECK (length(btrim(feature))  > 0),
    CONSTRAINT ai_calls_provider_not_blank CHECK (length(btrim(provider)) > 0),
    CONSTRAINT ai_calls_model_not_blank    CHECK (length(btrim(model))    > 0),

    -- Lowercase is load-bearing, not cosmetic, for the same reason the sha256
    -- format check is on terms_acceptances: 'anthropic' and 'Anthropic' are two
    -- rows in every GROUP BY, and a cost report that silently splits a provider
    -- in half is worse than no cost report. Deliberately a SHAPE check and not
    -- an enum - the point of the provider layer above this table is that adding
    -- a provider is a Python change, not a migration.
    CONSTRAINT ai_calls_provider_lowercase CHECK (provider = lower(provider)),
    CONSTRAINT ai_calls_feature_lowercase  CHECK (feature  = lower(feature)),

    CONSTRAINT ai_calls_tokens_in_nonneg  CHECK (tokens_in  >= 0),
    CONSTRAINT ai_calls_tokens_out_nonneg CHECK (tokens_out >= 0),
    CONSTRAINT ai_calls_latency_nonneg    CHECK (latency_ms >= 0),
    CONSTRAINT ai_calls_cost_nonneg       CHECK (est_cost_usd >= 0),
    CONSTRAINT ai_calls_error_cap         CHECK (error IS NULL OR length(error) <= 2048),

    -- THE LOAD-BEARING CONSTRAINT. A failure row that does not say why is the
    -- storage-layer form of a swallowed exception, which is the exact thing the
    -- provider layer forbids in Python. Enforcing it here means a future caller
    -- that "just logs the failure" cannot log a blank one. Both directions: a
    -- success carrying an error string is equally a lie about what happened.
    CONSTRAINT ai_calls_failure_states_its_reason
        CHECK ((success AND error IS NULL)
               OR (NOT success AND error IS NOT NULL AND length(btrim(error)) > 0))

    -- NO UNIQUE on request_id, on purpose, and NOT for terms_acceptances' reason.
    -- A fallback chain writes one row PER ATTEMPT, all sharing one request_id --
    -- that shared value is the column's entire justification. A UNIQUE here would
    -- turn the second leg of a fallback into a 23505 at precisely the moment the
    -- first provider has already failed.
);

-- The cost rollup ("what did AI cost last month, by feature and provider?") is a
-- time-range scan; the GROUP BY happens over the window, so the range column leads.
-- Also serves the plain "last 100 calls" operational read.
CREATE INDEX idx_ai_calls_created_at ON public.ai_calls (created_at DESC);

-- The fallback reconstruction: "why did that one request cost $X and end up on
-- anthropic?" -- the only point lookup this table has, and the entire reason
-- request_id exists. NOT UNIQUE; see the constraint block.
CREATE INDEX idx_ai_calls_request_id ON public.ai_calls (request_id);

-- DELIBERATELY ABSENT: a partial index on (created_at DESC) WHERE NOT success, for
-- "which provider is failing right now". It is the right index eventually and the
-- wrong one today -- at this table's starting volume that query is a scan of a small
-- table, and an index whose only job is to speed up a query nobody has run yet is
-- maintenance cost with no evidence behind it. Add it when the failure dashboard
-- exists and the plan says it needs it.
--
-- DELIBERATELY ABSENT: (provider, created_at) and (feature, created_at). The rollup
-- filters on the time range first; leading with a low-cardinality column would make
-- the range predicate unusable as a scan bound.

COMMENT ON TABLE public.ai_calls IS
  'Append-only per-attempt ledger of every LLM provider call: feature, provider, model, tokens, latency, estimated cost, and success. Written only by the backend and the desktop AI worker; the browser has no read or write path. One row per ATTEMPT, so a fallback chain or a schema retry writes several sharing one request_id. Never add this to supabase_realtime and never add it to the AI SQL allowlist - it is the platform''s own cost data.';

COMMENT ON COLUMN public.ai_calls.feature IS
  'The registry feature name whose chain produced this call, already resolved - so a dev-profile run records "insights_dev", never "insights". Lowercase-constrained so a cost report cannot split one feature across two GROUP BY rows.';
COMMENT ON COLUMN public.ai_calls.provider IS
  'Registry slug of the provider that served the attempt: anthropic | deepinfra | ollama. Lowercase-constrained for the same reason as feature.';
COMMENT ON COLUMN public.ai_calls.model IS
  'The model the SERVER echoed back, not the one we asked for, so a gateway that silently reroutes is visible here.';
COMMENT ON COLUMN public.ai_calls.tokens_in IS
  'Prompt tokens as reported by the provider. 0 with a logged warning when a response carries no usage block - a 0/0 row against a paid provider is then a diagnosable signal rather than a silent free lunch.';
COMMENT ON COLUMN public.ai_calls.est_cost_usd IS
  'Estimated cost, computed in Python as Decimal at 8 dp from the registry price table. numeric(12,8) because one DeepInfra input token is $0.00000008 - exactly this resolution, and rounded to zero at the conventional scale 6. Summed exactly by Postgres; a float column would disagree with the vendor invoice over a month.';
COMMENT ON COLUMN public.ai_calls.request_id IS
  'Correlates every attempt of one logical call - both legs of a fallback and both halves of a schema retry. Joins to ai_jobs.request_id. NOT an idempotency key: unlike quickbooks_invoice_links.qb_request_id this deduplicates nothing, because LLM calls are not idempotent and no vendor treats it as one.';
COMMENT ON COLUMN public.ai_calls.error IS
  'Why the attempt failed. NOT NULL exactly when success is false, enforced by ai_calls_failure_states_its_reason - a failure row that does not say why is a swallowed exception in table form.';

-- ============================================================================
-- 2. RLS
-- ============================================================================
-- Explicit: public.rls_auto_enable() is an event trigger that exists locally and
-- on preview branches but has NEVER existed in production (it needs superuser).
ALTER TABLE public.ai_calls ENABLE ROW LEVEL SECURITY;

-- The only policy. With no permissive policy the table already denies everything;
-- the value of writing this down is that RESTRICTIVE policies AND together, so a
-- future migration that adds a well-meaning permissive SELECT still evaluates false.
--
-- jigged_ai_readonly is named EXPLICITLY, and on THIS table that is the decisive
-- reason rather than belt-and-braces. docs/modules/ai-insights.md instructs anyone
-- widening AI scope to add an `ai_readonly_select ... USING (true)` policy, and a
-- table literally named ai_calls is the first one somebody reaches for when asked
-- "how much are we spending on AI?" -- which would put the platform's own cost data
-- inside LLM-generated SQL. Listing the role here makes the deny survive that.
CREATE POLICY ai_calls_no_client_access ON public.ai_calls
    AS RESTRICTIVE FOR ALL TO anon, authenticated, jigged_ai_readonly
    USING (false) WITH CHECK (false);

-- ============================================================================
-- 3. Grants
-- ============================================================================
-- REVOKE FIRST, THEN GRANT. Relying on the absence of a grant is NOT sufficient
-- here, and this is the subtle part of the whole migration.
--
-- 20260716025048 revoked the permissive Data API default, but only its DML half.
-- A brand-new public table still arrives with `anon=Dxtm`, `authenticated=Dxtm`
-- and `service_role=Dxtm` from the baseline's ALTER DEFAULT PRIVILEGES
-- (20260527151536_baseline.sql:6428-6430) -- that is TRUNCATE, REFERENCES,
-- TRIGGER and MAINTAIN. CLAUDE.md's "do not REVOKE down from ALL, the default is
-- gone" holds for INSERT/UPDATE/DELETE and is misleading for these four.
--
-- TRUNCATE is the one that matters, because it is the only write that defeats
-- every other control in this file at once: it bypasses RLS, and it does NOT
-- fire the row-level append-only trigger below (row triggers do not run on
-- TRUNCATE). A browser role holding it could erase the entire spend ledger in
-- one statement.
REVOKE ALL ON TABLE public.ai_calls FROM anon, authenticated, service_role;

-- SELECT, INSERT -- NOT `ALL`. Every backend path runs as service_role, so
-- GRANT ALL would hand it UPDATE, DELETE and TRUNCATE and make "append-only" an
-- overstatement in the sentence at the top of this file. SELECT is granted (and
-- not withheld as on note_views) because the cost rollup is a service-role report
-- over PostgREST; there is no per-row oracle to protect, since these rows carry
-- no tenant identity and no prompt text.
GRANT SELECT, INSERT ON TABLE public.ai_calls TO service_role;

-- NO GRANT to anon or authenticated, in either direction. The browser has no read
-- path to the platform's own cost data, now or planned. An "AI spend" admin screen,
-- if one is ever built, is a service-role endpoint like every other /admin surface.

-- Also not a no-op, and reading this migration will not reveal why. The baseline
-- sets ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES TO jigged_ai_readonly
-- (20260527151536_baseline.sql:6431), so every new public table is granted to the
-- AI SQL role on creation. Without this line ai_calls ships readable-by-grant to
-- the role that executes LLM-generated SQL, held shut only by the RESTRICTIVE
-- policy above and a Python denylist. Only the database will tell you this;
-- ai_call_write_leaks() (section 5) asserts it on every CI run.
REVOKE ALL ON TABLE public.ai_calls FROM jigged_ai_readonly;

-- ============================================================================
-- 4. Append-only, enforced against the roles that CAN write
-- ============================================================================
-- RLS and grants stop the browser. They do not stop service_role, which is what
-- every backend path runs as -- so without this, "append-only" would be a
-- convention rather than a property. A trigger applies to every role.
CREATE OR REPLACE FUNCTION public.reject_ai_call_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'ai_calls is append-only: % is not permitted. A corrected or superseded cost estimate is recorded by inserting a new row; retention pruning is a reviewed migration that drops this trigger, deletes, and recreates it -- never an ad-hoc DELETE.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION public.reject_ai_call_mutation() IS
  'Trigger function making ai_calls append-only against service_role and the AI worker role, which grants alone cannot do. Trigger functions need no EXECUTE grant - permission is checked when the trigger is created, not when it fires - so this is deliberately absent from the function_execute_leaks() allowlist, and is outside that guard anyway because it is SECURITY INVOKER (the guard filters on pg_proc.prosecdef).';

-- Free, and correct under either default-privilege state. This diverges from
-- reject_terms_acceptance_mutation() (20260818142814), which omits the revoke --
-- noted so the difference reads as a choice rather than a copy error.
REVOKE EXECUTE ON FUNCTION public.reject_ai_call_mutation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER ai_calls_append_only
    BEFORE UPDATE OR DELETE ON public.ai_calls
    FOR EACH ROW EXECUTE FUNCTION public.reject_ai_call_mutation();

-- A SECOND trigger, because a row-level trigger does NOT fire on TRUNCATE.
-- Without this, the one statement that can erase the whole ledger in a single
-- shot is the one statement nothing above catches. Belt and braces against the
-- revoke in section 3.
CREATE TRIGGER ai_calls_no_truncate
    BEFORE TRUNCATE ON public.ai_calls
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_ai_call_mutation();

-- ============================================================================
-- 5. Leak guard
-- ============================================================================
-- Asserts the posture above rather than trusting it. Without this function
-- NOTHING in CI says anything about this table: tenant_tables_missing_write_gate()
-- cannot see a table with no company_id, function_execute_leaks() only scans
-- SECURITY DEFINER functions, and no_client_access_grant_leaks() hardcodes two
-- table names.
--
-- USES has_table_privilege(), NOT information_schema.role_table_grants, and the
-- difference is not stylistic. Measured on a local stack: under SET ROLE
-- service_role -- which is how PostgREST executes this -- that view returns ZERO
-- rows for grants to anon/authenticated/jigged_ai_readonly, because it only shows
-- grants where the grantor or grantee is a currently-enabled role. A guard built
-- on it is provably vacuous; public.no_client_access_grant_leaks() (20260728040701)
-- has exactly that defect. Do not extend that one -- adopting a known-broken guard
-- buys a green assertion that proves nothing.
CREATE OR REPLACE FUNCTION public.ai_call_write_leaks()
RETURNS TABLE(leak_kind text, detail text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  -- No browser or AI-SQL role may touch this table in any way at all.
  SELECT 'client_grant'::text, (v.role || ':' || p.priv)::text
  FROM (VALUES ('anon'), ('authenticated'), ('jigged_ai_readonly')) v(role),
       (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
  WHERE has_table_privilege(v.role, 'public.ai_calls', p.priv)

  UNION ALL
  -- EXTENSION over terms_acceptance_write_leaks(), which does not check this:
  -- service_role must hold SELECT and INSERT and nothing else. The three it must
  -- NOT hold are what make "append-only" a property rather than a convention.
  SELECT 'service_role_overgrant'::text, p.priv::text
  FROM (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
  WHERE has_table_privilege('service_role', 'public.ai_calls', p.priv)

  UNION ALL
  -- A PERMISSIVE policy that reaches a browser or AI-SQL role is a leak. Catches the
  -- `ai_readonly_select ... USING (true)` policy that docs/modules/ai-insights.md
  -- tells people to add when widening AI scope, and catches a policy with no TO
  -- clause -- which defaults to PUBLIC, and every role is a member of PUBLIC.
  --
  -- NOT "any permissive policy at all": the AI worker role legitimately needs one to
  -- INSERT here, because RLS is deny-by-default and a GRANT alone is not enough. That
  -- was found the hard way -- the worker had INSERT and still got "new row violates
  -- row-level security policy" -- so the guard has to distinguish who a policy reaches
  -- rather than counting policies.
  SELECT 'permissive_policy'::text,
         (pol.policyname || ' -> ' || array_to_string(pol.roles, ','))::text
  FROM pg_policies pol
  WHERE pol.schemaname = 'public' AND pol.tablename = 'ai_calls'
    AND pol.permissive = 'PERMISSIVE'
    AND pol.roles && ARRAY['anon', 'authenticated', 'jigged_ai_readonly', 'public']::name[]

  UNION ALL
  -- EXTENSION, and it closes a real hole in the ancestor. terms_acceptances'
  -- test_the_append_only_trigger_exists_behind_the_grant is named for its triggers
  -- but asserts a leak function that never inspects pg_trigger, so it is green
  -- whether or not they exist. Assert them here rather than inherit that.
  SELECT 'missing_trigger'::text, t.name::text
  FROM (VALUES ('ai_calls_append_only'), ('ai_calls_no_truncate')) t(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger g
    JOIN pg_class c     ON c.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_calls'
      AND g.tgname = t.name AND NOT g.tgisinternal)

  UNION ALL
  SELECT 'rls_disabled'::text, 'ai_calls'::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'ai_calls' AND NOT c.relrowsecurity

  ORDER BY 1, 2;
$$;

COMMENT ON FUNCTION public.ai_call_write_leaks() IS
  'Lists any way a browser or AI-SQL role could reach ai_calls, any way service_role could edit it, any permissive policy, a missing append-only trigger, or RLS left off. A CI test asserts this returns no rows. LANGUAGE sql and SECURITY INVOKER, so it is outside function_execute_leaks() by construction and needs no allowlist entry.';

REVOKE EXECUTE ON FUNCTION public.ai_call_write_leaks() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ai_call_write_leaks() TO service_role;

-- ============================================================================
-- 6. Billing write-gate completeness
-- ============================================================================
-- NOT gated by apply_billing_write_gate(), and NOT added to any exempt list --
-- because tenant_tables_missing_write_gate() inner-joins pg_attribute on
-- attname = 'company_id', so a table without that column is out of its scope BY
-- CONSTRUCTION. There is nothing to restate here, which is the point: restating a
-- CI guard from a stale copy has silently reverted entries in this repo four times
-- (see the header of 20260818142814), so the cheapest correct move is to not touch
-- it at all.
--
-- The absence of company_id is a deliberate design decision documented at the top
-- of this file, NOT an evasion of the guard. 20260728040701 names that evasion
-- explicitly as the wrong move; the difference is that this table genuinely has no
-- tenant scope -- it is the platform's own spend, and per-tenant AI attribution
-- already exists in ai_chat_queries.
