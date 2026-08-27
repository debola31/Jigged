-- Archived rows become invisible to the insights sandbox, in RLS rather than in prose.
--
-- The bug. Asked to list late jobs not already on a list the owner pasted, the chat named
-- six that do not exist on any screen: J-0071, J-0095, J-0069, J-0061, J-0113, J-0110.
-- All six are real rows in production with deleted_at set. Running the late-job definition
-- against that company and splitting on deleted_at returns 17 live + 6 archived -- the 17
-- are exactly what the owner sees, the 6 are exactly what the chat added.
--
-- Nothing was broken. ai_readonly_select scopes company and nothing else, so archived rows
-- were always readable, and `AND deleted_at IS NULL` existed only as a sentence in
-- SCHEMA_CONTEXT and in some of semantics.md's reference queries. The model omitted it
-- once. It will omit it again -- that is what CLAUDE.md means by "a missing filter is
-- silent", and it is the repo's most-violated rule (#687) reaching a caller that writes
-- new SQL on every request.
--
-- WHY RLS AND NOT A `_live` VIEW, which is the usual advice. A view is the stronger answer
-- only when the base table is unreachable. Here it is not: the baseline's ALTER DEFAULT
-- PRIVILEGES grants SELECT on nearly every public table to jigged_ai_readonly, so a view
-- the prompt told the model to prefer would sit beside a base table it could still reach,
-- and preferring it would be one more sentence that has to hold. A policy cannot be
-- stepped around by better SQL.
--
-- WHAT THIS COSTS, STATED PLAINLY. "What did we archive last month?" becomes unanswerable
-- -- the sandbox returns zero rows rather than an error. That is the right trade: an owner
-- asking about archived work can look at the screen that shows it, whereas an owner given
-- six phantom late jobs has no way to tell.
--
-- AND WHAT IT CHANGES ABOUT JOINS, which is the part to watch. Hiding archived parents
-- changes join RESULTS, not just top-level filters: an inner join from jobs to an archived
-- customer now drops the job, silently under-counting rather than over-counting. Measured
-- against production today this affects zero rows (0 live jobs with an archived customer,
-- 0 live job_parts with an archived part, 0 live quotes with an archived customer), and
-- all 138 live jobs carry a customer_name snapshot. schema_context.py is updated in the
-- same PR to tell the model to group by jobs.customer_name rather than joining customers,
-- and semantics.md's top-customer query now does exactly that.

-- == 1. the helper learns the filter, so future tables get it automatically ===
-- Rebuilt from 20260826010319:33, verified to be the newest definition of this function
-- (20260826103645 redefined tenant_tables_missing_ai_decision, NOT this one). Only the
-- CREATE POLICY block differs; everything else is reproduced verbatim.
CREATE OR REPLACE FUNCTION public.apply_ai_read_access(
  p_table   regclass,
  p_columns text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_has_company_id boolean;
  v_rls_enabled    boolean;
  v_missing        text;
  v_soft_delete    boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = p_table AND attname = 'company_id' AND NOT attisdropped
  ) INTO v_has_company_id;

  IF NOT v_has_company_id THEN
    RAISE EXCEPTION
      'apply_ai_read_access(%) needs a direct company_id column. A child table '
      'scopes through its parent, so it takes a hand-written ai_readonly_select '
      'policy and its own GRANT -- both, in the same migration.', p_table;
  END IF;

  SELECT relrowsecurity INTO v_rls_enabled FROM pg_class WHERE oid = p_table;

  -- REFUSE RATHER THAN WARN. A grant with RLS disabled is not a narrower version
  -- of a grant with RLS enabled; it is every company's rows readable by anyone
  -- who can ask a question, with the policy below present and doing nothing.
  IF NOT v_rls_enabled THEN
    RAISE EXCEPTION
      'apply_ai_read_access(%) refuses: row level security is not enabled on it, '
      'so the grant would expose every company''s rows to the insights sandbox.',
      p_table;
  END IF;

  IF p_columns IS NOT NULL THEN
    -- A typo in a column name would silently grant less than intended, and the
    -- symptom is a query that fails months later. Name it now.
    SELECT string_agg(c, ', ') INTO v_missing
      FROM unnest(p_columns) AS c
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = p_table AND attname = c AND NOT attisdropped
     );
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'apply_ai_read_access(%): no such column(s): %', p_table, v_missing;
    END IF;

    IF NOT ('company_id' = ANY(p_columns)) THEN
      RAISE EXCEPTION
        'apply_ai_read_access(%): company_id must be among the granted columns, '
        'or the model cannot write the company_id = $1 filter every query needs.',
        p_table;
    END IF;
  END IF;

  -- The soft-delete half of the policy, decided by the table rather than by the
  -- caller: a new soft-deletable table cannot be made AI-readable WITHOUT it, which
  -- is the only version of this that survives the next table nobody thinks about.
  SELECT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = p_table AND attname = 'deleted_at' AND NOT attisdropped
  ) INTO v_soft_delete;

  EXECUTE format('DROP POLICY IF EXISTS ai_readonly_select ON %s', p_table);
  EXECUTE format(
    'CREATE POLICY ai_readonly_select ON %s FOR SELECT TO jigged_ai_readonly '
    'USING (company_id = (current_setting(''jigged.company_id'', true))::uuid%s)',
    p_table,
    CASE WHEN v_soft_delete THEN ' AND deleted_at IS NULL' ELSE '' END);

  IF p_columns IS NULL THEN
    EXECUTE format('GRANT SELECT ON %s TO jigged_ai_readonly', p_table);
  ELSE
    EXECUTE format('REVOKE SELECT ON %s FROM jigged_ai_readonly', p_table);
    EXECUTE format('GRANT SELECT (%s) ON %s TO jigged_ai_readonly',
                   (SELECT string_agg(quote_ident(c), ', ') FROM unnest(p_columns) AS c),
                   p_table);
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.apply_ai_read_access(regclass, text[]) IS
  'Make a tenant table readable by the insights SQL sandbox: GRANT SELECT to jigged_ai_readonly plus the standard per-company ai_readonly_select policy, applied together so they cannot drift apart. A table with a deleted_at column also gets AND deleted_at IS NULL in the policy, so archived rows are invisible to the model whatever SQL it writes -- decided from the table, not from an argument, so the next soft-deletable table cannot be made readable without it. Pass p_columns to grant only some columns (a table that is mostly business data and partly a credential). Refuses a table with no company_id, one with RLS disabled, an unknown column, or a column list omitting company_id. Child tables need a hand-written parent-scoped policy and their own grant. See docs/modules/ai-insights.md.';

REVOKE EXECUTE ON FUNCTION public.apply_ai_read_access(regclass, text[]) FROM PUBLIC, anon, authenticated;

-- == 2. re-apply to the seven company-scoped soft-deletable tables ============
-- shipments and vendor_addresses are NOT re-applied: neither has deleted_at, and
-- shipments carries a column list that a bare re-apply would widen back to the two
-- credential columns 20260826010319 deliberately withheld.
SELECT public.apply_ai_read_access('public.customers');
SELECT public.apply_ai_read_access('public.jobs');
SELECT public.apply_ai_read_access('public.parts');
SELECT public.apply_ai_read_access('public.quotes');
SELECT public.apply_ai_read_access('public.vendors');
SELECT public.apply_ai_read_access('public.vendor_services');
SELECT public.apply_ai_read_access('public.work_centers');

-- == 3. customer_contacts, by hand ============================================
-- The one soft-deletable AI-readable table with no company_id: it scopes through
-- customers, so the helper refuses it. Both halves of the filter are needed -- the
-- parent must be live AND the contact must be, or an archived contact of a live
-- customer stays visible.
DROP POLICY IF EXISTS ai_readonly_select ON public.customer_contacts;
CREATE POLICY ai_readonly_select ON public.customer_contacts
  FOR SELECT TO jigged_ai_readonly
  USING (
    deleted_at IS NULL
    AND customer_id IN (
      SELECT c.id FROM public.customers c
       WHERE c.company_id = (current_setting('jigged.company_id', true))::uuid
         AND c.deleted_at IS NULL
    )
  );

-- == 4. the guard, because over-permission here is silent =====================
-- The same shape as ai_policies_without_grant(): an invariant that holds today,
-- asserted on every CI run so it keeps holding. A new soft-deletable table added
-- through the helper gets the filter for free; one added by hand does not, and this
-- is what says so.
CREATE OR REPLACE FUNCTION public.ai_policies_missing_soft_delete_filter()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $fn$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_policy  p ON p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = c.oid AND a.attname = 'deleted_at' AND NOT a.attisdropped
    )
    AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%deleted_at%'
  ORDER BY 1;
$fn$;

COMMENT ON FUNCTION public.ai_policies_missing_soft_delete_filter() IS
  'Tables the insights sandbox can read that have a deleted_at column and an ai_readonly_select policy which does not mention it -- i.e. tables where the model can still see archived rows. Should always be empty; asserted by test_ai_read_access.py. Six phantom "late jobs" were reported to a shop owner in August 2026 because this held for jobs and only prose said otherwise.';

REVOKE EXECUTE ON FUNCTION public.ai_policies_missing_soft_delete_filter() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_policies_missing_soft_delete_filter() TO service_role;
