-- ============================================================
-- Add discrepancy flag to inventory transactions
-- Created: 2026-03-09
--
-- When operator-confirmed material usage exceeds available
-- inventory, the system depletes to zero and flags the
-- transaction for admin review.
-- ============================================================

BEGIN;

ALTER TABLE public.inventory_transactions
    ADD COLUMN IF NOT EXISTS has_discrepancy boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.inventory_transactions.has_discrepancy
    IS 'True when confirmed usage exceeded available stock. Transaction records full operator-confirmed amount, but inventory was only depleted to zero.';

-- Partial index for efficient admin queries on discrepancies
CREATE INDEX IF NOT EXISTS inventory_transactions_discrepancy_idx
    ON public.inventory_transactions (company_id, created_at DESC)
    WHERE has_discrepancy = true;

-- Update the notes-only trigger to also allow has_discrepancy in the immutability check
-- (has_discrepancy is set at insert time, not updated later)
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
       OR OLD.has_discrepancy IS DISTINCT FROM NEW.has_discrepancy
    THEN
        RAISE EXCEPTION 'Only the notes field can be updated on inventory transactions';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
