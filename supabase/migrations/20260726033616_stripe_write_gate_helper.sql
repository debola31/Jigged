-- Billing write-gate: maintenance helpers.
--
-- Postgres RLS is per-table (no global write hook), so every browser-writable
-- tenant table needs the billing_gate_* restrictive policies that call
-- company_can_write(). To keep that a one-liner (not hand-copied policy SQL) and
-- to make a forgotten table a LOUD CI failure instead of silent tech debt, this
-- migration adds:
--   1. apply_billing_write_gate(regclass) — attach the gate to a direct-company_id
--      table in one call. Use it in the migration for any new tenant table.
--   2. tenant_tables_missing_write_gate() — lists any public table with a
--      company_id column that is neither gated nor on the exempt list. A CI test
--      asserts this is empty (see api/tests/integration/test_billing_enforcement.py).

-- ── 1. one-line gate for a new direct-company_id tenant table ──────────────────
CREATE OR REPLACE FUNCTION public.apply_billing_write_gate(p_table regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS billing_gate_insert ON %s', p_table);
  EXECUTE format('DROP POLICY IF EXISTS billing_gate_update ON %s', p_table);
  EXECUTE format('DROP POLICY IF EXISTS billing_gate_delete ON %s', p_table);
  EXECUTE format(
    'CREATE POLICY billing_gate_insert ON %s AS RESTRICTIVE FOR INSERT TO authenticated '
    'WITH CHECK (public.company_can_write(company_id))', p_table);
  EXECUTE format(
    'CREATE POLICY billing_gate_update ON %s AS RESTRICTIVE FOR UPDATE TO authenticated '
    'USING (public.company_can_write(company_id)) WITH CHECK (public.company_can_write(company_id))',
    p_table);
  EXECUTE format(
    'CREATE POLICY billing_gate_delete ON %s AS RESTRICTIVE FOR DELETE TO authenticated '
    'USING (public.company_can_write(company_id))', p_table);
END;
$$;

COMMENT ON FUNCTION public.apply_billing_write_gate(regclass) IS
  'Attach the billing write-gate (restrictive INSERT/UPDATE/DELETE policies calling company_can_write) to a tenant table with a direct company_id column. Call in the migration for any new tenant table. Parent-resolved child tables (no company_id) still need hand-written policies. See docs/modules/billing.md.';

-- ── 2. completeness check (powers the CI guard) ───────────────────────────────
-- Any public table with a company_id column must be either gated or explicitly
-- exempt. The exempt set = identity/bootstrap tables + service-role-only /
-- SELECT-only tables (whose writes never come from the browser, so RLS can't gate
-- them anyway). Adding a NEW exempt table is a conscious one-line edit here.
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
      -- service-role-only / SELECT-only (writes never come from the browser)
      'auth_audit_log', 'job_fulfillment_audit', 'part_location_stock',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_invoice_links', 'quickbooks_invoice_line_items'
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

-- ── 3. gate a tenant table the earlier enforcement migration missed ───────────
-- job_operation_completions (company_id, browser-writable) was added after the
-- write-enforcement migration's table list was built, so it shipped un-gated.
-- The completeness check above flags it; gate it here via the new helper.
SELECT public.apply_billing_write_gate('public.job_operation_completions');
