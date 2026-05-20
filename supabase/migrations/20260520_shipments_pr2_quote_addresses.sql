-- ============================================================================
-- Shipments — PR 2: explicit address + contact FKs on quotes, customer_po_number
-- ============================================================================
--
-- Context. Second PR of the Shipments v2 implementation
-- (see docs/modules/PRD-shipments-2.md). Quotes currently have no explicit
-- billing/shipping address or contact — the printable quote pulls them
-- from the customer at render time via `pickBillingAddress` /
-- `pickShippingAddress` in utils/quotePdf.ts. That works until a customer's
-- defaults change after a quote is created — at which point the printed
-- quote silently re-renders against the new address with no audit of what
-- the customer originally saw.
--
-- This PR makes the four values explicit on the quote row, with defaults
-- set at quote creation time using the same picker helpers. Existing
-- (legacy) quotes are backfilled in this migration so every row has its
-- FKs populated; the runtime fallback path in quotePdf.ts is deleted in
-- the same PR. Per CLAUDE.md "no silent runtime fallbacks for data-at-rest
-- issues": after this migration every quote satisfies the new invariant
-- (FK columns reflect what the customer originally saw), and the read
-- path has a single clean shape with no branching on "what if the FK is null."
--
-- customer_po_number lives on the quote (one PO per customer order in
-- practice; per-line POs are deferred). Indexed via pg_trgm in PR 4 for
-- the jobs-list search; this PR only adds a btree partial index for the
-- common-case "show me the quote for PO X" lookup.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS / CREATE TRIGGER OR REPLACE
-- patterns let the migration re-apply. The backfill skips quotes that
-- already have a billing_address_id set.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

-- ============================================================================
-- Phase 1: Add the five new columns (PO + four FKs)
-- ============================================================================

ALTER TABLE public.quotes
    ADD COLUMN IF NOT EXISTS customer_po_number text,
    ADD COLUMN IF NOT EXISTS billing_address_id uuid
        REFERENCES public.customer_addresses(id),
    ADD COLUMN IF NOT EXISTS shipping_address_id uuid
        REFERENCES public.customer_addresses(id),
    ADD COLUMN IF NOT EXISTS billing_contact_id uuid
        REFERENCES public.customer_contacts(id),
    ADD COLUMN IF NOT EXISTS shipping_contact_id uuid
        REFERENCES public.customer_contacts(id);

CREATE INDEX IF NOT EXISTS idx_quotes_customer_po_number
    ON public.quotes(company_id, customer_po_number)
    WHERE customer_po_number IS NOT NULL;

COMMENT ON COLUMN public.quotes.customer_po_number
    IS 'Customer-issued PO number associated with this quote/order. Indexed (partial) per (company_id, customer_po_number) for lookup, and via pg_trgm in PR 4 for the jobs-list search.';

COMMENT ON COLUMN public.quotes.billing_address_id
    IS 'Customer address used for BILL TO on the printable quote and downstream shipments. Set at quote creation from the customer''s default_billing row; editable per-quote.';

COMMENT ON COLUMN public.quotes.shipping_address_id
    IS 'Customer address used for SHIP TO on the printable quote and downstream shipments. Set at quote creation from the customer''s default_shipping row (falling back to default_billing); editable per-quote.';

COMMENT ON COLUMN public.quotes.billing_contact_id
    IS 'Customer contact treated as billing recipient (printed alongside BILL TO). Set at quote creation from contact role accounts_payable, falling back to buyer.';

COMMENT ON COLUMN public.quotes.shipping_contact_id
    IS 'Customer contact treated as shipping recipient (used for the packing-slip ATTN line on downstream shipments). Set at quote creation from contact role shipping_receiving, falling back to buyer.';


-- ============================================================================
-- Phase 2: Backfill legacy quotes — snapshot today''s pickBillingAddress /
--          pickShippingAddress / default-contact picks into the FK columns.
-- ============================================================================
-- Skip rows that already have billing_address_id set (i.e. re-runs after a
-- partial apply, or rows touched between Phase 1 and Phase 2 in a parallel
-- session). The picks themselves are LIMIT 1; if there are multiple
-- candidates somehow (data anomaly), pick deterministically by id ascending.

UPDATE public.quotes q SET
    billing_address_id = (
        SELECT a.id FROM public.customer_addresses a
         WHERE a.customer_id = q.customer_id
           AND a.default_billing = true
         ORDER BY a.id ASC
         LIMIT 1
    )
WHERE q.billing_address_id IS NULL;

UPDATE public.quotes q SET
    shipping_address_id = COALESCE(
        (SELECT a.id FROM public.customer_addresses a
          WHERE a.customer_id = q.customer_id
            AND a.default_shipping = true
          ORDER BY a.id ASC
          LIMIT 1),
        (SELECT a.id FROM public.customer_addresses a
          WHERE a.customer_id = q.customer_id
            AND a.default_billing = true
          ORDER BY a.id ASC
          LIMIT 1)
    )
WHERE q.shipping_address_id IS NULL;

UPDATE public.quotes q SET
    billing_contact_id = COALESCE(
        (SELECT c.id FROM public.customer_contacts c
          WHERE c.customer_id = q.customer_id
            AND c.role = 'accounts_payable'
          ORDER BY c.id ASC
          LIMIT 1),
        (SELECT c.id FROM public.customer_contacts c
          WHERE c.customer_id = q.customer_id
            AND c.role = 'buyer'
          ORDER BY c.id ASC
          LIMIT 1)
    )
WHERE q.billing_contact_id IS NULL;

UPDATE public.quotes q SET
    shipping_contact_id = COALESCE(
        (SELECT c.id FROM public.customer_contacts c
          WHERE c.customer_id = q.customer_id
            AND c.role = 'shipping_receiving'
          ORDER BY c.id ASC
          LIMIT 1),
        (SELECT c.id FROM public.customer_contacts c
          WHERE c.customer_id = q.customer_id
            AND c.role = 'buyer'
          ORDER BY c.id ASC
          LIMIT 1)
    )
WHERE q.shipping_contact_id IS NULL;


-- ============================================================================
-- Phase 3: Integrity trigger — FK targets must belong to the same customer
-- ============================================================================
-- A CHECK constraint can''t reference other rows, so the same-customer
-- invariant is enforced via a BEFORE INSERT OR UPDATE trigger that
-- rejects mismatches with a clear error. This mirrors the trigger
-- pattern added in PR 4 for shipments (enforce_shipment_address_contact_customer).

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
    IF NEW.billing_contact_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_contacts
         WHERE id = NEW.billing_contact_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'quotes.billing_contact_id % does not belong to customer %',
                NEW.billing_contact_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.shipping_contact_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_contacts
         WHERE id = NEW.shipping_contact_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'quotes.shipping_contact_id % does not belong to customer %',
                NEW.shipping_contact_id, NEW.customer_id;
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_quote_address_contact_customer_trg ON public.quotes;

CREATE TRIGGER enforce_quote_address_contact_customer_trg
    BEFORE INSERT OR UPDATE OF
        billing_address_id,
        shipping_address_id,
        billing_contact_id,
        shipping_contact_id,
        customer_id
    ON public.quotes
    FOR EACH ROW EXECUTE FUNCTION public.enforce_quote_address_contact_customer();


COMMIT;
