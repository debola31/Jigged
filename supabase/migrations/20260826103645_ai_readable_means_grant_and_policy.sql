-- "AI-readable" is a grant AND a policy, not a grant.
--
-- 20260826010319 shipped tenant_tables_missing_ai_decision() testing only
-- has_any_column_privilege, on the belief that the GRANT is the allowlist. It is
-- not, and the number is stark: 55 of 65 public tables hold a SELECT grant for
-- jigged_ai_readonly, because the baseline's ALTER DEFAULT PRIVILEGES hands one
-- out on every new public table. A bare grant is close to meaningless here.
--
-- What actually makes rows visible is the ai_readonly_select POLICY. Measured on
-- a seeded stack, as the role, with jigged.company_id set to a company that has
-- data: auth_audit_log, user_company_access, company_billing, saved_insights and
-- the quickbooks_* tables all hold a grant and every one returns ZERO ROWS,
-- because their policies key on auth.uid() and that is NULL on the sandbox
-- connection. Nothing leaks today. But the protection is incidental to those
-- policies' purpose, and the guard was reading it as deliberate.
--
-- The consequence was narrow and worth stating plainly: the guard passed, and
-- would have kept passing, but anyone REMOVING a table from the exempt list
-- would have been told "already readable, nothing to do" about a table that
-- answers nothing. Requiring the policy makes the check mean what its name says.
--
-- A NEW MIGRATION RATHER THAN AN EDIT. 20260826010319 is already applied to
-- production -- Supabase Preview reported the production apply green on the
-- merge commit -- so editing it would leave the repo asserting a body production
-- does not have, which is the drift docs/runbooks/database-migrations.md exists
-- to prevent.

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
    -- BOTH layers. has_any_column_privilege rather than has_table_privilege so a
    -- column-level grant still counts as a decision (see `shipments`).
    AND NOT (
      has_any_column_privilege('jigged_ai_readonly', c.oid, 'SELECT')
      AND EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
      )
    )
  ORDER BY 1;
$fn$;

COMMENT ON FUNCTION public.tenant_tables_missing_ai_decision() IS
  'Lists public tables with a company_id column that are neither AI-readable nor on the reviewed exempt list. AI-readable means a SELECT grant AND an ai_readonly_select policy: the grant alone is close to meaningless, since the baseline grants SELECT to jigged_ai_readonly on nearly every public table and it is the policy that makes rows visible. A CI test asserts this returns no rows.';

-- CREATE OR REPLACE keeps the ACL, but re-issuing costs nothing and is correct
-- under either state.
REVOKE EXECUTE ON FUNCTION public.tenant_tables_missing_ai_decision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_tables_missing_ai_decision() TO service_role;
