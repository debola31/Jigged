-- ============================================================
-- Grant RLS bypass for jigged_ai_readonly on all business tables.
--
-- The jigged_ai_readonly role connects via asyncpg (not Supabase auth),
-- so auth.uid() returns NULL and standard RLS policies block all reads.
-- These permissive SELECT policies allow the role to read all rows.
-- Company scoping is enforced by the parameterized $1 in every query.
-- ============================================================

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'companies','customers','quotes','quote_attachments','parts',
    'routings','routing_nodes','routing_edges',
    'jobs','job_operations','job_attachments',
    'operation_types','resource_groups','operator_sessions',
    'inventory_items','inventory_unit_conversions','inventory_transactions'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS ai_readonly_select ON %I', t);
    EXECUTE format(
      'CREATE POLICY ai_readonly_select ON %I FOR SELECT TO <username> USING (true)', t
    );
  END LOOP;
END $$;
