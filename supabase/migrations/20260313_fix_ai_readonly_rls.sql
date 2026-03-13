-- Fix: Replace USING (true) ai_readonly RLS policies with company-scoped ones.
-- Uses current_setting('jigged.company_id') which must be SET before each query
-- by the sql_executor.

-- ============================================================================
-- 1. Create role (idempotent)
-- ============================================================================

DO $$ BEGIN
  CREATE ROLE jigged_ai_readonly NOINHERIT NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT USAGE ON SCHEMA public TO jigged_ai_readonly;

GRANT SELECT ON
  companies, customers, inventory_items, inventory_transactions,
  inventory_unit_conversions, job_attachments, job_operations, jobs,
  operation_types, operator_sessions, parts, quote_attachments, quotes,
  resource_groups, routing_edges, routing_nodes, routings
TO jigged_ai_readonly;

-- ============================================================================
-- 2. Replace ai_readonly_select policies — tables WITH company_id
-- ============================================================================

-- companies
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."companies";
CREATE POLICY "ai_readonly_select" ON "public"."companies"
    FOR SELECT TO jigged_ai_readonly
    USING (id = current_setting('jigged.company_id', true)::uuid);

-- customers
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."customers";
CREATE POLICY "ai_readonly_select" ON "public"."customers"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- inventory_items
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."inventory_items";
CREATE POLICY "ai_readonly_select" ON "public"."inventory_items"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- inventory_transactions
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."inventory_transactions";
CREATE POLICY "ai_readonly_select" ON "public"."inventory_transactions"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- job_attachments
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."job_attachments";
CREATE POLICY "ai_readonly_select" ON "public"."job_attachments"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- jobs
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."jobs";
CREATE POLICY "ai_readonly_select" ON "public"."jobs"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- operation_types
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."operation_types";
CREATE POLICY "ai_readonly_select" ON "public"."operation_types"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- operator_sessions
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."operator_sessions";
CREATE POLICY "ai_readonly_select" ON "public"."operator_sessions"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- parts
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."parts";
CREATE POLICY "ai_readonly_select" ON "public"."parts"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- quote_attachments
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."quote_attachments";
CREATE POLICY "ai_readonly_select" ON "public"."quote_attachments"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- quotes
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."quotes";
CREATE POLICY "ai_readonly_select" ON "public"."quotes"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- resource_groups
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."resource_groups";
CREATE POLICY "ai_readonly_select" ON "public"."resource_groups"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- routings
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."routings";
CREATE POLICY "ai_readonly_select" ON "public"."routings"
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = current_setting('jigged.company_id', true)::uuid);

-- ============================================================================
-- 3. Replace ai_readonly_select policies — tables WITHOUT company_id (FK join)
-- ============================================================================

-- job_operations → join through jobs
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."job_operations";
CREATE POLICY "ai_readonly_select" ON "public"."job_operations"
    FOR SELECT TO jigged_ai_readonly
    USING (EXISTS (
        SELECT 1 FROM jobs
        WHERE jobs.id = job_operations.job_id
        AND jobs.company_id = current_setting('jigged.company_id', true)::uuid
    ));

-- routing_nodes → join through routings
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."routing_nodes";
CREATE POLICY "ai_readonly_select" ON "public"."routing_nodes"
    FOR SELECT TO jigged_ai_readonly
    USING (EXISTS (
        SELECT 1 FROM routings
        WHERE routings.id = routing_nodes.routing_id
        AND routings.company_id = current_setting('jigged.company_id', true)::uuid
    ));

-- routing_edges → join through routings
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."routing_edges";
CREATE POLICY "ai_readonly_select" ON "public"."routing_edges"
    FOR SELECT TO jigged_ai_readonly
    USING (EXISTS (
        SELECT 1 FROM routings
        WHERE routings.id = routing_edges.routing_id
        AND routings.company_id = current_setting('jigged.company_id', true)::uuid
    ));

-- inventory_unit_conversions → join through inventory_items
DROP POLICY IF EXISTS "ai_readonly_select" ON "public"."inventory_unit_conversions";
CREATE POLICY "ai_readonly_select" ON "public"."inventory_unit_conversions"
    FOR SELECT TO jigged_ai_readonly
    USING (EXISTS (
        SELECT 1 FROM inventory_items
        WHERE inventory_items.id = inventory_unit_conversions.inventory_item_id
        AND inventory_items.company_id = current_setting('jigged.company_id', true)::uuid
    ));

-- ============================================================================
-- 4. Force RLS on all business tables (prevents bypass by privileged roles)
-- ============================================================================

ALTER TABLE "public"."companies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."customers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_transactions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."inventory_unit_conversions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_attachments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."job_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."jobs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."operation_types" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."operator_sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."parts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."quote_attachments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."quotes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."resource_groups" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."routing_edges" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."routing_nodes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "public"."routings" FORCE ROW LEVEL SECURITY;
