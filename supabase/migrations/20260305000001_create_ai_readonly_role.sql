-- ============================================================
-- Read-only Postgres role for AI text-to-SQL chat
--
-- This role is used by the sql_executor to run AI-generated
-- SELECT queries safely. It has no write permissions.
--
-- After running this migration, set the env var:
--   AI_READONLY_DATABASE_URL=postgresql://<username>:<password>@db.xxx.supabase.co:5432/postgres
--
-- NOTE: Replace 'CHANGE_ME_secure_password' with a real password.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '<username>') THEN
        CREATE ROLE <username> LOGIN PASSWORD '<password>';
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO jigged_ai_readonly;

GRANT SELECT ON
    companies,
    customers,
    quotes,
    quote_attachments,
    parts,
    routings,
    routing_nodes,
    routing_edges,
    jobs,
    job_operations,
    job_attachments,
    operation_types,
    resource_groups,
    operator_sessions,
    inventory_items,
    inventory_unit_conversions,
    inventory_transactions
TO jigged_ai_readonly;
