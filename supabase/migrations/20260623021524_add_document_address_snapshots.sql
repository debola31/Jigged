-- Document Snapshot Standard — freeze the customer/address/contact block onto
-- the documents that render it (quotes, jobs, shipments), so a master address
-- (or customer name / contact) can be edited or DELETED without rewriting the
-- history shown on a printed quote / packing slip.
--
-- See docs/architecture.md "Document Snapshot Standard". This mirrors the
-- existing snapshots (quote pricing_basis, quote_operations.operation_name,
-- inventory_transactions.location_name / item_name): the document carries its
-- own immutable copy; the master FK is a nullable navigation link only.
--
-- Snapshot shapes (jsonb):
--   address: { address_line1, address_line2, city, state, postal_code, country, attention_to }
--   contact: { name, email, phone }
-- customer_name is a discrete text column (house style for name snapshots).

-- ============================================================
-- 1. Snapshot columns
-- ============================================================
ALTER TABLE public.quotes
    ADD COLUMN IF NOT EXISTS customer_name    text,
    ADD COLUMN IF NOT EXISTS bill_to_address  jsonb,
    ADD COLUMN IF NOT EXISTS ship_to_address  jsonb,
    ADD COLUMN IF NOT EXISTS contact_snapshot jsonb;

ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS customer_name    text,
    ADD COLUMN IF NOT EXISTS bill_to_address  jsonb,
    ADD COLUMN IF NOT EXISTS ship_to_address  jsonb,
    ADD COLUMN IF NOT EXISTS contact_snapshot jsonb;

ALTER TABLE public.shipments
    ADD COLUMN IF NOT EXISTS customer_name    text,
    ADD COLUMN IF NOT EXISTS bill_to_address  jsonb,
    ADD COLUMN IF NOT EXISTS ship_to_address  jsonb;

COMMENT ON COLUMN public.quotes.bill_to_address IS
    'Immutable snapshot of the billing address block at quote issue time (Document Snapshot Standard). The rendered quote reads this, not the live billing_address_id row.';
COMMENT ON COLUMN public.quotes.ship_to_address IS
    'Immutable snapshot of the shipping address block at quote issue time.';
COMMENT ON COLUMN public.quotes.contact_snapshot IS
    'Immutable snapshot of the customer contact { name, email, phone } at quote issue time.';
COMMENT ON COLUMN public.quotes.customer_name IS
    'Immutable snapshot of the customer name at quote issue time.';
COMMENT ON COLUMN public.shipments.bill_to_address IS
    'Immutable snapshot of the bill-to address block at shipment/packing-slip issue time.';
COMMENT ON COLUMN public.shipments.ship_to_address IS
    'Immutable snapshot of the ship-to address block at shipment issue time.';

-- ============================================================
-- 2. Reusable snapshot expressions (used by the backfill below)
-- ============================================================
CREATE OR REPLACE FUNCTION public.address_block_snapshot(p_address_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT jsonb_build_object(
           'address_line1', a.address_line1,
           'address_line2', a.address_line2,
           'city',          a.city,
           'state',         a.state,
           'postal_code',   a.postal_code,
           'country',       a.country,
           'attention_to',  a.attention_to
         )
    FROM public.customer_addresses a
   WHERE a.id = p_address_id;
$function$;

CREATE OR REPLACE FUNCTION public.contact_block_snapshot(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT jsonb_build_object(
           'name',  c.name,
           'email', c.email,
           'phone', c.phone
         )
    FROM public.customer_contacts c
   WHERE c.id = p_contact_id;
$function$;

-- ============================================================
-- 3. Backfill existing rows (data-at-rest: every document that has an FK gets
--    its snapshot; no runtime "compute live if missing" fallback).
-- ============================================================
UPDATE public.quotes q
   SET customer_name    = c.name,
       bill_to_address  = public.address_block_snapshot(q.billing_address_id),
       ship_to_address  = public.address_block_snapshot(q.shipping_address_id),
       contact_snapshot = public.contact_block_snapshot(q.contact_id)
  FROM public.customers c
 WHERE q.customer_id = c.id;

UPDATE public.quotes q
   SET bill_to_address  = public.address_block_snapshot(q.billing_address_id),
       ship_to_address  = public.address_block_snapshot(q.shipping_address_id),
       contact_snapshot = public.contact_block_snapshot(q.contact_id)
 WHERE q.customer_id IS NULL;

UPDATE public.jobs j
   SET customer_name    = c.name,
       bill_to_address  = public.address_block_snapshot(j.billing_address_id),
       ship_to_address  = public.address_block_snapshot(j.shipping_address_id),
       contact_snapshot = public.contact_block_snapshot(j.contact_id)
  FROM public.customers c
 WHERE j.customer_id = c.id;

UPDATE public.jobs j
   SET bill_to_address  = public.address_block_snapshot(j.billing_address_id),
       ship_to_address  = public.address_block_snapshot(j.shipping_address_id),
       contact_snapshot = public.contact_block_snapshot(j.contact_id)
 WHERE j.customer_id IS NULL;

-- Shipments: ship-to is the shipment's own shipping_address_id; bill-to is the
-- customer's default-billing row at issue time (matches today's packing-slip render).
UPDATE public.shipments s
   SET customer_name   = c.name,
       ship_to_address = public.address_block_snapshot(s.shipping_address_id),
       bill_to_address = public.address_block_snapshot(
                           (SELECT a.id FROM public.customer_addresses a
                             WHERE a.customer_id = s.customer_id AND a.default_billing
                             LIMIT 1))
  FROM public.customers c
 WHERE s.customer_id = c.id;

-- ============================================================
-- 4. FK: RESTRICT -> SET NULL so an address can be deleted; snapshots preserve
--    history, the live FK simply nulls. (jobs.*_address_id already SET NULL.)
-- ============================================================
ALTER TABLE public.quotes
    DROP CONSTRAINT IF EXISTS quotes_billing_address_id_fkey,
    DROP CONSTRAINT IF EXISTS quotes_shipping_address_id_fkey;
ALTER TABLE public.quotes
    ADD CONSTRAINT quotes_billing_address_id_fkey
        FOREIGN KEY (billing_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
    ADD CONSTRAINT quotes_shipping_address_id_fkey
        FOREIGN KEY (shipping_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL;

-- Shipments: the ship-to snapshot is now the source of truth for the rendered
-- address, so the old "shipping_address_id XOR one_time_address" guarantee is no
-- longer needed (and would block SET NULL on address deletion). Drop it, then
-- flip the FK to SET NULL.
ALTER TABLE public.shipments
    DROP CONSTRAINT IF EXISTS shipments_one_address_source;
ALTER TABLE public.shipments
    DROP CONSTRAINT IF EXISTS shipments_shipping_address_id_fkey;
ALTER TABLE public.shipments
    ADD CONSTRAINT shipments_shipping_address_id_fkey
        FOREIGN KEY (shipping_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL;

GRANT ALL ON FUNCTION public.address_block_snapshot(uuid) TO anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.contact_block_snapshot(uuid) TO anon, authenticated, service_role;
