-- Inventory Locations & QR-Addressable Stock — schema (PR1 of 2)
--
-- Adds a hierarchical, company-scoped storage-location tree and per-location
-- stock balances. For a part opted into location tracking, part_location_stock
-- becomes the source of truth and parts.quantity becomes a trigger-maintained
-- rollup (see the sibling triggers migration). This file only lays down tables,
-- columns, constraints, indexes and RLS; triggers and RPCs follow.
--
-- Key invariants enforced here:
--   * part_location_stock.quantity >= 0 (mirrors parts_quantity_non_negative so a
--     rollup can never try to write a negative SUM).
--   * UNIQUE(part_id, location_id): one balance row per part per location.
--   * part_location_stock is SELECT-only under RLS — every balance mutation must
--     go through the SECURITY DEFINER RPCs (which also write the ledger), so a
--     balance change can never exist without a paired inventory_transactions row.
--   * inventory_transactions.location_id uses ON DELETE RESTRICT (preserve the
--     audit link) which also lets us treat location_id as immutable on the ledger.

-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS "public"."inventory_locations"
(
    "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id"    uuid NOT NULL,
    "parent_id"     uuid,                                   -- null = root node
    "name"          text NOT NULL,                          -- "Left", "Row 3", "Cabinet 1"
    "kind"          text,                                   -- free: 'cabinet'|'row'|'side'|'shelf'|'bin'|…
    "code"          text,                                   -- derived/edited flat label code e.g. "CAB1-R3-L"
    "is_stockable"  boolean NOT NULL DEFAULT true,          -- may hold part balances
    "is_qr_anchor"  boolean NOT NULL DEFAULT false,         -- has a printed QR / is a scan target
    "sort_order"    integer NOT NULL DEFAULT 0,
    "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at"    timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY (id),
    CONSTRAINT "inventory_locations_company_fkey"
        FOREIGN KEY (company_id) REFERENCES "public"."companies"(id) ON DELETE CASCADE,
    CONSTRAINT "inventory_locations_parent_fkey"
        FOREIGN KEY (parent_id) REFERENCES "public"."inventory_locations"(id) ON DELETE RESTRICT,
    CONSTRAINT "inventory_locations_name_not_blank" CHECK (length(btrim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS "public"."part_location_stock"
(
    "id"            uuid NOT NULL DEFAULT gen_random_uuid(),
    "company_id"    uuid NOT NULL,
    "part_id"       uuid NOT NULL,
    "location_id"   uuid NOT NULL,
    "quantity"      numeric NOT NULL DEFAULT 0,
    "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "part_location_stock_pkey" PRIMARY KEY (id),
    CONSTRAINT "part_location_stock_company_fkey"
        FOREIGN KEY (company_id) REFERENCES "public"."companies"(id) ON DELETE CASCADE,
    CONSTRAINT "part_location_stock_part_fkey"
        FOREIGN KEY (part_id) REFERENCES "public"."parts"(id) ON DELETE RESTRICT,
    CONSTRAINT "part_location_stock_location_fkey"
        FOREIGN KEY (location_id) REFERENCES "public"."inventory_locations"(id) ON DELETE RESTRICT,
    CONSTRAINT "part_location_stock_part_location_unique" UNIQUE (part_id, location_id),
    CONSTRAINT "part_location_stock_quantity_non_negative" CHECK ((quantity >= (0)::numeric))
);

-- ============================================================
-- 2. ADDITIVE COLUMNS ON EXISTING TABLES
-- ============================================================

ALTER TABLE "public"."parts"
    ADD COLUMN IF NOT EXISTS "is_location_tracked" boolean NOT NULL DEFAULT false;

ALTER TABLE "public"."inventory_transactions"
    ADD COLUMN IF NOT EXISTS "location_id"       uuid,
    ADD COLUMN IF NOT EXISTS "transfer_group_id" uuid;          -- pairs the two halves of a move

ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_location_fkey"
        FOREIGN KEY (location_id) REFERENCES "public"."inventory_locations"(id) ON DELETE RESTRICT;

-- ============================================================
-- 3. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS "inventory_locations_company_parent_idx"
    ON "public"."inventory_locations" (company_id, parent_id);

-- At most one system "Unassigned" location per company (find-or-create target at opt-in).
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_locations_one_unassigned_per_company"
    ON "public"."inventory_locations" (company_id)
    WHERE (name = 'Unassigned');

CREATE INDEX IF NOT EXISTS "part_location_stock_company_idx"
    ON "public"."part_location_stock" (company_id);
CREATE INDEX IF NOT EXISTS "part_location_stock_location_idx"
    ON "public"."part_location_stock" (location_id);          -- "what's in this location?"
CREATE INDEX IF NOT EXISTS "part_location_stock_part_idx"
    ON "public"."part_location_stock" (part_id);              -- rollup SUM(WHERE part_id=…)

CREATE INDEX IF NOT EXISTS "inventory_transactions_location_idx"
    ON "public"."inventory_transactions" (location_id) WHERE (location_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS "inventory_transactions_transfer_group_idx"
    ON "public"."inventory_transactions" (transfer_group_id) WHERE (transfer_group_id IS NOT NULL);

-- ============================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE "public"."inventory_locations"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."part_location_stock"   ENABLE ROW LEVEL SECURITY;

-- inventory_locations: full company-scoped CRUD (tree management is plain client CRUD).
DROP POLICY IF EXISTS "Users can view inventory_locations" ON "public"."inventory_locations";
CREATE POLICY "Users can view inventory_locations"
    ON "public"."inventory_locations" FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert inventory_locations" ON "public"."inventory_locations";
CREATE POLICY "Users can insert inventory_locations"
    ON "public"."inventory_locations" FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update inventory_locations" ON "public"."inventory_locations";
CREATE POLICY "Users can update inventory_locations"
    ON "public"."inventory_locations" FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can delete inventory_locations" ON "public"."inventory_locations";
CREATE POLICY "Users can delete inventory_locations"
    ON "public"."inventory_locations" FOR DELETE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

-- part_location_stock: SELECT only. INSERT/UPDATE/DELETE intentionally have NO
-- policy, so direct client writes are denied by RLS — every balance change must
-- flow through a SECURITY DEFINER RPC that also writes the ledger.
DROP POLICY IF EXISTS "Users can view part_location_stock" ON "public"."part_location_stock";
CREATE POLICY "Users can view part_location_stock"
    ON "public"."part_location_stock" FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

-- ============================================================
-- 5. LEDGER IMMUTABILITY — extend the notes-only update guard
-- ============================================================
-- location_id and transfer_group_id join the immutable column set so a move's
-- group link and the where-it-happened pointer can't be rewritten via the
-- notes-edit path. Safe alongside the ON DELETE RESTRICT FK: RESTRICT never
-- updates these rows, so there is no cascade-vs-immutability conflict.

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
       OR OLD.location_id       IS DISTINCT FROM NEW.location_id
       OR OLD.transfer_group_id IS DISTINCT FROM NEW.transfer_group_id
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$function$;

COMMENT ON TABLE "public"."inventory_locations" IS 'Company-scoped, arbitrary-depth storage-location tree (cabinet › row › side, etc.). is_qr_anchor marks nodes with a printed QR.';
COMMENT ON TABLE "public"."part_location_stock" IS 'Per-location stock balances; source of truth for location-tracked parts. SELECT-only via RLS — mutated only through SECURITY DEFINER RPCs that also write inventory_transactions.';
COMMENT ON COLUMN "public"."parts"."is_location_tracked" IS 'When true, parts.quantity is a trigger-maintained rollup of part_location_stock and direct quantity writes are rejected.';
