-- ============================================================================
-- Shipments — PR 2 revision: unify quote contact into a single FK
-- ============================================================================
--
-- Context. PR 2 (20260520) gave quotes four address/contact FKs:
-- billing_address_id, shipping_address_id, billing_contact_id,
-- shipping_contact_id. Contour usability feedback on the first PDF
-- mock-up: the printed quote needs one customer-contact section (name,
-- role, email, phone) and one address block (the shipping address). The
-- bill-to data is still captured on the quote for a future invoicing
-- flow, but does not render on the quote document.
--
-- Two contact FKs were therefore a level of detail the form didn't
-- benefit from. Replace them with a single quotes.contact_id, defaulted
-- at quote creation to the customer's primary contact (is_primary=true
-- on customer_contacts, enforced unique by the customer_contacts_one_primary
-- partial index from migration 20260517).
--
-- The two address FKs stay. shipping_address_id is what the PDF renders;
-- billing_address_id is captured for downstream invoicing and edited via
-- a "Billing details" disclosure on the form.
--
-- The Phase-1 shipment-form contact override (proposed as
-- shipments.shipping_contact_id in the implementation plan) is dropped
-- from Phase 1 entirely. The packing slip's ATTN line resolves directly
-- from the shipping address's customer_addresses.attention_to column —
-- no fallback chain, one column → one rendered line.
--
-- IDEMPOTENT. ADD/DROP IF [NOT] EXISTS plus a re-runnable backfill that
-- skips quotes with contact_id already set.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

-- ============================================================================
-- Phase 1: Add quotes.contact_id
-- ============================================================================

ALTER TABLE public.quotes
    ADD COLUMN IF NOT EXISTS contact_id uuid
        REFERENCES public.customer_contacts(id);

COMMENT ON COLUMN public.quotes.contact_id
    IS 'Customer contact the quote is addressed to. Renders as the Customer Contact section on the printed quote (name, role, email, phone). Defaults at quote creation to the customer''s primary contact (is_primary=true in customer_contacts); editable per-quote.';


-- ============================================================================
-- Phase 2: Backfill from primary contact, skipping rows already populated
-- ============================================================================

UPDATE public.quotes q SET
    contact_id = (
        SELECT c.id FROM public.customer_contacts c
         WHERE c.customer_id = q.customer_id
           AND c.is_primary = true
         LIMIT 1
    )
WHERE q.contact_id IS NULL;


-- ============================================================================
-- Phase 3: Drop the two old contact FKs
-- ============================================================================
-- The integrity trigger added in 20260520 references both old columns
-- and the new contact_id. Drop and recreate the function to fix the
-- column reference set in lockstep.

DROP TRIGGER IF EXISTS enforce_quote_address_contact_customer_trg ON public.quotes;

ALTER TABLE public.quotes
    DROP COLUMN IF EXISTS billing_contact_id,
    DROP COLUMN IF EXISTS shipping_contact_id;


-- ============================================================================
-- Phase 4: Rebuild the integrity trigger over the new column set
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_quote_address_contact_customer()
    RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.billing_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.billing_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'quotes.billing_address_id % does not belong to customer %',
                NEW.billing_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.shipping_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.shipping_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'quotes.shipping_address_id % does not belong to customer %',
                NEW.shipping_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_contacts
         WHERE id = NEW.contact_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'quotes.contact_id % does not belong to customer %',
                NEW.contact_id, NEW.customer_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER enforce_quote_address_contact_customer_trg
    BEFORE INSERT OR UPDATE OF
        billing_address_id,
        shipping_address_id,
        contact_id,
        customer_id
    ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION public.enforce_quote_address_contact_customer();


COMMIT;
