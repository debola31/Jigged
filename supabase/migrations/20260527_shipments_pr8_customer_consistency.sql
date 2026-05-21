-- ============================================================================
-- Shipments — PR 8: customer-consistency triggers for multi-job shipments
-- ============================================================================
--
-- Context. Phase 1.5 (Flow D) ships the top-level /shipments/new wizard
-- that lets one packing slip cover lines from multiple jobs for one
-- customer. The schema and create_shipment_with_line_items RPC have
-- supported multi-job since PR 4 — shipments has no job_id, lines join
-- through job_parts → jobs — but nothing enforced that every line's
-- job.customer_id matches the parent shipment's customer_id. In
-- single-job mode the modal made the mismatch unreachable in practice;
-- in multi-job mode a UI bug in the line-picker query could let a line
-- from another customer's job slip in.
--
-- This migration adds two paired triggers, both BEFORE-row, both
-- trigger-level (not RPC-level) so the invariant holds for any future
-- insert path including direct table writes, the Phase-3 edit/void
-- flows, and any future ETL or admin tooling.
--
-- Trigger 1 — line-item-level customer consistency:
--   BEFORE INSERT OR UPDATE on shipment_line_items
--   Resolves parent shipments.customer_id and job_parts → jobs.customer_id;
--   raises if they differ.
--
-- Trigger 2 — shipment-level customer_id immutability:
--   BEFORE UPDATE OF customer_id on shipments
--   Raises if NEW.customer_id IS DISTINCT FROM OLD.customer_id. Pairs
--   with Trigger 1 to close the otherwise-silent inconsistency window:
--   without it, flipping shipments.customer_id post-insert would leave
--   existing shipment_line_items pointing at the old customer's jobs and
--   Trigger 1 wouldn't fire (no rows on that table changed). A shipment
--   changing customers post-creation is incoherent — voiding and
--   recreating is the right path.
--
-- IDEMPOTENT. DROP TRIGGER IF EXISTS + CREATE TRIGGER on both; functions
-- use CREATE OR REPLACE. Re-running on a fully-migrated DB is a no-op.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;


-- ============================================================================
-- Trigger 1: line-item customer consistency
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_shipment_line_item_customer_consistency()
    RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_shipment_customer_id uuid;
    v_line_customer_id uuid;
BEGIN
    SELECT customer_id INTO v_shipment_customer_id
      FROM public.shipments
     WHERE id = NEW.shipment_id;

    IF v_shipment_customer_id IS NULL THEN
        -- Parent shipment vanished (or wasn't visible) between row
        -- staging and the BEFORE-row firing. The FK on shipment_id with
        -- ON DELETE CASCADE handles the visible cases; raise here to
        -- surface anything weirder.
        RAISE EXCEPTION 'shipment_line_items.shipment_id % has no parent shipment',
            NEW.shipment_id USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT j.customer_id INTO v_line_customer_id
      FROM public.job_parts jp
      JOIN public.jobs j ON j.id = jp.job_id
     WHERE jp.id = NEW.job_part_id;

    IF v_line_customer_id IS NULL THEN
        RAISE EXCEPTION 'shipment_line_items.job_part_id % does not resolve to a job/customer',
            NEW.job_part_id USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_line_customer_id IS DISTINCT FROM v_shipment_customer_id THEN
        RAISE EXCEPTION
            'shipment_line_items.job_part_id % belongs to customer %, '
            'but parent shipment % is for customer %',
            NEW.job_part_id, v_line_customer_id,
            NEW.shipment_id, v_shipment_customer_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

COMMENT ON FUNCTION public.enforce_shipment_line_item_customer_consistency() IS
    'Trigger function (PR 8): rejects shipment_line_items whose job_part resolves to a different customer than the parent shipment. Closes a multi-job UI failure mode at the schema level. Pairs with enforce_shipment_customer_id_immutable on the shipments side.';

DROP TRIGGER IF EXISTS enforce_shipment_line_item_customer_consistency_trg
    ON public.shipment_line_items;
CREATE TRIGGER enforce_shipment_line_item_customer_consistency_trg
    BEFORE INSERT OR UPDATE OF shipment_id, job_part_id
    ON public.shipment_line_items
    FOR EACH ROW EXECUTE FUNCTION public.enforce_shipment_line_item_customer_consistency();


-- ============================================================================
-- Trigger 2: shipment customer_id immutability
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_shipment_customer_id_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
        RAISE EXCEPTION
            'shipments.customer_id is immutable after insert '
            '(attempted to change shipment % from customer % to %)',
            OLD.id, OLD.customer_id, NEW.customer_id
            USING ERRCODE = 'check_violation',
                  HINT = 'Void and recreate the shipment for the correct customer.';
    END IF;
    RETURN NEW;
END $$;

COMMENT ON FUNCTION public.enforce_shipment_customer_id_immutable() IS
    'Trigger function (PR 8): rejects UPDATEs that change shipments.customer_id. A shipment changing customers post-insert is incoherent; the right path is void + recreate. Pairs with enforce_shipment_line_item_customer_consistency to close the multi-job consistency window.';

DROP TRIGGER IF EXISTS enforce_shipment_customer_id_immutable_trg
    ON public.shipments;
CREATE TRIGGER enforce_shipment_customer_id_immutable_trg
    BEFORE UPDATE OF customer_id
    ON public.shipments
    FOR EACH ROW EXECUTE FUNCTION public.enforce_shipment_customer_id_immutable();


COMMIT;
