-- Make an EMPTY location deletable even after it has activity history.
--
-- Real-world case: a shelf is used, everything is later removed, and the shelf
-- is thrown out — the operator should be able to delete the location entirely.
-- Previously inventory_transactions.location_id was ON DELETE RESTRICT, so any
-- location that had ever been transacted could never be deleted.
--
-- We preserve the historical reference the same way the ledger already handles
-- deleted parts: snapshot a human-readable name onto each row (like item_name),
-- and null the live FK link on delete.
--
--   * inventory_transactions.location_name — snapshot of the location's full
--     path at transaction time (auto-filled by a BEFORE INSERT trigger, so the
--     stock RPCs need no change). Immutable thereafter.
--   * location_id FK becomes ON DELETE SET NULL (was RESTRICT) and leaves the
--     immutable column set, so the SET NULL cascade is allowed on deletion.
--   * delete_location() RPC allows deletion when a location has no children and
--     no qty>0 balances, cleaning up any leftover zero-qty balance rows (which
--     clients can't touch — part_location_stock is SELECT-only).

-- ============================================================
-- 1. Snapshot column + path helper
-- ============================================================
ALTER TABLE "public"."inventory_transactions"
    ADD COLUMN IF NOT EXISTS "location_name" text;

-- Full path label, root › … › leaf (e.g. "Cabinet 1 › Row 3 › Left").
CREATE OR REPLACE FUNCTION public.inv_location_path_label(p_location_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, name, 0 AS depth
      FROM public.inventory_locations WHERE id = p_location_id
    UNION ALL
    SELECT l.id, l.parent_id, l.name, c.depth + 1
      FROM public.inventory_locations l JOIN chain c ON l.id = c.parent_id
  )
  SELECT string_agg(name, ' › ' ORDER BY depth DESC) FROM chain;
$function$;

-- ============================================================
-- 2. Auto-snapshot location_name on insert (RPCs unchanged)
-- ============================================================
CREATE OR REPLACE FUNCTION public.snapshot_transaction_location_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF NEW.location_id IS NOT NULL AND NEW.location_name IS NULL THEN
        NEW.location_name := public.inv_location_path_label(NEW.location_id);
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS "trg_snapshot_txn_location" ON "public"."inventory_transactions";
CREATE TRIGGER "trg_snapshot_txn_location"
    BEFORE INSERT ON "public"."inventory_transactions"
    FOR EACH ROW EXECUTE FUNCTION public.snapshot_transaction_location_name();

-- ============================================================
-- 3. Backfill existing rows (data-at-rest: every located row gets a snapshot)
--    Runs while location_name is still mutable; only location_name changes, so
--    the notes-only update guard (still listing location_id) is not tripped.
-- ============================================================
UPDATE "public"."inventory_transactions"
   SET location_name = public.inv_location_path_label(location_id)
 WHERE location_id IS NOT NULL AND location_name IS NULL;

-- ============================================================
-- 4. Immutability: location_id leaves the set (so SET NULL on delete is
--    allowed); location_name joins it (the durable audit snapshot).
-- ============================================================
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
       OR OLD.location_name     IS DISTINCT FROM NEW.location_name
       OR OLD.transfer_group_id IS DISTINCT FROM NEW.transfer_group_id
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$function$;

-- ============================================================
-- 5. FK: RESTRICT -> SET NULL (preserve the row + name snapshot on delete)
-- ============================================================
ALTER TABLE "public"."inventory_transactions"
    DROP CONSTRAINT IF EXISTS "inventory_transactions_location_fkey";
ALTER TABLE "public"."inventory_transactions"
    ADD CONSTRAINT "inventory_transactions_location_fkey"
        FOREIGN KEY (location_id) REFERENCES "public"."inventory_locations"(id) ON DELETE SET NULL;

-- ============================================================
-- 6. delete_location RPC — empty location deletable regardless of history
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_location(p_location_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid;
BEGIN
    SELECT company_id INTO v_company FROM public.inventory_locations WHERE id = p_location_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'location % not found', p_location_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (SELECT 1 FROM public.inventory_locations WHERE parent_id = p_location_id) THEN
        RAISE EXCEPTION 'location has sub-locations' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.part_location_stock
         WHERE location_id = p_location_id AND quantity > 0
    ) THEN
        RAISE EXCEPTION 'location still holds stock' USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Drop any zero-qty balance rows (clients can't — SELECT-only), then the
    -- location. Historical ledger rows keep location_name; their location_id is
    -- nulled by the ON DELETE SET NULL FK.
    DELETE FROM public.part_location_stock WHERE location_id = p_location_id;
    DELETE FROM public.inventory_locations WHERE id = p_location_id;
END;
$function$;

GRANT ALL ON FUNCTION public.inv_location_path_label(uuid) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.delete_location(uuid) TO anon, authenticated, service_role;

COMMENT ON COLUMN "public"."inventory_transactions"."location_name" IS 'Snapshot of the location''s full path at transaction time, so deleted locations remain referrable in history (mirrors item_name for deleted parts).';
