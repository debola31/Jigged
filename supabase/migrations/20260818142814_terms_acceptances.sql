-- ============================================================================
-- terms_acceptances - the clickwrap record
-- ============================================================================
-- One row per act of assent: this person, this document, this version, these
-- exact bytes (by hash), at this time from this address.
--
-- APPEND-ONLY, AND SERVICE-ROLE-WRITE ONLY. The browser can read its own rows
-- and nothing else. An audit trail the browser can INSERT into is one the
-- browser can forge -- a fabricated row, or a real one with a null IP -- and
-- the entire evidentiary value of this table is that it could not have been
-- produced by the party it is evidence against. Every write goes through
-- app/legal/accept/route.ts, which stamps the version, the hash and the IP
-- server-side and has no parameter for any of them.
--
-- TWO DELIBERATE OMISSIONS from the standard new-table shape, so their absence
-- reads as a decision rather than an oversight:
--   * no updated_at trigger - there is no UPDATE path. That is the point.
--   * no apply_billing_write_gate() - see section 6.

-- ============================================================================
-- 1. Table
-- ============================================================================
CREATE TABLE public.terms_acceptances (
    id              uuid        NOT NULL DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL,
    company_id      uuid,
    document_type   text        NOT NULL,
    version         integer     NOT NULL,
    document_sha256 text        NOT NULL,
    accepted_at     timestamptz NOT NULL DEFAULT now(),
    ip_address      inet,
    ip_source       text,
    user_agent      text,
    accepted_via    text        NOT NULL,

    CONSTRAINT terms_acceptances_pkey PRIMARY KEY (id),

    -- CASCADE, deliberately unlike auth_audit_log's SET NULL. A row that cannot
    -- name its acceptor keeps the personal data and loses the evidence, which is
    -- the worst of both. admin_routes.py really does call auth.admin.delete_user.
    CONSTRAINT terms_acceptances_user_fk FOREIGN KEY (user_id)
        REFERENCES auth.users(id) ON DELETE CASCADE,

    -- SET NULL: deleting a company must not erase a person's assent. The
    -- contract is with the person.
    CONSTRAINT terms_acceptances_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE SET NULL,

    CONSTRAINT terms_acceptances_document_type_check
        CHECK (document_type IN ('tos', 'privacy')),
    CONSTRAINT terms_acceptances_version_positive
        CHECK (version >= 1),
    -- Lowercase hex is load-bearing, not cosmetic: digest('hex') is lowercase on
    -- both sides, so two readers can never disagree by case when matching a row
    -- against public/legal/manifest.json.
    CONSTRAINT terms_acceptances_sha256_format
        CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT terms_acceptances_ip_source_check
        CHECK (ip_source IS NULL
               OR ip_source IN ('x-real-ip', 'x-forwarded-for', 'unavailable')),
    CONSTRAINT terms_acceptances_user_agent_cap
        CHECK (user_agent IS NULL OR length(user_agent) <= 1024),
    CONSTRAINT terms_acceptances_accepted_via_check
        CHECK (accepted_via IN ('invite_accept', 'signup',
                                'reacceptance_dashboard', 'reacceptance_operator'))

    -- NO UNIQUE (user_id, document_type, version), on purpose. Every tick of the
    -- box is a separate act of assent with its own timestamp and IP; collapsing
    -- two destroys evidence, and a UNIQUE would turn a benign double-submit into
    -- a 23505 in the middle of account creation. The read path is an EXISTS, so
    -- duplicates cost nothing. This is the OPPOSITE call from note_views, whose
    -- UNIQUE is load-bearing -- do not "tidy this up" to match it.
);

-- Serves the only hot query: which versions has this user accepted?
CREATE INDEX idx_terms_acceptances_user
    ON public.terms_acceptances (user_id, document_type, version);

COMMENT ON TABLE public.terms_acceptances IS
  'Append-only clickwrap record: who accepted which version of which legal document, when, and from what address. Written only by service_role via app/legal/accept/route.ts; the browser may read its own rows and nothing else. Never add this to supabase_realtime - it carries IP addresses and user agents.';

COMMENT ON COLUMN public.terms_acceptances.user_id IS
  'auth.users(id). Named user_id per the schema-wide rule that user_id means auth.users and a membership id is named for its role (author_id, reactor_id).';
COMMENT ON COLUMN public.terms_acceptances.company_id IS
  'The company the acceptance happened in, where one is known. NULLABLE and deliberately NOT a scope key: self-serve signup has no company yet, no policy reads this column, and none should - assent is personal.';
COMMENT ON COLUMN public.terms_acceptances.version IS
  'Monotonic integer matching public/legal/manifest.json. The re-acceptance test is equality against the current version, never an ordering comparison. The document is readable at /terms/v{version} and its raw bytes at /legal/{document_type}/v{version}.html.';
COMMENT ON COLUMN public.terms_acceptances.document_sha256 IS
  'SHA-256 of the exact bytes the user was shown, lowercase hex. Authored server-side from the bundled manifest, never accepted from the client. scripts/legalDocumentsCheck.ts proves the manifest still matches the files on every CI run.';
COMMENT ON COLUMN public.terms_acceptances.ip_address IS
  'Client address as determined by the platform, or NULL when it genuinely could not be determined. NEVER a sentinel: 0.0.0.0 or 127.0.0.1 here would be a fabricated fact inside a legal record.';
COMMENT ON COLUMN public.terms_acceptances.ip_source IS
  'Which header the address came from, or "unavailable". Makes the row say "the platform told us X" and separates an undeterminable address from a bug that dropped one.';
COMMENT ON COLUMN public.terms_acceptances.accepted_via IS
  'Which surface presented the document. The ONE client-supplied column, a closed set, and nothing gates on it - a clickwrap challenge turns on what the user saw, and the invite form and the operator modal present the same hash differently.';

-- ============================================================================
-- 2. RLS
-- ============================================================================
-- Explicit: public.rls_auto_enable() is an event trigger that exists locally and
-- on preview branches but has NEVER existed in production (it needs superuser).
ALTER TABLE public.terms_acceptances ENABLE ROW LEVEL SECURITY;

-- The ONLY policy, and the only non-company-scoped policy in this schema. Both
-- halves are intentional: assent is personal (a signup row has no company at
-- all), and a shop admin has no business reading a colleague's IP address and
-- browser string. A compliance export is a service-role report, not a grant.
CREATE POLICY terms_acceptances_select_own ON public.terms_acceptances
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- ============================================================================
-- 3. Grants
-- ============================================================================
-- REVOKE FIRST, THEN GRANT. Relying on the absence of a grant is NOT sufficient
-- here, and this is the subtle part of the whole migration.
--
-- 20260716025048 revoked the permissive Data API default, but only its DML half.
-- Measured on a replayed database, a brand-new public table still arrives with
-- `anon=Dxtm`, `authenticated=Dxtm` and `service_role=Dxtm` from the baseline's
-- ALTER DEFAULT PRIVILEGES (6428-) -- that is TRUNCATE, REFERENCES, TRIGGER and
-- MAINTAIN. CLAUDE.md's "do not REVOKE down from ALL, the default is gone" holds
-- for INSERT/UPDATE/DELETE and is misleading for these four.
--
-- TRUNCATE is the one that matters, because it is the only write that defeats
-- every other control in this file at once: it bypasses RLS, and it does NOT
-- fire the row-level append-only trigger below (row triggers do not run on
-- TRUNCATE). A browser role holding it could empty the entire acceptance record
-- in one statement. `note_views` avoids this only because it happens to REVOKE
-- ALL; `jobs` and most other tables still carry it today.
REVOKE ALL ON TABLE public.terms_acceptances FROM anon, authenticated, service_role;

GRANT SELECT ON TABLE public.terms_acceptances TO authenticated;

-- SELECT, INSERT - NOT `ALL`. Every backend path runs as service_role, so
-- GRANT ALL would hand it UPDATE, DELETE and TRUNCATE and make "append-only" an
-- overstatement in the sentence at the top of this file.
GRANT SELECT, INSERT ON TABLE public.terms_acceptances TO service_role;

-- Also not a no-op. The baseline sets ALTER DEFAULT PRIVILEGES ... GRANT SELECT
-- ON TABLES TO jigged_ai_readonly, so every new public table is granted to the
-- AI SQL role on creation. Reading this migration will not reveal that grant --
-- only the database will.
REVOKE ALL ON TABLE public.terms_acceptances FROM jigged_ai_readonly;

-- ============================================================================
-- 4. Append-only, enforced against the one role that can write
-- ============================================================================
-- RLS and grants stop the browser. They do not stop service_role, which is what
-- every backend path runs as -- so without this, "append-only" would be a
-- convention rather than a property. A trigger applies to every role.
CREATE OR REPLACE FUNCTION public.reject_terms_acceptance_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'terms_acceptances is append-only: % is not permitted. A withdrawn or superseded acceptance is recorded by inserting a new row, never by editing or deleting the record of what someone agreed to.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

COMMENT ON FUNCTION public.reject_terms_acceptance_mutation() IS
  'Trigger function making terms_acceptances append-only against service_role, which grants alone cannot do. Trigger functions need no EXECUTE grant - permission is checked when the trigger is created, not when it fires - so this is deliberately absent from the function_execute_leaks() allowlist.';

CREATE TRIGGER terms_acceptances_append_only
    BEFORE UPDATE OR DELETE ON public.terms_acceptances
    FOR EACH ROW EXECUTE FUNCTION public.reject_terms_acceptance_mutation();

-- A SECOND trigger, because a row-level trigger does NOT fire on TRUNCATE.
-- Without this, the one statement that can erase the whole record in a single
-- shot is the one statement nothing above catches. Belt and braces against the
-- revoke in section 3.
CREATE TRIGGER terms_acceptances_no_truncate
    BEFORE TRUNCATE ON public.terms_acceptances
    FOR EACH STATEMENT EXECUTE FUNCTION public.reject_terms_acceptance_mutation();

-- ============================================================================
-- 5. Leak guard
-- ============================================================================
-- Asserts the posture above rather than trusting it: no browser role may write
-- this table, no browser role but `authenticated` may read it, and no policy
-- exists beyond the single SELECT.
--
-- USES has_table_privilege(), NOT information_schema.role_table_grants, and the
-- difference is not stylistic. Measured on a local stack: under SET ROLE
-- service_role -- which is how PostgREST executes this -- that view returns ZERO
-- rows for grants to anon/authenticated/jigged_ai_readonly, because it only
-- shows grants where the grantor or grantee is a currently-enabled role. A guard
-- built on it is provably vacuous. public.no_client_access_grant_leaks()
-- (20260728040701) has exactly this defect and has been silently green since
-- July; it is filed separately rather than fixed here.
CREATE OR REPLACE FUNCTION public.terms_acceptance_write_leaks()
RETURNS TABLE(leak_kind text, detail text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT 'write_grant'::text, (v.role || ':' || p.priv)::text
  FROM (VALUES ('anon'), ('authenticated'), ('jigged_ai_readonly')) v(role),
       (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
  WHERE has_table_privilege(v.role, 'public.terms_acceptances', p.priv)
  UNION ALL
  SELECT 'read_grant'::text, v.role::text
  FROM (VALUES ('anon'), ('jigged_ai_readonly')) v(role)
  WHERE has_table_privilege(v.role, 'public.terms_acceptances', 'SELECT')
  UNION ALL
  SELECT 'policy'::text, (pol.policyname || ':' || pol.cmd)::text
  FROM pg_policies pol
  WHERE pol.schemaname = 'public'
    AND pol.tablename = 'terms_acceptances'
    AND pol.cmd <> 'SELECT'
  ORDER BY 1, 2;
$$;

COMMENT ON FUNCTION public.terms_acceptance_write_leaks() IS
  'Lists any way a browser role could write, or an unentitled role could read, terms_acceptances. A CI test asserts this returns no rows. LANGUAGE sql and SECURITY INVOKER, so it is outside function_execute_leaks() by construction and needs no allowlist entry.';

REVOKE EXECUTE ON FUNCTION public.terms_acceptance_write_leaks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terms_acceptance_write_leaks() TO service_role;

-- ============================================================================
-- 6. Billing write-gate completeness
-- ============================================================================
-- Recreated VERBATIM from 20260816203641_job_operation_intervals.sql -- the
-- CURRENT declaration on main, NOT 20260816043137 -- with ONE new exempt entry.
--
-- This file originally rebased from 20260816043137, which was the newest copy
-- when it was written. Main then merged #769, which added operator_time_access_log
-- and recreated this function to exempt it. Because THIS migration has the later
-- timestamp it runs last, so the older body silently overwrote theirs and the
-- guard reported their table as un-gated -- exactly the near-miss 20260801181116
-- documents. Rebasing from the newest copy is not a one-time check at authoring
-- time; it has to be re-checked before merge, because main moves underneath you.
--
-- terms_acceptances is exempt for two independent reasons, and both are true --
-- billing.md section 4 records that a plausible-but-false rationale is what
-- carried #645 through review:
--
--   1. Writes genuinely never come from the browser. `authenticated` has no
--      INSERT grant and no INSERT policy, and -- unlike part_location_stock,
--      whose exemption hid #645 -- there is no SECURITY DEFINER RPC that lets
--      the browser write it indirectly. There is no RPC at all.
--      terms_acceptance_write_leaks() re-asserts this on every CI run.
--
--   2. Gating would be incoherent. company_can_write() is false for
--      must_subscribe, which is the state of every company the moment its first
--      admin is created -- so the gate would block the acceptance that has to
--      happen BEFORE the shop can subscribe. And a lapsed (read_only) shop must
--      still be able to accept new terms: assent to a contract cannot be
--      conditioned on being current on the bill for it. The gate's
--      company_id-immutability trigger is also meaningless on a table with no
--      UPDATE path.
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_write_gate()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- identity / bootstrap (gating would block signup / team / preferences)
      'companies', 'user_company_access', 'user_preferences', 'system_admins',
      'invitations', 'demo_data_templates', 'waitlist', 'saved_insights', 'feedback',
      'company_billing',
      -- service-role-only / SELECT-only (writes never come from the browser).
      -- `part_location_stock` was removed from this list in 20260801150944: its
      -- writes DO come from the browser, through SECURITY DEFINER RPCs, and the
      -- exemption was what hid issue #645.
      'auth_audit_log', 'job_fulfillment_audit',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_invoice_links', 'quickbooks_invoice_line_items',
      'quickbooks_desktop_connections', 'quickbooks_terms_cache',
      -- SECURITY DEFINER-only writers; see 20260728040701
      'note_views', 'operator_events',
      -- Added in 20260816203641. An audit record of who looked at whose recorded
      -- time, written only by get_operator_time_detail and granted to
      -- service_role alone. The write is incidental to a read, and reads stay
      -- open when billing lapses - gating it would mean a lapsed shop either
      -- cannot look, or looks unlogged.
      'operator_time_access_log',
      -- Append-only legal record, service-role write only; see section 6 above
      'terms_acceptances'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
        AND p.policyname = 'billing_gate_insert'
    )
  ORDER BY 1;
$$;

COMMENT ON FUNCTION public.tenant_tables_missing_write_gate() IS
  'Lists public tables with a company_id column that are neither billing-gated nor exempt. A CI test asserts this returns no rows, so a new tenant table left un-gated fails the build instead of silently bypassing billing.';

GRANT EXECUTE ON FUNCTION public.tenant_tables_missing_write_gate() TO service_role;
