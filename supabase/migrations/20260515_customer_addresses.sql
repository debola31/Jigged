-- Migration: Move customers from a single embedded address to a separate
-- customer_addresses table tagged with billing/shipping roles.
--
-- Why: customers (especially the larger ones that buy from a shop) often
-- ship to a different facility than the one that's billed. The flat
-- address_line1/.../country columns on customers cannot model that. The
-- new table lets a customer carry many addresses, each tagged as billing,
-- shipping, or both, with one default per role.
--
-- Clean-break per CLAUDE.md "no silent runtime fallbacks for data-at-rest
-- issues": this migration creates the new table, backfills every existing
-- customer's flat-column data into it, then drops the flat columns. After
-- this migration there is exactly one source of truth for customer
-- addresses.
--
-- Backfill rule: for each customer with any non-null address field today,
-- insert one customer_addresses row labelled 'Primary', tagged both
-- billing+shipping, marked default for both. Customers with no address on
-- record produce no rows — their quote PDFs already render blank BILL TO
-- blocks today, and this migration preserves that.
--
-- Read path post-migration: utils/customerAccess.ts exposes
-- pickDefaultBilling()/pickDefaultShipping() helpers. The "ship-to falls
-- back to bill-to when no shipping address exists" rule is documented
-- product behavior implemented in exactly one place — not a silent
-- compatibility layer.

BEGIN;

CREATE TABLE public.customer_addresses (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    label text,
    address_line1 text,
    address_line2 text,
    city text,
    state text,
    postal_code text,
    country text DEFAULT 'USA',
    is_billing boolean NOT NULL DEFAULT false,
    is_shipping boolean NOT NULL DEFAULT false,
    is_default_billing boolean NOT NULL DEFAULT false,
    is_default_shipping boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- An address that's marked default-for-a-role must actually have that role.
    CONSTRAINT customer_addresses_default_billing_implies_billing
        CHECK (NOT is_default_billing OR is_billing),
    CONSTRAINT customer_addresses_default_shipping_implies_shipping
        CHECK (NOT is_default_shipping OR is_shipping),
    -- An address must serve at least one role.
    CONSTRAINT customer_addresses_has_a_role
        CHECK (is_billing OR is_shipping)
);

-- At most one default-billing and one default-shipping per customer.
CREATE UNIQUE INDEX idx_customer_addresses_one_default_billing
    ON public.customer_addresses(customer_id) WHERE is_default_billing;
CREATE UNIQUE INDEX idx_customer_addresses_one_default_shipping
    ON public.customer_addresses(customer_id) WHERE is_default_shipping;

CREATE INDEX idx_customer_addresses_customer
    ON public.customer_addresses(customer_id);

-- RLS: company members can manage addresses of customers in their company.
ALTER TABLE public.customer_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company members manage their customer addresses"
    ON public.customer_addresses FOR ALL
    USING (
        EXISTS (
            SELECT 1
            FROM public.customers c
            JOIN public.user_company_access uca
                ON uca.company_id = c.company_id
            WHERE c.id = customer_addresses.customer_id
              AND uca.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM public.customers c
            JOIN public.user_company_access uca
                ON uca.company_id = c.company_id
            WHERE c.id = customer_addresses.customer_id
              AND uca.user_id = auth.uid()
        )
    );

-- Backfill: one row per existing customer that has any address content.
INSERT INTO public.customer_addresses (
    customer_id, label,
    address_line1, address_line2, city, state, postal_code, country,
    is_billing, is_shipping, is_default_billing, is_default_shipping
)
SELECT
    id, 'Primary',
    address_line1, address_line2, city, state, postal_code, country,
    true, true, true, true
FROM public.customers
WHERE COALESCE(
    address_line1, address_line2, city, state, postal_code
) IS NOT NULL;

-- Drop the embedded columns. Single source of truth from here on.
ALTER TABLE public.customers
    DROP COLUMN address_line1,
    DROP COLUMN address_line2,
    DROP COLUMN city,
    DROP COLUMN state,
    DROP COLUMN postal_code,
    DROP COLUMN country;

COMMIT;
