-- ============================================================================
-- Migration: Unify parts + inventory; add work_centers and vendors
-- ============================================================================
--
-- This migration replaces the historical split between `parts` (manufacturable
-- items) and `inventory_items` (stockable items) with a single unified `parts`
-- table classified by two booleans (is_manufacturable, is_stockable). It also
-- introduces first-class `vendors` and `work_centers` (replacing
-- `operation_types`), and a new `parts_bom` table that subsumes the previous
-- per-routing materials list. See:
--
--   /Users/adebolaakeredolu/.claude/plans/re-architect-parts-inventory-and-whimsical-hollerith.md
--
-- DESTRUCTIVE / FORWARD-ONLY. The user explicitly approved dropping every
-- table that holds row data tied to the old shape and rebuilding from
-- scratch. Pre-revenue, no production users, no data to preserve. Devs must
-- commit / push WIP before pulling — pulling this migration and running
-- `supabase db reset` will wipe all parts / inventory / quotes / jobs /
-- routings / operation_types data in the dev database.
--
-- The single transaction covers:
--   Phase 1: drop in dependency order (tables + dependent functions)
--   Phase 2: recreate every table in its final shape
--   Phase 3: recreate functions/triggers (compute_job_status,
--            sync_job_status_from_parts, restrict_transaction_update_to_notes)
--            plus rewritten create_job_part_operations_from_routing and new
--            recalculate_part_cost + enforce_no_bom_cycles
--   Phase 4: rewrite the active demo_data_templates row to a minimal known-
--            good seed against the new schema (full demo dataset is rebuilt in
--            PR 3 alongside the UI work)
--   Phase 5: restore operator_sessions FKs against the new tables
-- ============================================================================

BEGIN;

-- ============================================================================
-- Phase 1: Drop tables and dependent functions in dependency order
-- ============================================================================
--
-- Order matters even with CASCADE because some FK chains pass through tables
-- we want to keep (e.g. operator_sessions points at operation_types and
-- job_operations). We drop child tables first, then move up to parents. Every
-- DROP TABLE uses CASCADE so any indexes, RLS policies, triggers, and
-- dependent objects (e.g. the FKs from operator_sessions on the dropped
-- tables) are removed in the same statement. Phase 5 re-adds the
-- operator_sessions FKs against the new tables.
--
-- The legacy `seed_demo_data`, `reset_demo_company`, and `create_demo_company`
-- functions reference many dropped tables in their bodies (operation_types,
-- inventory_items, routing_nodes, routing_materials, parts.category_id which
-- doesn't even exist anymore). Per the no-tech-debt rule we drop them here
-- rather than leave broken function definitions in the DB. PR 3 will rebuild
-- the seed flow against the new schema alongside the UI work; the
-- demo_data_templates row survives (with its template_data jsonb rewritten in
-- Phase 4 to a minimal seed) so the eventual rebuild has a known starting
-- point.
--
-- The legacy `convert_quote_to_job` function was already broken in the
-- current schema (references quotes.converted_to_job_id, quotes.part_id,
-- quotes.description — none exist; status check uses 'accepted' but the
-- enum only allows 'active'/'expired'; calls create_job_operations_from_routing
-- under its old name). Dropping it here is a cleanup, not a regression.
--
-- get_ready_operations_for_station and get_ready_operations_batch are dropped
-- and recreated in Phase 3 against the new column names (operation_type_id →
-- work_center_id on job_operations). The operator station view depends on
-- these and would break otherwise.

DROP TABLE IF EXISTS public.job_materials      CASCADE;
DROP TABLE IF EXISTS public.job_operations     CASCADE;
DROP TABLE IF EXISTS public.job_parts          CASCADE;
DROP TABLE IF EXISTS public.jobs               CASCADE;
DROP TABLE IF EXISTS public.quote_materials    CASCADE;
DROP TABLE IF EXISTS public.quote_line_items   CASCADE;
DROP TABLE IF EXISTS public.quote_operations   CASCADE;
DROP TABLE IF EXISTS public.quotes             CASCADE;
DROP TABLE IF EXISTS public.part_pricing_tiers CASCADE;
DROP TABLE IF EXISTS public.inventory_transactions      CASCADE;
DROP TABLE IF EXISTS public.inventory_unit_conversions  CASCADE;
DROP TABLE IF EXISTS public.routing_materials  CASCADE;
DROP TABLE IF EXISTS public.routing_nodes      CASCADE;
DROP TABLE IF EXISTS public.routings           CASCADE;
DROP TABLE IF EXISTS public.operation_types    CASCADE;
DROP TABLE IF EXISTS public.inventory_items    CASCADE;
DROP TABLE IF EXISTS public.parts              CASCADE;

-- Functions that referenced dropped tables. CASCADE on these because some
-- functions are referenced by triggers on tables we will recreate (e.g.
-- restrict_transaction_update_to_notes is wired to the new
-- inventory_transactions table in Phase 3).
DROP FUNCTION IF EXISTS public.create_job_part_operations_from_routing(uuid, uuid)            CASCADE;
DROP FUNCTION IF EXISTS public.create_job_operations_from_routing(uuid, uuid)                 CASCADE;
DROP FUNCTION IF EXISTS public.restrict_transaction_update_to_notes()                         CASCADE;
DROP FUNCTION IF EXISTS public.sync_job_status_from_parts()                                   CASCADE;
DROP FUNCTION IF EXISTS public.compute_job_status(uuid)                                       CASCADE;
DROP FUNCTION IF EXISTS public.get_ready_operations_for_station(uuid, uuid)                   CASCADE;
DROP FUNCTION IF EXISTS public.get_ready_operations_batch(uuid[])                             CASCADE;
DROP FUNCTION IF EXISTS public.convert_quote_to_job(uuid, text)                               CASCADE;
-- Demo seeding functions: drop here, rebuild in PR 3 against new schema.
DROP FUNCTION IF EXISTS public.seed_demo_data(uuid, uuid, character varying)                  CASCADE;
DROP FUNCTION IF EXISTS public.reset_demo_company(uuid, uuid)                                 CASCADE;
DROP FUNCTION IF EXISTS public.create_demo_company(uuid, uuid, character varying)             CASCADE;

-- Survivors (NOT dropped): companies, customers, user_company_access,
-- user_preferences, markup_rates, ai_chat_queries, ai_config,
-- company_custom_units, demo_data_templates, invitations, saved_insights,
-- system_admins, waitlist, operator_sessions. The operator_sessions table
-- survives but loses its FKs to operation_types / job_operations; Phase 5
-- restores them against the new tables (and renames the column).

-- ============================================================================
-- Phase 2: Recreate tables in the new shape
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 2.1 vendors (new) — first-class supplier/outside-op partner
-- ----------------------------------------------------------------------------
--
-- Vendors carry no capability flags. A vendor's role ("supplies materials" /
-- "performs outside ops") is derived from references:
--   - Supplies materials: EXISTS (SELECT 1 FROM parts WHERE preferred_vendor_id = vendors.id)
--   - Performs outside ops: EXISTS (SELECT 1 FROM work_centers WHERE vendor_id = vendors.id)
-- This avoids the "anemic-data named-pattern" trap (capability flags that
-- silently drift from actual references).

CREATE TABLE IF NOT EXISTS public.vendors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name            text NOT NULL,
    contact_name    text,
    contact_email   text,
    contact_phone   text,
    address_line1   text,
    address_line2   text,
    city            text,
    state           text,
    postal_code     text,
    country         text DEFAULT 'USA',
    notes           text,
    legacy_id       text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- Plain unique (not DEFERRABLE). The bulk vendor importer does its own
    -- merge-confirmation pass before insert; we never have two rows in flight
    -- with the same (company_id, name). DEFERRABLE here would queue per-row
    -- check events that prevent later ALTER TABLE statements in the same
    -- transaction (Postgres error 55006).
    CONSTRAINT vendors_unique_per_company UNIQUE (company_id, name),
    CONSTRAINT vendors_legacy_id_unique_per_company UNIQUE (company_id, legacy_id)
);

CREATE INDEX IF NOT EXISTS idx_vendors_company ON public.vendors (company_id);

DROP TRIGGER IF EXISTS vendors_updated_at ON public.vendors;
CREATE TRIGGER vendors_updated_at
    BEFORE UPDATE ON public.vendors
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE  public.vendors IS 'Supplier / outside-op partner. Roles are derived from references in parts.preferred_vendor_id and work_centers.vendor_id; no capability flags here.';
COMMENT ON COLUMN public.vendors.legacy_id IS 'Source-system identifier from CSV import; allows ON CONFLICT (company_id, legacy_id) DO UPDATE for safe re-import.';

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view vendors" ON public.vendors;
CREATE POLICY "Users can view vendors"
    ON public.vendors
    FOR SELECT
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can insert vendors" ON public.vendors;
CREATE POLICY "Users can insert vendors"
    ON public.vendors
    FOR INSERT
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can update vendors" ON public.vendors;
CREATE POLICY "Users can update vendors"
    ON public.vendors
    FOR UPDATE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can delete vendors" ON public.vendors;
CREATE POLICY "Users can delete vendors"
    ON public.vendors
    FOR DELETE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.vendors;
CREATE POLICY "ai_readonly_select"
    ON public.vendors
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.2 parts (recreated) — unified item master
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.parts (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    part_name               text NOT NULL,
    description             text,
    is_manufacturable       boolean NOT NULL DEFAULT true,
    is_stockable            boolean NOT NULL DEFAULT false,
    primary_unit            text,
    quantity                numeric NOT NULL DEFAULT 0,
    cost_per_unit           numeric(12,4),
    cost_recalculated_at    timestamptz,
    reorder_point           numeric,
    preferred_vendor_id     uuid REFERENCES public.vendors(id) ON DELETE SET NULL,
    legacy_id               text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT parts_unique_per_company           UNIQUE (company_id, part_name),
    CONSTRAINT parts_legacy_id_unique_per_company UNIQUE (company_id, legacy_id),
    CONSTRAINT parts_quantity_non_negative        CHECK (quantity >= 0),
    -- A stockable item must have a primary unit; otherwise inventory ops are
    -- ambiguous. Manufacturable-only items (no inventory tracking) may leave
    -- primary_unit NULL.
    CONSTRAINT parts_stockable_requires_unit
        CHECK (NOT is_stockable OR primary_unit IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_parts_company_id    ON public.parts (company_id);
CREATE INDEX IF NOT EXISTS idx_parts_part_name     ON public.parts (company_id, part_name);
CREATE INDEX IF NOT EXISTS idx_parts_company_manufacturable
    ON public.parts (company_id) WHERE is_manufacturable;
CREATE INDEX IF NOT EXISTS idx_parts_company_stockable
    ON public.parts (company_id) WHERE is_stockable;
CREATE INDEX IF NOT EXISTS idx_parts_preferred_vendor
    ON public.parts (preferred_vendor_id) WHERE preferred_vendor_id IS NOT NULL;

DROP TRIGGER IF EXISTS parts_updated_at ON public.parts;
CREATE TRIGGER parts_updated_at
    BEFORE UPDATE ON public.parts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE  public.parts IS 'Unified item master. Replaces the prior two-table split between manufacturable parts and stockable inventory_items.';
COMMENT ON COLUMN public.parts.is_manufacturable IS 'True if this part can be made in-house (will have a routing). Used for the "Manufactured" saved view and to gate the routing panel on the part detail page.';
COMMENT ON COLUMN public.parts.is_stockable IS 'True if quantities of this part are tracked in inventory. Used for the "Inventory" saved view, the inventory panel on the part detail page, and the reorder alerts query.';
COMMENT ON COLUMN public.parts.primary_unit IS 'Canonical unit of the on-hand quantity and the cost_per_unit. Required when is_stockable=true; may be NULL for manufactured-only parts.';
COMMENT ON COLUMN public.parts.quantity IS 'On-hand quantity in primary_unit. Defaults to 0; updated by inventory_transactions and the import flow.';
COMMENT ON COLUMN public.parts.cost_per_unit IS 'Per-primary_unit cost. For bought items, the procurement cost. For manufacturable items, snapshot from the most recent recalculate_part_cost call.';
COMMENT ON COLUMN public.parts.cost_recalculated_at IS 'When recalculate_part_cost last ran for this part. Used by the part detail page to surface a "Cost may be stale" badge when any BOM descendant has updated_at newer than this timestamp.';
COMMENT ON COLUMN public.parts.reorder_point IS 'Threshold below which the inventory alert fires (quantity <= reorder_point). NULL disables the alert.';
COMMENT ON COLUMN public.parts.preferred_vendor_id IS 'Default supplier for procurement. The presence of any row pointing at a vendor makes that vendor a "supplier" in the derived-role calculation on the Vendors page.';
COMMENT ON COLUMN public.parts.legacy_id IS 'Source-system identifier from CSV import; allows ON CONFLICT (company_id, legacy_id) DO UPDATE for safe re-import. NULL for hand-created parts.';

ALTER TABLE public.parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view parts for their companies" ON public.parts;
CREATE POLICY "Users can view parts for their companies"
    ON public.parts
    FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can insert parts for their companies" ON public.parts;
CREATE POLICY "Users can insert parts for their companies"
    ON public.parts
    FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                               FROM user_company_access
                               WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can update parts for their companies" ON public.parts;
CREATE POLICY "Users can update parts for their companies"
    ON public.parts
    FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can delete parts for their companies" ON public.parts;
CREATE POLICY "Users can delete parts for their companies"
    ON public.parts
    FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

-- ai_readonly_select policy intentionally does NOT filter by classification.
-- The AI assistant operates on the unified item master across both
-- is_manufacturable and is_stockable axes; filtering here would silently hide
-- rows from analytical queries (e.g. "show all sub-assemblies" / "show all
-- raw materials"). Classification is the AI's concern, not the policy's.
DROP POLICY IF EXISTS "ai_readonly_select" ON public.parts;
CREATE POLICY "ai_readonly_select"
    ON public.parts
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.3 parts_unit_conversions (recreated, replaces inventory_unit_conversions)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.parts_unit_conversions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    part_id             uuid NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
    from_unit           text NOT NULL,
    to_primary_factor   numeric NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT parts_unit_conversions_part_unit_unique UNIQUE (part_id, from_unit),
    CONSTRAINT parts_unit_conversions_factor_positive  CHECK (to_primary_factor > 0)
);

CREATE INDEX IF NOT EXISTS idx_parts_unit_conversions_part
    ON public.parts_unit_conversions (part_id);

COMMENT ON TABLE  public.parts_unit_conversions IS 'Per-part conversion factors from alternate units to the part primary_unit. Replaces inventory_unit_conversions.';
COMMENT ON COLUMN public.parts_unit_conversions.to_primary_factor IS 'Multiplier: quantity_in_from_unit * to_primary_factor = quantity_in_primary_unit.';

ALTER TABLE public.parts_unit_conversions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view parts_unit_conversions" ON public.parts_unit_conversions;
CREATE POLICY "Users can view parts_unit_conversions"
    ON public.parts_unit_conversions
    FOR SELECT
    USING (part_id IN (SELECT parts.id FROM parts
                       WHERE parts.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can insert parts_unit_conversions" ON public.parts_unit_conversions;
CREATE POLICY "Users can insert parts_unit_conversions"
    ON public.parts_unit_conversions
    FOR INSERT
    WITH CHECK (part_id IN (SELECT parts.id FROM parts
                            WHERE parts.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can update parts_unit_conversions" ON public.parts_unit_conversions;
CREATE POLICY "Users can update parts_unit_conversions"
    ON public.parts_unit_conversions
    FOR UPDATE
    USING (part_id IN (SELECT parts.id FROM parts
                       WHERE parts.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can delete parts_unit_conversions" ON public.parts_unit_conversions;
CREATE POLICY "Users can delete parts_unit_conversions"
    ON public.parts_unit_conversions
    FOR DELETE
    USING (part_id IN (SELECT parts.id FROM parts
                       WHERE parts.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.parts_unit_conversions;
CREATE POLICY "ai_readonly_select"
    ON public.parts_unit_conversions
    FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (SELECT 1 FROM parts
                   WHERE parts.id = parts_unit_conversions.part_id
                     AND parts.company_id = (current_setting('jigged.company_id', true))::uuid));

-- ----------------------------------------------------------------------------
-- 2.4 parts_bom (new) — bill-of-materials / sub-assembly edges
-- ----------------------------------------------------------------------------
--
-- One parts_bom row = one BOM edge: parent_part consumes `quantity` of
-- child_part. The unique constraint blocks duplicate edges (parent→child
-- twice). Cycles are blocked by the enforce_no_bom_cycles trigger created in
-- Phase 3 — the unique constraint and the no-self-reference CHECK do NOT
-- prevent A→B + B→A (two distinct rows that both pass both checks but form a
-- 2-cycle), and that case would silently corrupt cost rollups.

CREATE TABLE IF NOT EXISTS public.parts_bom (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_part_id  uuid NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
    child_part_id   uuid NOT NULL REFERENCES public.parts(id) ON DELETE RESTRICT,
    quantity        numeric NOT NULL,
    unit            text NOT NULL,
    sequence        integer NOT NULL DEFAULT 0,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT parts_bom_unique_child         UNIQUE (parent_part_id, child_part_id),
    CONSTRAINT parts_bom_quantity_positive    CHECK (quantity > 0),
    CONSTRAINT parts_bom_no_self_reference    CHECK (parent_part_id <> child_part_id)
);

CREATE INDEX IF NOT EXISTS idx_parts_bom_parent ON public.parts_bom (parent_part_id);
CREATE INDEX IF NOT EXISTS idx_parts_bom_child  ON public.parts_bom (child_part_id);

DROP TRIGGER IF EXISTS parts_bom_updated_at ON public.parts_bom;
CREATE TRIGGER parts_bom_updated_at
    BEFORE UPDATE ON public.parts_bom
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE  public.parts_bom IS 'BOM edges. Replaces routing_materials — BOM is now part-attached (one BOM per manufactured part), not routing-attached.';
COMMENT ON COLUMN public.parts_bom.quantity IS 'Quantity of child consumed per unit of parent, expressed in `unit`. Cost rollups convert to the child part primary_unit via parts_unit_conversions if `unit` differs.';
COMMENT ON COLUMN public.parts_bom.unit IS 'Unit the BOM line is denominated in. Canonical for job_materials snapshots; cost rollups convert to the child part primary_unit when different.';
COMMENT ON COLUMN public.parts_bom.sequence IS 'Display order in the BOM panel. Steps of 10 leave room for inserts.';

ALTER TABLE public.parts_bom ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view parts_bom" ON public.parts_bom;
CREATE POLICY "Users can view parts_bom"
    ON public.parts_bom
    FOR SELECT
    USING (parent_part_id IN (SELECT parts.id FROM parts
                              WHERE parts.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can insert parts_bom" ON public.parts_bom;
CREATE POLICY "Users can insert parts_bom"
    ON public.parts_bom
    FOR INSERT
    WITH CHECK (parent_part_id IN (SELECT parts.id FROM parts
                                   WHERE parts.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can update parts_bom" ON public.parts_bom;
CREATE POLICY "Users can update parts_bom"
    ON public.parts_bom
    FOR UPDATE
    USING (parent_part_id IN (SELECT parts.id FROM parts
                              WHERE parts.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can delete parts_bom" ON public.parts_bom;
CREATE POLICY "Users can delete parts_bom"
    ON public.parts_bom
    FOR DELETE
    USING (parent_part_id IN (SELECT parts.id FROM parts
                              WHERE parts.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.parts_bom;
CREATE POLICY "ai_readonly_select"
    ON public.parts_bom
    FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (SELECT 1 FROM parts
                   WHERE parts.id = parts_bom.parent_part_id
                     AND parts.company_id = (current_setting('jigged.company_id', true))::uuid));

-- ----------------------------------------------------------------------------
-- 2.5 inventory_transactions (recreated) — ledger for stockable parts
-- ----------------------------------------------------------------------------
--
-- Same shape as before, but `inventory_item_id` is renamed to `part_id` and
-- now FK's to parts. The item_name snapshot column stays — it freezes the
-- name at transaction time so historical entries remain readable even after
-- a part rename. The restrict_transaction_update_to_notes trigger is
-- recreated in Phase 3 against the new column name.

CREATE TABLE IF NOT EXISTS public.inventory_transactions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    part_id             uuid REFERENCES public.parts(id) ON DELETE SET NULL,
    item_name           text NOT NULL,
    type                text NOT NULL,
    quantity            numeric NOT NULL,
    unit                text NOT NULL,
    converted_quantity  numeric NOT NULL,
    job_id              uuid,  -- FK added after jobs is created below
    job_operation_id    uuid,  -- FK added after job_operations is created below
    operator_id         uuid,
    notes               text,
    created_at          timestamptz DEFAULT now(),
    created_by          uuid,
    has_discrepancy     boolean NOT NULL DEFAULT false,
    CONSTRAINT inventory_transactions_quantity_positive CHECK (quantity >= 0),
    CONSTRAINT inventory_transactions_type_check
        CHECK (type = ANY (ARRAY['addition'::text, 'depletion'::text, 'adjustment'::text]))
);

CREATE INDEX IF NOT EXISTS inventory_transactions_company_id_created_at_idx
    ON public.inventory_transactions (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_transactions_discrepancy_idx
    ON public.inventory_transactions (company_id, created_at DESC) WHERE has_discrepancy = true;
CREATE INDEX IF NOT EXISTS inventory_transactions_part_id_created_at_idx
    ON public.inventory_transactions (part_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_transactions_job_id_idx
    ON public.inventory_transactions (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_transactions_job_operation_id_idx
    ON public.inventory_transactions (job_operation_id) WHERE job_operation_id IS NOT NULL;

COMMENT ON TABLE  public.inventory_transactions IS 'Append-only ledger of inventory changes (addition / depletion / adjustment). Notes are the only mutable column post-insert (enforced by trigger).';
COMMENT ON COLUMN public.inventory_transactions.part_id IS 'FK to parts (set NULL on part delete to preserve history). Renamed from inventory_item_id when the item master was unified.';
COMMENT ON COLUMN public.inventory_transactions.item_name IS 'Snapshot of the part name at transaction time. Survives part renames so historical ledger entries stay readable.';

ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view inventory_transactions" ON public.inventory_transactions;
CREATE POLICY "Users can view inventory_transactions"
    ON public.inventory_transactions
    FOR SELECT
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can insert inventory_transactions" ON public.inventory_transactions;
CREATE POLICY "Users can insert inventory_transactions"
    ON public.inventory_transactions
    FOR INSERT
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can update inventory_transaction_notes" ON public.inventory_transactions;
CREATE POLICY "Users can update inventory_transaction_notes"
    ON public.inventory_transactions
    FOR UPDATE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.inventory_transactions;
CREATE POLICY "ai_readonly_select"
    ON public.inventory_transactions
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.6 work_centers (recreated, replaces operation_types)
-- ----------------------------------------------------------------------------
--
-- A work_center is a capacity bucket — either an internal machine/cell with
-- an hourly labor_rate, or an external vendor that performs an outside op.
-- The kind enum and the two CHECK constraints together enforce:
--   - kind='internal'  ⇒ vendor_id IS NULL
--   - kind='external'  ⇒ vendor_id IS NOT NULL
-- For external work centers, labor_rate is meaningless — cost lives on each
-- routing_operation as external_unit_price + external_setup_cost.

CREATE TABLE IF NOT EXISTS public.work_centers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name        text NOT NULL,
    kind        text NOT NULL DEFAULT 'internal',
    vendor_id   uuid REFERENCES public.vendors(id) ON DELETE RESTRICT,
    labor_rate  numeric(10,2),
    description text,
    metadata    jsonb DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT work_centers_unique_per_company UNIQUE (company_id, name),
    CONSTRAINT work_centers_kind_check
        CHECK (kind IN ('internal', 'external')),
    CONSTRAINT work_centers_external_requires_vendor
        CHECK (kind = 'internal' OR vendor_id IS NOT NULL),
    CONSTRAINT work_centers_internal_no_vendor
        CHECK (kind = 'external' OR vendor_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_work_centers_company       ON public.work_centers (company_id);
CREATE INDEX IF NOT EXISTS idx_work_centers_company_kind  ON public.work_centers (company_id, kind);
CREATE INDEX IF NOT EXISTS idx_work_centers_vendor
    ON public.work_centers (vendor_id) WHERE vendor_id IS NOT NULL;

DROP TRIGGER IF EXISTS work_centers_updated_at ON public.work_centers;
CREATE TRIGGER work_centers_updated_at
    BEFORE UPDATE ON public.work_centers
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE  public.work_centers IS 'Capacity bucket for routing operations. Replaces operation_types. Either an internal machine/cell (kind=internal, labor_rate set) or an external vendor (kind=external, vendor_id set).';
COMMENT ON COLUMN public.work_centers.kind IS 'internal = in-house machine/cell with an hourly labor_rate; external = outside-op partner identified by vendor_id (cost is per-routing_operation, not hourly).';
COMMENT ON COLUMN public.work_centers.vendor_id IS 'For kind=external only: the vendor performing the operation. Required when kind=external, must be NULL when kind=internal.';
COMMENT ON COLUMN public.work_centers.labor_rate IS 'Default hourly labor rate in dollars; used when kind=internal and no per-routing_operation override is set. Meaningless / typically NULL when kind=external.';

ALTER TABLE public.work_centers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "work_centers_select" ON public.work_centers;
CREATE POLICY "work_centers_select"
    ON public.work_centers
    FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "work_centers_insert" ON public.work_centers;
CREATE POLICY "work_centers_insert"
    ON public.work_centers
    FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                               FROM user_company_access
                               WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "work_centers_update" ON public.work_centers;
CREATE POLICY "work_centers_update"
    ON public.work_centers
    FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "work_centers_delete" ON public.work_centers;
CREATE POLICY "work_centers_delete"
    ON public.work_centers
    FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.work_centers;
CREATE POLICY "ai_readonly_select"
    ON public.work_centers
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.7 routings (recreated)
-- ----------------------------------------------------------------------------
--
-- Routing shape is unchanged from the prior migration: one routing per part
-- (UNIQUE on part_id), inline-edited on the part detail page. The change is
-- in the child table (routing_operations, formerly routing_nodes).

CREATE TABLE IF NOT EXISTS public.routings (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    part_id     uuid NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text,
    created_by  uuid REFERENCES auth.users(id),
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now(),
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT routings_part_id_unique UNIQUE (part_id)
);

CREATE INDEX IF NOT EXISTS idx_routings_company ON public.routings (company_id);
CREATE INDEX IF NOT EXISTS idx_routings_part    ON public.routings (part_id);

DROP TRIGGER IF EXISTS routings_updated_at ON public.routings;
CREATE TRIGGER routings_updated_at
    BEFORE UPDATE ON public.routings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.routings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view routings" ON public.routings;
CREATE POLICY "Users can view routings"
    ON public.routings
    FOR SELECT
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can insert routings" ON public.routings;
CREATE POLICY "Users can insert routings"
    ON public.routings
    FOR INSERT
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can update routings" ON public.routings;
CREATE POLICY "Users can update routings"
    ON public.routings
    FOR UPDATE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can delete routings" ON public.routings;
CREATE POLICY "Users can delete routings"
    ON public.routings
    FOR DELETE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.routings;
CREATE POLICY "ai_readonly_select"
    ON public.routings
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.8 routing_operations (recreated, replaces routing_nodes)
-- ----------------------------------------------------------------------------
--
-- Renamed from routing_nodes ("node" was vestigial DAG terminology). Now
-- carries a kind-aware cost field set:
--
--   kind='internal' (work_center.kind='internal'):
--     setup_minutes, cycle_minutes_per_unit, labor_rate_override
--     cost = (setup/qty + cycle) * COALESCE(override, work_center.labor_rate) / 60
--
--   kind='external' (work_center.kind='external'):
--     external_unit_price, external_setup_cost
--     cost = external_unit_price + external_setup_cost / qty
--
-- App-level validation enforces "right field set for the work_center kind"
-- (friendlier errors than a CHECK that joins to work_centers).
--
-- labor_rate_override is the dominant pattern in real shop data, not an edge
-- case (Contour: 98.6% of comparable rows override). UI defaults the field to
-- NULL but populates it from CSV when the source rate differs from the
-- work_center default.

CREATE TABLE IF NOT EXISTS public.routing_operations (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    routing_id              uuid NOT NULL REFERENCES public.routings(id) ON DELETE CASCADE,
    work_center_id          uuid NOT NULL REFERENCES public.work_centers(id) ON DELETE RESTRICT,
    sequence                integer NOT NULL DEFAULT 0,
    setup_minutes           numeric(8,2) DEFAULT 0,
    cycle_minutes_per_unit  numeric(8,4),
    labor_rate_override     numeric(10,2),
    external_unit_price     numeric(12,4),
    external_setup_cost     numeric(12,4),
    instructions            text,
    metadata                jsonb DEFAULT '{}'::jsonb,
    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now(),
    -- Plain unique (not DEFERRABLE). The save-routing reorder logic does a
    -- two-phase update (parks rows at sequence >= 100000 before final
    -- assignment), so it never has two rows at the same sequence in flight.
    -- DEFERRABLE here would queue per-row check events that prevent later
    -- ALTER TABLE statements in the same transaction (Postgres error 55006).
    CONSTRAINT routing_operations_routing_sequence_unique UNIQUE (routing_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_routing_operations_routing
    ON public.routing_operations (routing_id, sequence);
CREATE INDEX IF NOT EXISTS idx_routing_operations_work_center
    ON public.routing_operations (work_center_id);

DROP TRIGGER IF EXISTS routing_operations_updated_at ON public.routing_operations;
CREATE TRIGGER routing_operations_updated_at
    BEFORE UPDATE ON public.routing_operations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE  public.routing_operations IS 'Linear list of operations within a routing. Renamed from routing_nodes. Each row points at a work_center; cost field set varies by work_center.kind (internal vs external).';
COMMENT ON COLUMN public.routing_operations.sequence IS 'Linear order within the routing. Lower values execute first. Steps of 10 (10, 20, 30...) leave room for inserts.';
COMMENT ON COLUMN public.routing_operations.setup_minutes IS 'One-time per-job setup time, in minutes. Amortized across batch in cost rollups (setup_minutes / qty).';
COMMENT ON COLUMN public.routing_operations.cycle_minutes_per_unit IS 'Per-unit run time, in minutes. Used for kind=internal cost calculation only.';
COMMENT ON COLUMN public.routing_operations.labor_rate_override IS 'Per-step override of the work_center labor_rate, in dollars per hour. Dominant pattern in real shop data (98.6% of comparable Contour rows override). NULL = inherit work_center.labor_rate. Used for kind=internal only.';
COMMENT ON COLUMN public.routing_operations.external_unit_price IS 'For kind=external only: cost per output unit charged by the vendor.';
COMMENT ON COLUMN public.routing_operations.external_setup_cost IS 'For kind=external only: one-time per-job setup charge from the vendor; amortizes across batch.';

ALTER TABLE public.routing_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view routing_operations" ON public.routing_operations;
CREATE POLICY "Users can view routing_operations"
    ON public.routing_operations
    FOR SELECT
    USING (routing_id IN (SELECT routings.id FROM routings
                          WHERE routings.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can insert routing_operations" ON public.routing_operations;
CREATE POLICY "Users can insert routing_operations"
    ON public.routing_operations
    FOR INSERT
    WITH CHECK (routing_id IN (SELECT routings.id FROM routings
                               WHERE routings.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can update routing_operations" ON public.routing_operations;
CREATE POLICY "Users can update routing_operations"
    ON public.routing_operations
    FOR UPDATE
    USING (routing_id IN (SELECT routings.id FROM routings
                          WHERE routings.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can delete routing_operations" ON public.routing_operations;
CREATE POLICY "Users can delete routing_operations"
    ON public.routing_operations
    FOR DELETE
    USING (routing_id IN (SELECT routings.id FROM routings
                          WHERE routings.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.routing_operations;
CREATE POLICY "ai_readonly_select"
    ON public.routing_operations
    FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (SELECT 1 FROM routings
                   WHERE routings.id = routing_operations.routing_id
                     AND routings.company_id = (current_setting('jigged.company_id', true))::uuid));

-- ----------------------------------------------------------------------------
-- 2.9 quotes (recreated, faithful to prior shape)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.quotes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    quote_number        text NOT NULL,
    customer_id         uuid REFERENCES public.customers(id) ON DELETE SET NULL,
    status              text NOT NULL DEFAULT 'active',
    status_changed_at   timestamptz,
    converted_at        timestamptz,
    created_by          uuid REFERENCES auth.users(id),
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now(),
    lead_time_days      integer,
    expiration_date     date,
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT quotes_company_id_quote_number_key UNIQUE (company_id, quote_number),
    CONSTRAINT quotes_status_check
        CHECK (status = ANY (ARRAY['active'::text, 'expired'::text]))
);

CREATE INDEX IF NOT EXISTS idx_quotes_company  ON public.quotes (company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_customer ON public.quotes (customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_number   ON public.quotes (quote_number);
CREATE INDEX IF NOT EXISTS idx_quotes_status   ON public.quotes (company_id, status);

DROP TRIGGER IF EXISTS quotes_updated_at ON public.quotes;
CREATE TRIGGER quotes_updated_at
    BEFORE UPDATE ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_quote_status_change ON public.quotes;
CREATE TRIGGER trigger_quote_status_change
    BEFORE UPDATE ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION public.track_quote_status_change();

DROP TRIGGER IF EXISTS trigger_set_quote_number ON public.quotes;
CREATE TRIGGER trigger_set_quote_number
    BEFORE INSERT ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION public.set_quote_number();

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view quotes" ON public.quotes;
CREATE POLICY "Users can view quotes"
    ON public.quotes FOR SELECT
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can insert quotes" ON public.quotes;
CREATE POLICY "Users can insert quotes"
    ON public.quotes FOR INSERT
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can update quotes" ON public.quotes;
CREATE POLICY "Users can update quotes"
    ON public.quotes FOR UPDATE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can delete quotes" ON public.quotes;
CREATE POLICY "Users can delete quotes"
    ON public.quotes FOR DELETE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.quotes;
CREATE POLICY "ai_readonly_select"
    ON public.quotes FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.10 part_pricing_tiers (recreated, faithful to prior shape)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.part_pricing_tiers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    part_id             uuid NOT NULL REFERENCES public.parts(id) ON DELETE CASCADE,
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    sequence            integer NOT NULL,
    quantity            integer NOT NULL,
    base_cost_per_unit  numeric(12,4),
    markup_percent      numeric(5,2),
    unit_price          numeric(12,4),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT part_pricing_tiers_unique_seq UNIQUE (part_id, sequence),
    CONSTRAINT part_pricing_tiers_quantity_check CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_company ON public.part_pricing_tiers (company_id);
CREATE INDEX IF NOT EXISTS idx_part_pricing_tiers_part    ON public.part_pricing_tiers (part_id, sequence);

DROP TRIGGER IF EXISTS part_pricing_tiers_updated_at ON public.part_pricing_tiers;
CREATE TRIGGER part_pricing_tiers_updated_at
    BEFORE UPDATE ON public.part_pricing_tiers
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.part_pricing_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "part_pricing_tiers_select" ON public.part_pricing_tiers;
CREATE POLICY "part_pricing_tiers_select"
    ON public.part_pricing_tiers FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "part_pricing_tiers_insert" ON public.part_pricing_tiers;
CREATE POLICY "part_pricing_tiers_insert"
    ON public.part_pricing_tiers FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                               FROM user_company_access
                               WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "part_pricing_tiers_update" ON public.part_pricing_tiers;
CREATE POLICY "part_pricing_tiers_update"
    ON public.part_pricing_tiers FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "part_pricing_tiers_delete" ON public.part_pricing_tiers;
CREATE POLICY "part_pricing_tiers_delete"
    ON public.part_pricing_tiers FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.part_pricing_tiers;
CREATE POLICY "ai_readonly_select"
    ON public.part_pricing_tiers FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.11 quote_line_items (recreated, faithful to prior shape)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.quote_line_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id            uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    part_id             uuid NOT NULL REFERENCES public.parts(id),
    source_tier_id      uuid REFERENCES public.part_pricing_tiers(id) ON DELETE SET NULL,
    sequence            integer NOT NULL,
    quantity            integer NOT NULL,
    unit_price          numeric(12,4) NOT NULL,
    total_price         numeric(12,4),
    markup_percent      numeric(5,2),
    base_cost_per_unit  numeric(12,4),
    created_at          timestamptz NOT NULL DEFAULT now(),
    is_quote_override   boolean NOT NULL DEFAULT false,
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT quote_line_items_unique_seq UNIQUE (quote_id, sequence),
    CONSTRAINT quote_line_items_quantity_check CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_quote_line_items_company ON public.quote_line_items (company_id);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_part    ON public.quote_line_items (part_id);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_quote   ON public.quote_line_items (quote_id, sequence);

ALTER TABLE public.quote_line_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_line_items_select" ON public.quote_line_items;
CREATE POLICY "quote_line_items_select"
    ON public.quote_line_items FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_line_items_insert" ON public.quote_line_items;
CREATE POLICY "quote_line_items_insert"
    ON public.quote_line_items FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                               FROM user_company_access
                               WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_line_items_update" ON public.quote_line_items;
CREATE POLICY "quote_line_items_update"
    ON public.quote_line_items FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_line_items_delete" ON public.quote_line_items;
CREATE POLICY "quote_line_items_delete"
    ON public.quote_line_items FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.quote_line_items;
CREATE POLICY "ai_readonly_select"
    ON public.quote_line_items FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.12 quote_materials (recreated; FK rename: inventory_item_id → material_part_id)
-- ----------------------------------------------------------------------------
--
-- Same shape as before, but the optional FK from quote_materials to the item
-- master is renamed to material_part_id and now points at parts (not the
-- dropped inventory_items). item_name continues to live on the row as a
-- snapshot to survive part renames after the quote is sent.

CREATE TABLE IF NOT EXISTS public.quote_materials (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id            uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    sequence            integer NOT NULL,
    material_part_id    uuid REFERENCES public.parts(id) ON DELETE SET NULL,
    item_name           text NOT NULL,
    quantity            numeric NOT NULL,
    unit                text,
    cost_per_unit       numeric,
    line_cost           numeric,
    created_at          timestamptz NOT NULL DEFAULT now(),
    part_id             uuid NOT NULL REFERENCES public.parts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_quote_materials_company    ON public.quote_materials (company_id);
CREATE INDEX IF NOT EXISTS idx_quote_materials_quote      ON public.quote_materials (quote_id, sequence);
CREATE INDEX IF NOT EXISTS idx_quote_materials_quote_part ON public.quote_materials (quote_id, part_id);

COMMENT ON COLUMN public.quote_materials.material_part_id IS 'FK to the consumed material in the unified parts table (renamed from inventory_item_id when the item master was unified). Optional — supports ad-hoc materials not yet in the catalog.';
COMMENT ON COLUMN public.quote_materials.part_id IS 'The manufactured part this material consumption belongs to (the line-item part on the quote).';
COMMENT ON COLUMN public.quote_materials.item_name IS 'Snapshot of the material name at quote-creation time. Survives part renames so historical quotes stay readable.';

ALTER TABLE public.quote_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_materials_select" ON public.quote_materials;
CREATE POLICY "quote_materials_select"
    ON public.quote_materials FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_materials_insert" ON public.quote_materials;
CREATE POLICY "quote_materials_insert"
    ON public.quote_materials FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                               FROM user_company_access
                               WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_materials_update" ON public.quote_materials;
CREATE POLICY "quote_materials_update"
    ON public.quote_materials FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_materials_delete" ON public.quote_materials;
CREATE POLICY "quote_materials_delete"
    ON public.quote_materials FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.quote_materials;
CREATE POLICY "ai_readonly_select"
    ON public.quote_materials FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.13 quote_operations (recreated, faithful to prior shape)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.quote_operations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id            uuid NOT NULL REFERENCES public.quotes(id) ON DELETE CASCADE,
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    sequence            integer NOT NULL,
    operation_name      text NOT NULL,
    run_time_minutes    numeric,
    setup_time_minutes  numeric,
    labor_rate          numeric,
    run_cost            numeric,
    setup_cost          numeric,
    created_at          timestamptz NOT NULL DEFAULT now(),
    part_id             uuid NOT NULL REFERENCES public.parts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_quote_operations_company    ON public.quote_operations (company_id);
CREATE INDEX IF NOT EXISTS idx_quote_operations_quote      ON public.quote_operations (quote_id, sequence);
CREATE INDEX IF NOT EXISTS idx_quote_operations_quote_part ON public.quote_operations (quote_id, part_id);

ALTER TABLE public.quote_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_operations_select" ON public.quote_operations;
CREATE POLICY "quote_operations_select"
    ON public.quote_operations FOR SELECT
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_operations_insert" ON public.quote_operations;
CREATE POLICY "quote_operations_insert"
    ON public.quote_operations FOR INSERT
    WITH CHECK (company_id IN (SELECT user_company_access.company_id
                               FROM user_company_access
                               WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_operations_update" ON public.quote_operations;
CREATE POLICY "quote_operations_update"
    ON public.quote_operations FOR UPDATE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "quote_operations_delete" ON public.quote_operations;
CREATE POLICY "quote_operations_delete"
    ON public.quote_operations FOR DELETE
    USING (company_id IN (SELECT user_company_access.company_id
                          FROM user_company_access
                          WHERE user_company_access.user_id = auth.uid()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.quote_operations;
CREATE POLICY "ai_readonly_select"
    ON public.quote_operations FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.14 jobs (recreated, faithful to prior shape)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.jobs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    job_number          text NOT NULL,
    quote_id            uuid REFERENCES public.quotes(id) ON DELETE SET NULL,
    customer_id         uuid REFERENCES public.customers(id) ON DELETE SET NULL,
    status              text NOT NULL DEFAULT 'not_started',
    status_changed_at   timestamptz,
    started_at          timestamptz,
    completed_at        timestamptz,
    shipped_at          timestamptz,
    created_by          uuid REFERENCES auth.users(id),
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now(),
    due_date            date,
    lead_time_days      integer,
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT jobs_company_id_job_number_key UNIQUE (company_id, job_number),
    CONSTRAINT jobs_status_check
        CHECK (status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'shipped'::text, 'cancelled'::text]))
);

CREATE INDEX IF NOT EXISTS idx_jobs_company  ON public.jobs (company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON public.jobs (customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_quote    ON public.jobs (quote_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON public.jobs (company_id, status);

DROP TRIGGER IF EXISTS jobs_updated_at ON public.jobs;
CREATE TRIGGER jobs_updated_at
    BEFORE UPDATE ON public.jobs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_job_status_change ON public.jobs;
CREATE TRIGGER trigger_job_status_change
    BEFORE UPDATE ON public.jobs
    FOR EACH ROW EXECUTE FUNCTION public.track_job_status_change();

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view jobs" ON public.jobs;
CREATE POLICY "Users can view jobs"
    ON public.jobs FOR SELECT
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can insert jobs" ON public.jobs;
CREATE POLICY "Users can insert jobs"
    ON public.jobs FOR INSERT
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can update jobs" ON public.jobs;
CREATE POLICY "Users can update jobs"
    ON public.jobs FOR UPDATE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "Users can delete jobs" ON public.jobs;
CREATE POLICY "Users can delete jobs"
    ON public.jobs FOR DELETE
    USING (company_id IN (SELECT public.get_user_company_ids()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.jobs;
CREATE POLICY "ai_readonly_select"
    ON public.jobs FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ----------------------------------------------------------------------------
-- 2.15 job_parts (recreated, faithful to prior shape)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.job_parts (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id                      uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    company_id                  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    part_id                     uuid NOT NULL REFERENCES public.parts(id),
    source_quote_line_item_id   uuid REFERENCES public.quote_line_items(id) ON DELETE SET NULL,
    sequence                    integer NOT NULL,
    quantity                    integer NOT NULL,
    status                      text NOT NULL DEFAULT 'not_started',
    status_changed_at           timestamptz,
    started_at                  timestamptz,
    completed_at                timestamptz,
    shipped_at                  timestamptz,
    current_operation_sequence  integer,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT job_parts_job_part_unique     UNIQUE (job_id, part_id),
    CONSTRAINT job_parts_job_sequence_unique UNIQUE (job_id, sequence),
    CONSTRAINT job_parts_quantity_check      CHECK (quantity > 0),
    CONSTRAINT job_parts_status_check
        CHECK (status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'shipped'::text, 'cancelled'::text]))
);

CREATE INDEX IF NOT EXISTS idx_job_parts_job_id     ON public.job_parts (job_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_company_id ON public.job_parts (company_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_part_id    ON public.job_parts (part_id);
CREATE INDEX IF NOT EXISTS idx_job_parts_status     ON public.job_parts (status);

DROP TRIGGER IF EXISTS job_parts_updated_at ON public.job_parts;
CREATE TRIGGER job_parts_updated_at
    BEFORE UPDATE ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.job_parts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view job_parts" ON public.job_parts;
CREATE POLICY "Users can view job_parts"
    ON public.job_parts FOR SELECT
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can insert job_parts" ON public.job_parts;
CREATE POLICY "Users can insert job_parts"
    ON public.job_parts FOR INSERT
    WITH CHECK (job_id IN (SELECT jobs.id FROM jobs
                           WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can update job_parts" ON public.job_parts;
CREATE POLICY "Users can update job_parts"
    ON public.job_parts FOR UPDATE
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can delete job_parts" ON public.job_parts;
CREATE POLICY "Users can delete job_parts"
    ON public.job_parts FOR DELETE
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.job_parts;
CREATE POLICY "ai_readonly_select"
    ON public.job_parts FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (SELECT 1 FROM jobs
                   WHERE jobs.id = job_parts.job_id
                     AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid));

-- ----------------------------------------------------------------------------
-- 2.16 job_operations (recreated; FK renames operation_type → work_center,
--                     routing_node → routing_operation)
-- ----------------------------------------------------------------------------
--
-- Faithful to the prior shape except:
--   - operation_type_id → work_center_id (FK target renamed)
--   - routing_node_id   → routing_operation_id (FK target renamed)
-- The denormalized operation_name snapshot stays — immune to mid-job
-- work-center renames. The actual_setup_minutes / actual_run_minutes /
-- estimated_* fields keep the same names (PR 3 may add external_unit_price /
-- external_setup_cost snapshots; the plan calls them out as future work but
-- doesn't ship the columns in this migration).

CREATE TABLE IF NOT EXISTS public.job_operations (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id                          uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    job_part_id                     uuid NOT NULL REFERENCES public.job_parts(id) ON DELETE CASCADE,
    sequence                        integer NOT NULL,
    operation_name                  text NOT NULL,
    work_center_id                  uuid REFERENCES public.work_centers(id) ON DELETE SET NULL,
    estimated_setup_minutes         numeric(8,2) DEFAULT 0,
    estimated_run_minutes_per_unit  numeric(8,4) DEFAULT 0,
    actual_setup_minutes            numeric(8,2),
    actual_run_minutes              numeric(8,2),
    status                          text NOT NULL DEFAULT 'pending',
    started_at                      timestamptz,
    completed_at                    timestamptz,
    assigned_to                     uuid REFERENCES auth.users(id),
    completed_by                    uuid REFERENCES auth.users(id),
    instructions                    text,
    notes                           text,
    created_at                      timestamptz DEFAULT now(),
    updated_at                      timestamptz DEFAULT now(),
    routing_operation_id            uuid REFERENCES public.routing_operations(id) ON DELETE SET NULL,
    -- Plain unique (not DEFERRABLE) — see note on vendors_unique_per_company.
    CONSTRAINT job_operations_job_part_sequence_key UNIQUE (job_part_id, sequence),
    CONSTRAINT job_operations_status_check
        CHECK (status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'completed'::text, 'skipped'::text]))
);

CREATE INDEX IF NOT EXISTS idx_job_ops_job              ON public.job_operations (job_id);
CREATE INDEX IF NOT EXISTS idx_job_operations_job_part_id ON public.job_operations (job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_work_center      ON public.job_operations (work_center_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_routing_operation
    ON public.job_operations (routing_operation_id) WHERE routing_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_ops_status           ON public.job_operations (status);
CREATE INDEX IF NOT EXISTS idx_job_ops_assigned
    ON public.job_operations (assigned_to) WHERE assigned_to IS NOT NULL;

DROP TRIGGER IF EXISTS job_operations_updated_at ON public.job_operations;
CREATE TRIGGER job_operations_updated_at
    BEFORE UPDATE ON public.job_operations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON COLUMN public.job_operations.work_center_id IS 'FK to the work_center this op runs at (renamed from operation_type_id when operation_types was replaced by work_centers).';
COMMENT ON COLUMN public.job_operations.routing_operation_id IS 'FK to the routing_operation this row was snapshotted from at job creation (renamed from routing_node_id).';
COMMENT ON COLUMN public.job_operations.operation_name IS 'Snapshot of the work_center name at job-creation time. Immune to mid-job renames.';

ALTER TABLE public.job_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view job_operations" ON public.job_operations;
CREATE POLICY "Users can view job_operations"
    ON public.job_operations FOR SELECT
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can insert job_operations" ON public.job_operations;
CREATE POLICY "Users can insert job_operations"
    ON public.job_operations FOR INSERT
    WITH CHECK (job_id IN (SELECT jobs.id FROM jobs
                           WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can update job_operations" ON public.job_operations;
CREATE POLICY "Users can update job_operations"
    ON public.job_operations FOR UPDATE
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can delete job_operations" ON public.job_operations;
CREATE POLICY "Users can delete job_operations"
    ON public.job_operations FOR DELETE
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.job_operations;
CREATE POLICY "ai_readonly_select"
    ON public.job_operations FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (SELECT 1 FROM jobs
                   WHERE jobs.id = job_operations.job_id
                     AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid));

-- ----------------------------------------------------------------------------
-- 2.17 job_materials (recreated; FK renames inventory_item → material_part,
--                    routing_material → parts_bom)
-- ----------------------------------------------------------------------------
--
-- Faithful to the prior shape except:
--   - inventory_item_id  → material_part_id (FK target renamed)
--   - routing_material_id → parts_bom_id (now references parts_bom; the row
--     that this job_material was snapshotted from at job-start)

CREATE TABLE IF NOT EXISTS public.job_materials (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id              uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    job_part_id         uuid NOT NULL REFERENCES public.job_parts(id) ON DELETE CASCADE,
    parts_bom_id        uuid REFERENCES public.parts_bom(id) ON DELETE SET NULL,
    material_part_id    uuid NOT NULL REFERENCES public.parts(id) ON DELETE RESTRICT,
    expected_quantity   numeric NOT NULL DEFAULT 0,
    actual_quantity     numeric,
    unit                text NOT NULL,
    status              text NOT NULL DEFAULT 'pending',
    consumed_at         timestamptz,
    consumed_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_materials_actual_quantity_check
        CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
    CONSTRAINT job_materials_expected_quantity_check
        CHECK (expected_quantity >= 0),
    CONSTRAINT job_materials_status_check
        CHECK (status = ANY (ARRAY['pending'::text, 'consumed'::text, 'skipped'::text]))
);

CREATE INDEX IF NOT EXISTS idx_job_materials_job          ON public.job_materials (job_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_job_part_id  ON public.job_materials (job_part_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_material_part ON public.job_materials (material_part_id);
CREATE INDEX IF NOT EXISTS idx_job_materials_parts_bom     ON public.job_materials (parts_bom_id);

DROP TRIGGER IF EXISTS job_materials_updated_at ON public.job_materials;
CREATE TRIGGER job_materials_updated_at
    BEFORE UPDATE ON public.job_materials
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON COLUMN public.job_materials.material_part_id IS 'FK to the consumed material in the unified parts table (renamed from inventory_item_id when the item master was unified).';
COMMENT ON COLUMN public.job_materials.parts_bom_id IS 'Source parts_bom row this job_material was snapshotted from at job-start (renamed from routing_material_id; BOM is now part-attached, not routing-attached).';
COMMENT ON COLUMN public.job_materials.expected_quantity IS 'Quantity expected to be consumed (snapshot from parts_bom.quantity at job-creation time, in `unit`).';
COMMENT ON COLUMN public.job_materials.actual_quantity IS 'Quantity actually consumed, recorded by the operator on completion. NULL until consumed.';

ALTER TABLE public.job_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view job_materials" ON public.job_materials;
CREATE POLICY "Users can view job_materials"
    ON public.job_materials FOR SELECT
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can insert job_materials" ON public.job_materials;
CREATE POLICY "Users can insert job_materials"
    ON public.job_materials FOR INSERT
    WITH CHECK (job_id IN (SELECT jobs.id FROM jobs
                           WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can update job_materials" ON public.job_materials;
CREATE POLICY "Users can update job_materials"
    ON public.job_materials FOR UPDATE
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "Users can delete job_materials" ON public.job_materials;
CREATE POLICY "Users can delete job_materials"
    ON public.job_materials FOR DELETE
    USING (job_id IN (SELECT jobs.id FROM jobs
                      WHERE jobs.company_id IN (SELECT public.get_user_company_ids())));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.job_materials;
CREATE POLICY "ai_readonly_select"
    ON public.job_materials FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (SELECT 1 FROM jobs
                   WHERE jobs.id = job_materials.job_id
                     AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid));

-- ----------------------------------------------------------------------------
-- 2.18 inventory_transactions: add deferred FKs to jobs and job_operations
-- ----------------------------------------------------------------------------
-- We declared inventory_transactions before jobs / job_operations existed in
-- the new schema (so its restrict_transaction_update_to_notes trigger could
-- be wired up close to the table). Now that jobs and job_operations exist,
-- add the FKs.

ALTER TABLE public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;

ALTER TABLE public.inventory_transactions
    ADD CONSTRAINT inventory_transactions_job_operation_id_fkey
    FOREIGN KEY (job_operation_id) REFERENCES public.job_operations(id) ON DELETE SET NULL;

-- ============================================================================
-- Phase 3: Functions and triggers
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 3.1 restrict_transaction_update_to_notes — locks down inventory ledger
-- ----------------------------------------------------------------------------
-- Recreated against the renamed column (part_id, was inventory_item_id).
-- Same semantics as before: only `notes` is mutable post-insert.

CREATE OR REPLACE FUNCTION public.restrict_transaction_update_to_notes()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD.company_id          IS DISTINCT FROM NEW.company_id
       OR OLD.part_id          IS DISTINCT FROM NEW.part_id
       OR OLD.item_name        IS DISTINCT FROM NEW.item_name
       OR OLD.type             IS DISTINCT FROM NEW.type
       OR OLD.quantity         IS DISTINCT FROM NEW.quantity
       OR OLD.unit             IS DISTINCT FROM NEW.unit
       OR OLD.converted_quantity IS DISTINCT FROM NEW.converted_quantity
       OR OLD.job_id           IS DISTINCT FROM NEW.job_id
       OR OLD.job_operation_id IS DISTINCT FROM NEW.job_operation_id
       OR OLD.operator_id      IS DISTINCT FROM NEW.operator_id
       OR OLD.created_at       IS DISTINCT FROM NEW.created_at
       OR OLD.created_by       IS DISTINCT FROM NEW.created_by
       OR OLD.has_discrepancy  IS DISTINCT FROM NEW.has_discrepancy
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_transaction_notes_only_update ON public.inventory_transactions;
CREATE TRIGGER enforce_transaction_notes_only_update
    BEFORE UPDATE ON public.inventory_transactions
    FOR EACH ROW EXECUTE FUNCTION public.restrict_transaction_update_to_notes();

-- ----------------------------------------------------------------------------
-- 3.2 compute_job_status — derives jobs.status from its child job_parts
-- ----------------------------------------------------------------------------
-- Verbatim from the prior schema (operates on job_parts, no schema change).

CREATE OR REPLACE FUNCTION public.compute_job_status(p_job_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    v_total int;
    v_cancelled int;
    v_shipped int;
    v_completed int;
    v_in_progress int;
BEGIN
    SELECT
      count(*),
      count(*) FILTER (WHERE status = 'cancelled'),
      count(*) FILTER (WHERE status = 'shipped'),
      count(*) FILTER (WHERE status = 'completed'),
      count(*) FILTER (WHERE status = 'in_progress')
    INTO v_total, v_cancelled, v_shipped, v_completed, v_in_progress
    FROM job_parts
    WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'not_started'; END IF;
    IF v_cancelled = v_total THEN RETURN 'cancelled'; END IF;
    IF v_shipped = v_total THEN RETURN 'shipped'; END IF;
    IF v_completed + v_shipped = v_total THEN RETURN 'completed'; END IF;
    IF v_in_progress > 0 OR v_completed > 0 OR v_shipped > 0 THEN RETURN 'in_progress'; END IF;
    RETURN 'not_started';
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3.3 sync_job_status_from_parts — keeps jobs.* in sync with child rollup
-- ----------------------------------------------------------------------------
-- Verbatim from the prior schema.

CREATE OR REPLACE FUNCTION public.sync_job_status_from_parts()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_job_id uuid;
    v_new_status text;
    v_now timestamptz := now();
BEGIN
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new_status := compute_job_status(v_job_id);

    UPDATE jobs
    SET status = v_new_status,
        status_changed_at = CASE WHEN status IS DISTINCT FROM v_new_status THEN v_now ELSE status_changed_at END,
        started_at = CASE
            WHEN started_at IS NULL AND v_new_status IN ('in_progress','completed','shipped')
              THEN v_now ELSE started_at END,
        completed_at = CASE
            WHEN v_new_status IN ('completed','shipped') AND completed_at IS NULL THEN v_now
            WHEN v_new_status = 'in_progress' THEN NULL
            ELSE completed_at END,
        shipped_at = CASE
            WHEN v_new_status = 'shipped' AND shipped_at IS NULL THEN v_now
            WHEN v_new_status <> 'shipped' THEN NULL
            ELSE shipped_at END,
        updated_at = v_now
    WHERE id = v_job_id;

    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_del ON public.job_parts;
CREATE TRIGGER trigger_sync_job_status_from_parts_del
    AFTER DELETE ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION public.sync_job_status_from_parts();

DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_ins ON public.job_parts;
CREATE TRIGGER trigger_sync_job_status_from_parts_ins
    AFTER INSERT ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION public.sync_job_status_from_parts();

DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_upd ON public.job_parts;
CREATE TRIGGER trigger_sync_job_status_from_parts_upd
    AFTER UPDATE OF status ON public.job_parts
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION public.sync_job_status_from_parts();

-- ----------------------------------------------------------------------------
-- 3.4 create_job_part_operations_from_routing — rewritten for new schema
-- ----------------------------------------------------------------------------
-- Reads from routing_operations + work_centers (was: routing_nodes +
-- operation_types). Inserts into job_operations with work_center_id and
-- routing_operation_id, snapshotting setup_minutes / cycle_minutes_per_unit
-- onto the existing estimated_setup_minutes / estimated_run_minutes_per_unit
-- columns. Snapshots BOM rows from parts_bom WHERE parent_part_id =
-- (routing's part_id) into job_materials, with the parts_bom_id linkage.
-- Idempotent: NOT EXISTS guard on routing_operation_id / parts_bom_id.

CREATE OR REPLACE FUNCTION public.create_job_part_operations_from_routing(p_job_part_id uuid, p_routing_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
    v_count integer := 0;
    v_op record;
    v_seq integer := 10;
    v_job_id uuid;
    v_part_id uuid;
    v_min_seq integer;
BEGIN
    SELECT job_id INTO v_job_id FROM job_parts WHERE id = p_job_part_id;
    IF v_job_id IS NULL THEN
        RAISE EXCEPTION 'job_part % not found', p_job_part_id;
    END IF;

    -- The routing's part_id is the parent for any BOM snapshot below.
    SELECT part_id INTO v_part_id FROM routings WHERE id = p_routing_id;
    IF v_part_id IS NULL THEN
        RAISE EXCEPTION 'routing % not found', p_routing_id;
    END IF;

    -- Snapshot routing_operations → job_operations.
    FOR v_op IN
        SELECT ro.*, wc.name AS operation_name
        FROM routing_operations ro
        JOIN work_centers wc ON ro.work_center_id = wc.id
        WHERE ro.routing_id = p_routing_id
          AND NOT EXISTS (
              SELECT 1 FROM job_operations jo
              WHERE jo.job_part_id = p_job_part_id
                AND jo.routing_operation_id = ro.id
          )
        ORDER BY ro.sequence, ro.created_at
    LOOP
        INSERT INTO job_operations (
            job_id, job_part_id, sequence, operation_name, work_center_id,
            instructions, estimated_setup_minutes, estimated_run_minutes_per_unit,
            status, routing_operation_id
        ) VALUES (
            v_job_id, p_job_part_id, v_seq, v_op.operation_name, v_op.work_center_id,
            v_op.instructions, COALESCE(v_op.setup_minutes, 0), v_op.cycle_minutes_per_unit,
            'pending', v_op.id
        );
        v_seq := v_seq + 10;
        v_count := v_count + 1;
    END LOOP;

    -- Snapshot parts_bom (the part's BOM) → job_materials. Idempotent on
    -- parts_bom_id. The BOM is now part-attached, not routing-attached, so
    -- we read parts_bom WHERE parent_part_id = the routing's part.
    INSERT INTO job_materials (job_id, job_part_id, parts_bom_id, material_part_id, expected_quantity, unit)
    SELECT v_job_id, p_job_part_id, b.id, b.child_part_id, b.quantity, b.unit
    FROM parts_bom b
    WHERE b.parent_part_id = v_part_id
      AND NOT EXISTS (
          SELECT 1 FROM job_materials jm
          WHERE jm.job_part_id = p_job_part_id
            AND jm.parts_bom_id = b.id
      );

    -- Set the job_part's current operation cursor to the lowest sequence we wrote.
    SELECT MIN(sequence) INTO v_min_seq FROM job_operations WHERE job_part_id = p_job_part_id;
    IF v_min_seq IS NOT NULL THEN
        UPDATE job_parts SET current_operation_sequence = v_min_seq WHERE id = p_job_part_id;
    END IF;

    RETURN v_count;
END;
$function$;

COMMENT ON FUNCTION public.create_job_part_operations_from_routing(uuid, uuid)
    IS 'Snapshots a routing onto a job_part: routing_operations → job_operations (with work_center_id and routing_operation_id) and parts_bom (where parent_part = routing.part) → job_materials (with parts_bom_id). Idempotent on the snapshot keys. Sets job_parts.current_operation_sequence to the lowest seq written.';

-- ----------------------------------------------------------------------------
-- 3.5 enforce_no_bom_cycles — trigger on parts_bom (BEFORE INSERT/UPDATE)
-- ----------------------------------------------------------------------------
-- Walks the descendants of the proposed child_part_id; if parent_part_id
-- appears in that walk, the new edge would close a cycle. Depth bound 50.
--
-- The unique constraint blocks duplicate edges (A→B twice) and the
-- no-self-reference CHECK blocks A→A, but neither catches A→B + B→A
-- (two distinct rows that both pass both checks but form a 2-cycle). Without
-- this trigger, a 2-cycle would silently corrupt cost rollups.
--
-- The application layer (utils/bomAccess.ts) does the same walk first to
-- give a friendlier error. This trigger is defense-in-depth — it can't be
-- bypassed by direct DB writes, bulk imports that skip the access layer, or
-- future code paths.

CREATE OR REPLACE FUNCTION public.enforce_no_bom_cycles()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_cycle_found boolean;
BEGIN
    WITH RECURSIVE descendants(part_id, depth) AS (
        SELECT NEW.child_part_id, 1
        UNION ALL
        SELECT b.child_part_id, d.depth + 1
        FROM parts_bom b
        JOIN descendants d ON b.parent_part_id = d.part_id
        WHERE d.depth < 50
    )
    SELECT EXISTS (SELECT 1 FROM descendants WHERE part_id = NEW.parent_part_id)
    INTO v_cycle_found;

    IF v_cycle_found THEN
        RAISE EXCEPTION 'Adding BOM edge %→% would create a cycle',
            NEW.parent_part_id, NEW.child_part_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS parts_bom_no_cycles ON public.parts_bom;
CREATE TRIGGER parts_bom_no_cycles
    BEFORE INSERT OR UPDATE OF parent_part_id, child_part_id ON public.parts_bom
    FOR EACH ROW EXECUTE FUNCTION public.enforce_no_bom_cycles();

-- ----------------------------------------------------------------------------
-- 3.6 recalculate_part_cost — single-level rollup, user-triggered
-- ----------------------------------------------------------------------------
-- Sums (per-internal-op labor) + (per-external-op flat cost) + (per-BOM-child
-- cost × qty). Single-level only: each child's contribution uses that child's
-- current parts.cost_per_unit (no recursion). The stale-cost badge in the UI
-- surfaces when a descendant has changed since the last recalc; the user
-- recalcs bottom-up.
--
-- Cost contract (also documented in the plan and in the routing_operations
-- column comments above):
--
--   Internal op (work_center.kind='internal'):
--     cost = (setup_minutes / 1 + cycle_minutes_per_unit)
--            * COALESCE(labor_rate_override, work_center.labor_rate) / 60
--     The standalone recalc uses qty=1 (UI text: "at qty=1; setup cost
--     amortizes across batch in quotes/jobs.").
--
--   External op (work_center.kind='external'):
--     cost = external_unit_price + (external_setup_cost / 1)
--
--   BOM child:
--     cost = child.cost_per_unit * parts_bom.quantity
--     If parts_bom.unit differs from child.primary_unit, convert via
--     parts_unit_conversions (qty_in_bom_unit * to_primary_factor).
--     If no conversion exists for that pair, RAISE EXCEPTION.
--
-- Updates parts.cost_per_unit and parts.cost_recalculated_at = now(); returns
-- the new cost. Only operates on is_manufacturable parts; for non-
-- manufacturable parts, returns the existing cost_per_unit unchanged.

CREATE OR REPLACE FUNCTION public.recalculate_part_cost(p_part_id uuid)
RETURNS numeric
LANGUAGE plpgsql
AS $function$
DECLARE
    v_is_manufacturable boolean;
    v_routing_id uuid;
    v_total_cost numeric := 0;
    v_op record;
    v_op_cost numeric;
    v_bom record;
    v_child_primary_unit text;
    v_child_cost_per_primary_unit numeric;
    v_to_primary_factor numeric;
    v_qty_in_primary_unit numeric;
BEGIN
    SELECT is_manufacturable INTO v_is_manufacturable FROM parts WHERE id = p_part_id;
    IF v_is_manufacturable IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id;
    END IF;
    IF NOT v_is_manufacturable THEN
        RETURN (SELECT cost_per_unit FROM parts WHERE id = p_part_id);
    END IF;

    SELECT id INTO v_routing_id FROM routings WHERE part_id = p_part_id;

    -- Routing operations (only if a routing exists; some manufacturable parts
    -- may not have one yet, e.g. immediately after creation).
    IF v_routing_id IS NOT NULL THEN
        FOR v_op IN
            SELECT ro.setup_minutes,
                   ro.cycle_minutes_per_unit,
                   ro.labor_rate_override,
                   ro.external_unit_price,
                   ro.external_setup_cost,
                   wc.kind AS wc_kind,
                   wc.labor_rate AS wc_labor_rate
            FROM routing_operations ro
            JOIN work_centers wc ON wc.id = ro.work_center_id
            WHERE ro.routing_id = v_routing_id
        LOOP
            IF v_op.wc_kind = 'internal' THEN
                -- Per the no-silent-fallbacks engineering principle: if neither
                -- the per-op override nor the work-center default rate is set,
                -- we cannot price this operation. Raise rather than silently
                -- treating as $0 cost (which would let users quote at zero
                -- labor without ever seeing the missing data).
                IF v_op.labor_rate_override IS NULL AND v_op.wc_labor_rate IS NULL THEN
                    RAISE EXCEPTION 'Cannot recalculate cost for part %: routing op has no labor rate (neither override nor work_center default)', p_part_id
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := (COALESCE(v_op.setup_minutes, 0) / 1
                               + COALESCE(v_op.cycle_minutes_per_unit, 0))
                             * COALESCE(v_op.labor_rate_override, v_op.wc_labor_rate)
                             / 60.0;
            ELSE
                -- External op: at least one of unit_price or setup_cost should be
                -- set (a free outside op is meaningless). NULL on both means
                -- the user hasn't filled in pricing yet — refuse to compute.
                IF v_op.external_unit_price IS NULL AND v_op.external_setup_cost IS NULL THEN
                    RAISE EXCEPTION 'Cannot recalculate cost for part %: external routing op has no pricing (neither external_unit_price nor external_setup_cost)', p_part_id
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := COALESCE(v_op.external_unit_price, 0)
                             + COALESCE(v_op.external_setup_cost, 0) / 1;
            END IF;
            v_total_cost := v_total_cost + v_op_cost;
        END LOOP;
    END IF;

    -- BOM children. Convert BOM unit → child.primary_unit if they differ;
    -- error explicitly when no conversion exists (matches the existing
    -- unknown_* validation pattern).
    FOR v_bom IN
        SELECT b.quantity, b.unit, b.child_part_id,
               c.primary_unit AS child_primary_unit,
               c.cost_per_unit AS child_cost_per_unit
        FROM parts_bom b
        JOIN parts c ON c.id = b.child_part_id
        WHERE b.parent_part_id = p_part_id
    LOOP
        IF v_bom.child_cost_per_unit IS NULL THEN
            -- Per the no-silent-fallbacks principle: a BOM child without a
            -- cost can't contribute to the parent's cost rollup. Raise rather
            -- than treating as $0 (which would let users quote without ever
            -- noticing the missing child cost). The UI should walk the BOM
            -- bottom-up and refuse to recalc the parent until all leaves are
            -- priced.
            RAISE EXCEPTION 'Cannot recalculate cost for part %: BOM child % has no cost_per_unit (recalc the child first)', p_part_id, v_bom.child_part_id
                USING ERRCODE = 'check_violation';
        END IF;

        IF v_bom.unit IS DISTINCT FROM v_bom.child_primary_unit THEN
            SELECT to_primary_factor INTO v_to_primary_factor
            FROM parts_unit_conversions
            WHERE part_id = v_bom.child_part_id
              AND from_unit = v_bom.unit;

            IF v_to_primary_factor IS NULL THEN
                RAISE EXCEPTION 'No unit conversion from % to % for part %',
                    v_bom.unit, v_bom.child_primary_unit, v_bom.child_part_id
                    USING ERRCODE = 'check_violation';
            END IF;

            v_qty_in_primary_unit := v_bom.quantity * v_to_primary_factor;
        ELSE
            v_qty_in_primary_unit := v_bom.quantity;
        END IF;

        v_total_cost := v_total_cost + v_qty_in_primary_unit * v_bom.child_cost_per_unit;
    END LOOP;

    UPDATE parts
    SET cost_per_unit = v_total_cost,
        cost_recalculated_at = now()
    WHERE id = p_part_id;

    RETURN v_total_cost;
END;
$function$;

COMMENT ON FUNCTION public.recalculate_part_cost(uuid)
    IS 'Single-level cost rollup for an is_manufacturable part. Sums internal-op labor + external-op flat cost + (BOM child cost_per_unit * qty, with parts_unit_conversions if BOM unit differs from child primary_unit; raises if no conversion). Uses qty=1 for the standalone recalc (setup amortizes across batch in quotes/jobs). Reads each child cost_per_unit as-is — no recursion. Raises (does not silently fall back to $0) when an internal op has no labor rate, an external op has no pricing, or a BOM child has no cost. Updates parts.cost_per_unit + cost_recalculated_at, returns new cost. For non-manufacturable parts returns existing cost unchanged.';

-- ----------------------------------------------------------------------------
-- 3.7 get_ready_operations_for_station — operator station view
-- ----------------------------------------------------------------------------
--
-- Recreated against work_center_id (renamed from operation_type_id on
-- job_operations). The operator station page calls this to populate a
-- station's "what's next" queue. Same logic as the prior version, just a
-- column rename. Parameter and function name updated to match the
-- work_centers vocabulary.

CREATE OR REPLACE FUNCTION public.get_ready_operations_for_station(
    p_company_id uuid,
    p_work_center_id uuid
)
RETURNS TABLE (
    job_id uuid,
    job_part_id uuid,
    job_operation_id uuid,
    operation_name text,
    op_status text,
    job_number text,
    part_id uuid,
    part_name text,
    part_description text,
    part_quantity integer
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence, ej.job_number
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.work_center_id = p_work_center_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status, so.job_number
        FROM station_ops so
        WHERE so.status = 'in_progress'
           OR NOT EXISTS (
               SELECT 1 FROM job_operations prev
               WHERE prev.job_part_id = so.job_part_id
                 AND prev.sequence < so.sequence
                 AND prev.status NOT IN ('completed', 'skipped')
           )
    )
    SELECT
        ra.job_id,
        ra.job_part_id,
        ra.id AS job_operation_id,
        ra.operation_name,
        ra.status AS op_status,
        ra.job_number,
        jp.part_id,
        p.part_name,
        p.description AS part_description,
        jp.quantity AS part_quantity
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id;
END;
$function$;

COMMENT ON FUNCTION public.get_ready_operations_for_station(uuid, uuid)
    IS 'Operator-station readiness query: returns ops at the given work_center that are ready (no incomplete predecessors in the same job_part) or currently in_progress, scoped to the company. Renamed from the earlier operation_type_id-based version when operation_types collapsed into work_centers.';

-- ----------------------------------------------------------------------------
-- 3.8 get_ready_operations_batch — alerts/dashboard summary
-- ----------------------------------------------------------------------------
--
-- Same shape as before; doesn't reference work_center_id directly so the body
-- is unchanged. Recreated only because the function was dropped via CASCADE
-- in Phase 1 (operator_sessions FK chain).

CREATE OR REPLACE FUNCTION public.get_ready_operations_batch(p_job_ids uuid[])
RETURNS TABLE (
    job_id uuid,
    operation_name text,
    ready_count integer
)
LANGUAGE plpgsql
STABLE
AS $function$
BEGIN
    RETURN QUERY
    WITH
    in_progress_ops AS (
        SELECT jo.job_id, jo.operation_name, COUNT(*)::integer AS cnt
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.status = 'in_progress'
        GROUP BY jo.job_id, jo.operation_name
    ),
    jobs_with_in_progress AS (
        SELECT DISTINCT ip.job_id FROM in_progress_ops ip
    ),
    ready_ops AS (
        SELECT jo.job_id, jo.operation_name
        FROM job_operations jo
        WHERE jo.job_id = ANY(p_job_ids)
          AND jo.job_id NOT IN (SELECT jwi.job_id FROM jobs_with_in_progress jwi)
          AND jo.status = 'pending'
          AND NOT EXISTS (
              SELECT 1 FROM job_operations prev
              WHERE prev.job_part_id = jo.job_part_id
                AND prev.sequence < jo.sequence
                AND prev.status NOT IN ('completed', 'skipped')
          )
    ),
    ready_agg AS (
        SELECT ro.job_id, MIN(ro.operation_name) AS operation_name, COUNT(*)::integer AS ready_count
        FROM ready_ops ro
        GROUP BY ro.job_id
    )
    SELECT ip.job_id, ip.operation_name, ip.cnt AS ready_count
    FROM in_progress_ops ip
    UNION ALL
    SELECT ra.job_id, ra.operation_name, ra.ready_count
    FROM ready_agg ra;
END;
$function$;

COMMENT ON FUNCTION public.get_ready_operations_batch(uuid[])
    IS 'Returns per-job summary of ready or in-progress operations across the given job IDs. Used by alerts/dashboard. Body unchanged from the prior version (does not reference renamed columns).';

-- ============================================================================
-- Phase 4: Rewrite demo_data_templates to a minimal known-good seed
-- ============================================================================
--
-- The active demo template predates this migration (parts split into two
-- tables, operation_types instead of work_centers, routing_materials instead
-- of parts_bom). Mechanically transforming the existing template_data jsonb
-- in SQL is feasible but produces a brittle one-off transform and a demo
-- dataset that's still anemic against the new schema.
--
-- Instead: per the plan ("template reset to minimal seed; expand in PR 3
-- alongside UI"), we replace the active template_data with a small known-good
-- seed exercising the new shape:
--   - 1 vendor (used by an external work_center)
--   - 2 work_centers (1 internal, 1 external)
--   - 3 parts (1 raw material is_stockable, 1 sub-assembly both flags, 1
--     finished part is_manufacturable only)
--   - 1 routing on the finished part with 1 internal op
--   - 1 parts_bom edge (finished_part consumes sub-assembly)
--
-- The customers / quotes / jobs sections are dropped from the template; PR 3
-- will re-author the full template alongside the new UI work. The
-- seed_demo_data, reset_demo_company, and create_demo_company functions are
-- DROPPED in Phase 1 (not left broken); PR 3 rebuilds them against the new
-- schema. Demo seeding is unavailable until then — call create_demo_company
-- after PR 1 merges and you'll get an "function does not exist" error, which
-- is the intended behavior.

UPDATE public.demo_data_templates
   SET template_data = jsonb_build_object(
        'note', 'Minimal seed for PR 1 of unify-parts-inventory-add-work-centers-vendors. Expand in PR 3 alongside the UI rewrite. seed_demo_data() is also being rewritten in PR 3; this template is intentionally narrow until then.',
        'vendors', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'vendor_outside_coating',
                'name', 'Acme Coating',
                'contact_email', 'orders@acmecoating.example.com'
            )
        ),
        'work_centers', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'wc_lathe',
                'name', 'Mazak Lathe',
                'kind', 'internal',
                'labor_rate', 95.00,
                'description', 'Internal turning cell'
            ),
            jsonb_build_object(
                '_ref', 'wc_coating',
                'name', 'Acme Coating (outside)',
                'kind', 'external',
                'vendor_ref', 'vendor_outside_coating',
                'description', 'Outside coating partner'
            )
        ),
        'parts', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'part_raw_bar',
                'part_name', '1018-BAR',
                'description', '1018 cold-rolled steel bar, 1in dia',
                'is_manufacturable', false,
                'is_stockable', true,
                'primary_unit', 'in',
                'quantity', 240,
                'cost_per_unit', 0.85,
                'reorder_point', 60
            ),
            jsonb_build_object(
                '_ref', 'part_sub_assembly',
                'part_name', 'SUB-001',
                'description', 'Turned blank used in finished part',
                'is_manufacturable', true,
                'is_stockable', true,
                'primary_unit', 'each',
                'quantity', 0
            ),
            jsonb_build_object(
                '_ref', 'part_finished',
                'part_name', 'WIDGET-100',
                'description', 'Finished widget',
                'is_manufacturable', true,
                'is_stockable', false
            )
        ),
        'routings', jsonb_build_array(
            jsonb_build_object(
                '_ref', 'routing_widget',
                'part_ref', 'part_finished',
                'name', 'WIDGET-100 routing',
                'operations', jsonb_build_array(
                    jsonb_build_object(
                        '_ref', 'op_widget_turn',
                        'work_center_ref', 'wc_lathe',
                        'sequence', 10,
                        'setup_minutes', 30,
                        'cycle_minutes_per_unit', 4.5
                    )
                )
            )
        ),
        'parts_bom', jsonb_build_array(
            jsonb_build_object(
                'parent_ref', 'part_finished',
                'child_ref', 'part_sub_assembly',
                'quantity', 1,
                'unit', 'each'
            )
        )
   )
 WHERE is_active = true;

-- ============================================================================
-- Phase 5: Restore operator_sessions FKs against the new tables
-- ============================================================================
--
-- operator_sessions previously had:
--   operation_type_id uuid NOT NULL  → operation_types(id) ON DELETE RESTRICT
--   job_operation_id  uuid           → job_operations(id)  ON DELETE SET NULL
--
-- Both target tables were just dropped + recreated (operation_types is fully
-- replaced by work_centers; job_operations is recreated). We need to:
--   1. Rename the column operation_type_id → work_center_id
--   2. Add the new FK against work_centers(id) ON DELETE RESTRICT
--   3. Re-add the FK on job_operation_id against the new job_operations
--
-- The FKs from operator_sessions were dropped automatically by the CASCADE on
-- the drops in Phase 1 (Postgres drops dependent constraints, not the parent
-- column). The column itself survives.

ALTER TABLE public.operator_sessions
    RENAME COLUMN operation_type_id TO work_center_id;

ALTER TABLE public.operator_sessions
    ADD CONSTRAINT operator_sessions_work_center_id_fkey
    FOREIGN KEY (work_center_id) REFERENCES public.work_centers(id) ON DELETE RESTRICT;

ALTER TABLE public.operator_sessions
    ADD CONSTRAINT operator_sessions_job_operation_id_fkey
    FOREIGN KEY (job_operation_id) REFERENCES public.job_operations(id) ON DELETE SET NULL;

-- The job_id FK on operator_sessions also pointed at the old jobs table.
-- The CASCADE drop removed the constraint; re-add it against the new jobs.
ALTER TABLE public.operator_sessions
    ADD CONSTRAINT operator_sessions_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.operator_sessions.work_center_id IS 'FK to the work_center this session ran at (renamed from operation_type_id when operation_types was replaced by work_centers).';

-- ============================================================================
-- Phase 6: Grant SELECT on every recreated table to jigged_ai_readonly
-- ============================================================================
--
-- The role + USAGE on schema public are granted in 20260313_fix_ai_readonly_rls
-- and survive this migration. We only need to grant SELECT on the new tables;
-- the ai_readonly_select RLS policies above gate visibility per company.

GRANT SELECT ON
    public.vendors,
    public.parts,
    public.parts_unit_conversions,
    public.parts_bom,
    public.inventory_transactions,
    public.work_centers,
    public.routings,
    public.routing_operations,
    public.quotes,
    public.quote_line_items,
    public.quote_materials,
    public.quote_operations,
    public.part_pricing_tiers,
    public.jobs,
    public.job_parts,
    public.job_operations,
    public.job_materials
TO jigged_ai_readonly;

COMMIT;
