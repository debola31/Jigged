-- ============================================================
-- Allow updating notes on inventory transactions
-- Created: 2026-03-09
--
-- Transactions remain immutable except for the notes field,
-- which users may need to correct or add context to.
-- ============================================================

BEGIN;

-- 1. RLS policy allowing update (scoped to company membership)
DROP POLICY IF EXISTS "Users can update inventory_transaction_notes" ON "public"."inventory_transactions";
CREATE POLICY "Users can update inventory_transaction_notes"
    ON "public"."inventory_transactions"
    FOR UPDATE
    USING ((company_id IN (SELECT get_user_company_ids())));

-- 2. Trigger to enforce notes-only updates (preserve immutability of financial data)
CREATE OR REPLACE FUNCTION restrict_transaction_update_to_notes()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.company_id IS DISTINCT FROM NEW.company_id
       OR OLD.inventory_item_id IS DISTINCT FROM NEW.inventory_item_id
       OR OLD.item_name IS DISTINCT FROM NEW.item_name
       OR OLD.type IS DISTINCT FROM NEW.type
       OR OLD.quantity IS DISTINCT FROM NEW.quantity
       OR OLD.unit IS DISTINCT FROM NEW.unit
       OR OLD.converted_quantity IS DISTINCT FROM NEW.converted_quantity
       OR OLD.job_id IS DISTINCT FROM NEW.job_id
       OR OLD.job_operation_id IS DISTINCT FROM NEW.job_operation_id
       OR OLD.operator_id IS DISTINCT FROM NEW.operator_id
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.created_by IS DISTINCT FROM NEW.created_by
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_transaction_notes_only_update ON "public"."inventory_transactions";
CREATE TRIGGER enforce_transaction_notes_only_update
    BEFORE UPDATE ON "public"."inventory_transactions"
    FOR EACH ROW
    EXECUTE FUNCTION restrict_transaction_update_to_notes();

COMMIT;
