-- Document Snapshot Standard — capture triggers.
--
-- Populate the customer/address/contact snapshot columns on quotes/jobs/shipments
-- from their FKs, at INSERT and whenever an FK changes to a NEW non-null value.
-- This mirrors inventory_transactions' snapshot_transaction_location_name trigger
-- and means no application write path needs to resolve snapshots by hand.
--
-- Freeze semantics (critical):
--   * On INSERT: snapshot from the FKs.
--   * On UPDATE: re-snapshot a column ONLY when its FK changed to a non-null value
--     (the user picked a different address/contact). When an FK is cleared to NULL
--     — including the ON DELETE SET NULL fired by deleting the master address —
--     the existing snapshot is PRESERVED, so deleting an address never wipes the
--     history rendered on a past quote/packing slip.
--   * Editing the master row itself (customer_addresses / customers / contacts)
--     does not touch these tables, so existing snapshots stay frozen.

-- ============================================================
-- quotes & jobs (same column set: customer_id, billing/shipping_address_id, contact_id)
-- ============================================================
CREATE OR REPLACE FUNCTION public.snapshot_document_party()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
        IF NEW.customer_id IS NOT NULL THEN
            NEW.customer_name := (SELECT name FROM public.customers WHERE id = NEW.customer_id);
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.billing_address_id IS DISTINCT FROM OLD.billing_address_id THEN
        IF NEW.billing_address_id IS NOT NULL THEN
            NEW.bill_to_address := public.address_block_snapshot(NEW.billing_address_id);
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.shipping_address_id IS DISTINCT FROM OLD.shipping_address_id THEN
        IF NEW.shipping_address_id IS NOT NULL THEN
            NEW.ship_to_address := public.address_block_snapshot(NEW.shipping_address_id);
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
        IF NEW.contact_id IS NOT NULL THEN
            NEW.contact_snapshot := public.contact_block_snapshot(NEW.contact_id);
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_snapshot_quote_party ON public.quotes;
CREATE TRIGGER trg_snapshot_quote_party
    BEFORE INSERT OR UPDATE OF customer_id, billing_address_id, shipping_address_id, contact_id
    ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION public.snapshot_document_party();

DROP TRIGGER IF EXISTS trg_snapshot_job_party ON public.jobs;
CREATE TRIGGER trg_snapshot_job_party
    BEFORE INSERT OR UPDATE OF customer_id, billing_address_id, shipping_address_id, contact_id
    ON public.jobs
    FOR EACH ROW EXECUTE FUNCTION public.snapshot_document_party();

-- ============================================================
-- shipments (no contact; bill-to derives from the customer's default-billing row)
-- ============================================================
CREATE OR REPLACE FUNCTION public.snapshot_shipment_party()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
        IF NEW.customer_id IS NOT NULL THEN
            NEW.customer_name := (SELECT name FROM public.customers WHERE id = NEW.customer_id);
            NEW.bill_to_address := public.address_block_snapshot(
                (SELECT a.id FROM public.customer_addresses a
                  WHERE a.customer_id = NEW.customer_id AND a.default_billing
                  LIMIT 1));
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.shipping_address_id IS DISTINCT FROM OLD.shipping_address_id THEN
        IF NEW.shipping_address_id IS NOT NULL THEN
            NEW.ship_to_address := public.address_block_snapshot(NEW.shipping_address_id);
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_snapshot_shipment_party ON public.shipments;
CREATE TRIGGER trg_snapshot_shipment_party
    BEFORE INSERT OR UPDATE OF customer_id, shipping_address_id
    ON public.shipments
    FOR EACH ROW EXECUTE FUNCTION public.snapshot_shipment_party();

GRANT ALL ON FUNCTION public.snapshot_document_party() TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.snapshot_shipment_party() TO anon, authenticated, service_role;
