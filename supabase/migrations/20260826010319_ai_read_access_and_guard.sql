-- AI read access: one place a table becomes readable by the insights SQL sandbox,
-- and a guard that turns "nobody decided" into a build failure.
--
-- WHY. Four separate mechanisms decided what the insights AI could read:
--   1. GRANT SELECT to jigged_ai_readonly  (migrations) -- the real boundary
--   2. ai_readonly_select RLS policy       (migrations) -- the tenant scope
--   3. ALLOWED_TABLES                      (Python)     -- text matching
--   4. SENSITIVE_TABLES                    (Python)     -- text matching
--
-- They drifted, because four copies of one decision always do. On 2026-08-25
-- production carried (2) with no (1) on four tables -- and an RLS policy with no
-- grant is unreachable, so `shipments` refused every read while schema_context.py
-- went on naming public.job_last_ship_date() as THE way to get a ship date.
-- Meanwhile (3) listed 19 tables where 21 were granted, and rejected any CTE
-- whose alias was not coincidentally also a table name.
--
-- (3) is DELETED in this change: the grant is the allowlist. Only (1)+(2) remain,
-- applied together by one helper so they cannot disagree, plus the guards below.
--
-- NOT DEFAULT-ALLOW, DELIBERATELY. Keying access off "has a company_id column"
-- was considered and rejected: 47 public tables have one, and they include the
-- quickbooks_* OAuth tokens, customer_carrier_accounts, user_company_access,
-- auth_audit_log, company_billing, and the per-operator pace tables that
-- docs/modules/operator-view.md exists to keep out of reach. Default-allow makes
-- the next credentials table readable the moment it is created. The default here
-- is instead that a decision is REQUIRED, and that its absence is loud.

-- == 1. one call to make a direct-company_id table AI-readable ================
-- p_columns NULL grants the whole table. Naming columns grants only those, which
-- is how a table that is mostly business data and partly a credential becomes
-- usable without the credential -- see `shipments` in section 5. The old
-- four-list design could not express that at all: a table was in or out.
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

  EXECUTE format('DROP POLICY IF EXISTS ai_readonly_select ON %s', p_table);
  EXECUTE format(
    'CREATE POLICY ai_readonly_select ON %s FOR SELECT TO jigged_ai_readonly '
    'USING (company_id = (current_setting(''jigged.company_id'', true))::uuid)',
    p_table);

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
  'Make a tenant table readable by the insights SQL sandbox: GRANT SELECT to jigged_ai_readonly plus the standard per-company ai_readonly_select policy, applied together so they cannot drift apart. Pass p_columns to grant only some columns (a table that is mostly business data and partly a credential). Refuses a table with no company_id, one with RLS disabled, an unknown column, or a column list omitting company_id. Child tables need a hand-written parent-scoped policy and their own grant. See docs/modules/ai-insights.md.';

REVOKE EXECUTE ON FUNCTION public.apply_ai_read_access(regclass, text[]) FROM PUBLIC, anon, authenticated;

-- == 2. two dead policies, removed so "policy implies grant" is an invariant ==
-- job_fulfillment_audit and part_procurement_tiers carry ai_readonly_select with
-- no grant behind it. That reads as access and grants none, which is how the
-- shipments bug hid in plain sight. Dropping them changes no behaviour -- with no
-- grant neither was ever readable -- and lets the check in section 4 assert the
-- two layers agree, with no exception list of its own.
DROP POLICY IF EXISTS ai_readonly_select ON public.job_fulfillment_audit;
DROP POLICY IF EXISTS ai_readonly_select ON public.part_procurement_tiers;

-- == 3. completeness check (powers the CI guard) ==============================
-- Every public table with a company_id column must be either AI-readable or
-- listed here. Adding a NEW exempt table is a conscious one-line edit, which is
-- the entire point: the build fails until somebody decides.
--
-- has_any_column_privilege, not has_table_privilege: a column-level grant is a
-- decision too, and the table-level check reports false for one.
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_ai_decision()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $fn$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- Third-party credentials and customer account numbers. Never.
      'quickbooks_connections', 'quickbooks_customer_map', 'quickbooks_desktop_connections',
      'quickbooks_invoice_line_items', 'quickbooks_invoice_links', 'quickbooks_terms_cache',
      'customer_carrier_accounts',
      -- Authentication, authorisation, and the legal record. Never.
      'user_company_access', 'invitations', 'auth_audit_log', 'terms_acceptances',
      -- Billing state. "Am I paid up" is a support question rather than an
      -- analytics one, and this table backs the write gate.
      'company_billing',
      -- Per-operator pace and attention data. Excluded on the surveillance
      -- guardrail in docs/modules/operator-view.md: an owner able to ask "rank my
      -- operators by speed" is the reporting layer that document forbids, even
      -- though the guardrail's letter covers operator-FACING surfaces only.
      'operator_events', 'job_operation_completions', 'job_operation_intervals',
      'note_views', 'note_reactions',
      -- The AI's own plumbing. Feeding a model its own logs, config and queue
      -- invites it to answer questions about itself instead of about the shop.
      'ai_chat_queries', 'ai_config', 'ai_jobs', 'saved_insights',
      -- Free text and uploads: note bodies, attachments, comments. Readable in
      -- principle, but each wants its own look at what the text contains before
      -- it lands in a prompt.
      'notes', 'note_media', 'job_attachments', 'part_attachments',
      'work_center_attachments', 'part_comments',
      -- Closed today with no objection known. Opening one is a single
      -- apply_ai_read_access call plus a schema_context.py entry, so that the
      -- model is also told the table exists.
      'company_custom_units', 'company_order_counters', 'feedback',
      'inventory_locations', 'part_location_stock', 'part_customer_references',
      'job_fulfillment_audit'
    )
    AND NOT has_any_column_privilege('jigged_ai_readonly', c.oid, 'SELECT')
  ORDER BY 1;
$fn$;

COMMENT ON FUNCTION public.tenant_tables_missing_ai_decision() IS
  'Lists public tables with a company_id column that are neither readable by jigged_ai_readonly nor on the reviewed exempt list. A CI test asserts this returns no rows, so a new tenant table ships only once somebody has decided whether the insights AI may read it.';

REVOKE EXECUTE ON FUNCTION public.tenant_tables_missing_ai_decision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_tables_missing_ai_decision() TO service_role;

-- == 4. the invariant the shipments bug violated ==============================
CREATE OR REPLACE FUNCTION public.ai_policies_without_grant()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $fn$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
    )
    AND NOT has_any_column_privilege('jigged_ai_readonly', c.oid, 'SELECT')
  ORDER BY 1;
$fn$;

COMMENT ON FUNCTION public.ai_policies_without_grant() IS
  'Lists tables carrying the ai_readonly_select policy with no SELECT grant behind it. RLS with no grant is unreachable, so every row here is a table that looks AI-readable and refuses every query -- the shape that let public.job_last_ship_date() fail while the schema context recommended it.';

REVOKE EXECUTE ON FUNCTION public.ai_policies_without_grant() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_policies_without_grant() TO service_role;

-- == 5. repair: the shipment pair the schema context already depends on =======
-- public.job_last_ship_date() is SECURITY INVOKER and its body reads both, and
-- schema_context.py names it as THE way to get a ship date now that
-- jobs.shipped_at is gone. Until now the role could execute the function and not
-- read the tables inside it, so every ship-date question failed.
--
-- EVERY COLUMN EXCEPT TWO, and the exception is the point of p_columns.
-- docs/modules/customers.md lists "AI SQL layer: unreachable" among the layers
-- protecting the customer's carrier account. freight_account_snapshot holds
-- has_account and account_last4 (never the full number), and
-- customer_carrier_account_id is the FK to the table that holds it. Granting the
-- whole table would have quietly traded that protection for a ship date. Naming
-- the other 18 columns keeps shipping data answerable and states the exclusion
-- where the grant is, rather than resting on the table being closed entirely.
SELECT public.apply_ai_read_access('public.shipments', ARRAY[
  'id', 'company_id', 'customer_id', 'shipping_address_id', 'one_time_address',
  'packing_slip_number', 'ship_date', 'carrier', 'created_by', 'created_at',
  'voided_at', 'voided_by', 'shipping_method', 'job_id', 'customer_name',
  'bill_to_address', 'ship_to_address', 'freight_terms'
]);

-- shipment_line_items has no company_id; it scopes through its shipment, and its
-- hand-written ai_readonly_select policy already says so. Only the grant was
-- missing, and it carries nothing sensitive.
GRANT SELECT ON public.shipment_line_items TO jigged_ai_readonly;
