-- ============================================================================
-- Shipments — PR 1: customer-address rename + shipping defaults groundwork
-- ============================================================================
--
-- Context. First PR of the Shipments v2 implementation
-- (see docs/modules/PRD-shipments-2.md). Bundles the rename of the
-- `is_billing`/`is_shipping` flags on customer_addresses to
-- `default_billing`/`default_shipping`, plus the schema groundwork that
-- subsequent PRs will populate from the UI.
--
-- Why the rename. The booleans aren't a type assertion on the address —
-- the address itself is just a postal address. They mark which row is the
-- DEFAULT billing/shipping address for this customer (at most one of each
-- per the partial unique indexes). Calling them `default_billing` /
-- `default_shipping` makes that intent legible from the schema. Deferring
-- the rename until later PRs would mean the new shipments code reads
-- against the misleading name; renaming once now is cheaper than living
-- with it forever.
--
-- What lands in this PR:
--   1. Rename customer_addresses.is_billing → default_billing
--   2. Rename customer_addresses.is_shipping → default_shipping
--   3. Rename the two partial unique indexes to match
--   4. Add customer_addresses.attention_to (free-text recipient/attn line)
--   5. Add customers.default_shipping_arrangement, .default_carrier,
--      .default_coc_text (per-customer shipping defaults; UI in PR 7)
--   6. Add companies.packing_slip_number_format, .packing_slip_seq_year,
--      .packing_slip_next_seq, .default_coc_text (per-company shipping
--      settings; UI in PR 7, sequence consumed by RPC in PR 4)
--
-- IDEMPOTENT. Every step uses IF [NOT] EXISTS / IF EXISTS guards so the
-- migration can be re-applied against partial state.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

-- ============================================================================
-- Phase 1: Rename customer_addresses default-role columns
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'customer_addresses'
           AND column_name = 'is_billing'
    ) THEN
        ALTER TABLE public.customer_addresses RENAME COLUMN is_billing TO default_billing;
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'customer_addresses'
           AND column_name = 'is_shipping'
    ) THEN
        ALTER TABLE public.customer_addresses RENAME COLUMN is_shipping TO default_shipping;
    END IF;
END $$;

COMMENT ON COLUMN public.customer_addresses.default_billing
    IS 'True when this row is the customer''s default billing address. At most one row per customer can be true (enforced by idx_customer_addresses_one_default_billing). The row''s postal data is still a postal address regardless of this flag.';

COMMENT ON COLUMN public.customer_addresses.default_shipping
    IS 'True when this row is the customer''s default shipping address. At most one row per customer can be true (enforced by idx_customer_addresses_one_default_shipping). Falls back to default_billing in product behavior when no row is default_shipping — see utils/customerAccess.ts pickShippingAddress.';


-- ============================================================================
-- Phase 2: Rename the partial unique indexes to match the new column names
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'idx_customer_addresses_one_billing'
    ) THEN
        ALTER INDEX public.idx_customer_addresses_one_billing
            RENAME TO idx_customer_addresses_one_default_billing;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = 'idx_customer_addresses_one_shipping'
    ) THEN
        ALTER INDEX public.idx_customer_addresses_one_shipping
            RENAME TO idx_customer_addresses_one_default_shipping;
    END IF;
END $$;


-- ============================================================================
-- Phase 3: customer_addresses.attention_to
-- ============================================================================
-- Free-text "ATTN:" recipient line that renders above the ship-to block on
-- packing slips. The shipment row also carries an optional
-- shipping_contact_id override (added in PR 4) that takes precedence over
-- this column when set; the derivation order is documented in
-- utils/shipmentsAccess.ts resolveAttentionLine.

ALTER TABLE public.customer_addresses
    ADD COLUMN IF NOT EXISTS attention_to text;

COMMENT ON COLUMN public.customer_addresses.attention_to
    IS 'Optional "ATTN:" recipient line that prints above the address on packing slips. The shipment row can override this with shipping_contact_id; see utils/shipmentsAccess.ts resolveAttentionLine.';


-- ============================================================================
-- Phase 4: customers shipping defaults
-- ============================================================================
-- Per-customer defaults prefilled onto the Create Shipment form (PR 4).
-- shipping_arrangement is constrained to the same enum used by
-- shipments.shipping_arrangement (added in PR 4); keeping the constraint
-- here means the defaults can't drift from what shipments will accept.
-- 'other' is allowed as a value with a free-text override on the shipment
-- row itself (shipments.shipping_arrangement_other) — there's no
-- companion override here because the default carries no override; pick a
-- canonical enum value or leave it null.

ALTER TABLE public.customers
    ADD COLUMN IF NOT EXISTS default_shipping_arrangement text,
    ADD COLUMN IF NOT EXISTS default_carrier text,
    ADD COLUMN IF NOT EXISTS default_coc_text text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints cc
          JOIN information_schema.constraint_table_usage ctu
            ON cc.constraint_name = ctu.constraint_name
           AND cc.constraint_schema = ctu.constraint_schema
         WHERE ctu.table_schema = 'public'
           AND ctu.table_name = 'customers'
           AND cc.constraint_name = 'customers_default_shipping_arrangement_check'
    ) THEN
        ALTER TABLE public.customers
            ADD CONSTRAINT customers_default_shipping_arrangement_check
            CHECK (default_shipping_arrangement IS NULL OR default_shipping_arrangement IN (
                'prepaid_and_add',
                'prepaid',
                'collect',
                'third_party_account',
                'customer_pickup',
                'customer_arranged_freight',
                'other'
            ));
    END IF;
END $$;

COMMENT ON COLUMN public.customers.default_shipping_arrangement
    IS 'Per-customer default shipping arrangement (freight terms). Same enum as shipments.shipping_arrangement. Prefilled onto the Create Shipment form. NULL when no default has been set.';

COMMENT ON COLUMN public.customers.default_carrier
    IS 'Per-customer default carrier name (free text — UPS, FedEx, customer''s freight provider, etc.). Prefilled onto the Create Shipment form.';

COMMENT ON COLUMN public.customers.default_coc_text
    IS 'Per-customer default Certificate of Conformance text block printed on the packing slip when the shipment does not override it. Cascade order: shipment.coc_text → customer.default_coc_text → company.default_coc_text → omit.';


-- ============================================================================
-- Phase 5: companies shipping settings
-- ============================================================================
-- packing_slip_number_format is the printf-style template used by
-- public.next_packing_slip_number() (added in PR 4). It accepts two
-- tokens:
--   {YYYY}     — substituted with the four-digit year of the ship date
--   {seq:N…N}  — substituted with the sequence number, zero-padded to the
--                number of zeros provided (e.g. {seq:0000} → 0042)
-- Both companies start with the default 'PS-{YYYY}-{seq:0000}'.
--
-- packing_slip_seq_year + packing_slip_next_seq carry the atomic counter
-- that next_packing_slip_number() advances under a row lock. They are
-- not displayed in the UI; only the format string is editable.
--
-- default_coc_text mirrors the customer-level field and is the
-- third/last step in the CoC cascade.

ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS packing_slip_number_format text
        NOT NULL DEFAULT 'PS-{YYYY}-{seq:0000}',
    ADD COLUMN IF NOT EXISTS packing_slip_seq_year integer,
    ADD COLUMN IF NOT EXISTS packing_slip_next_seq integer
        NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS default_coc_text text;

COMMENT ON COLUMN public.companies.packing_slip_number_format
    IS 'Template string for generated packing slip numbers. Tokens: {YYYY} = ship year, {seq:0000} = zero-padded sequence (zero count sets width). Default ''PS-{YYYY}-{seq:0000}''. Consumed by public.next_packing_slip_number() (PR 4).';

COMMENT ON COLUMN public.companies.packing_slip_seq_year
    IS 'Year of the most recent packing slip number issued. When the current year differs, next_packing_slip_number() resets the sequence to 1. Server-UTC; not customer-local.';

COMMENT ON COLUMN public.companies.packing_slip_next_seq
    IS 'Next sequence number to issue for a packing slip. Incremented atomically under a row lock by next_packing_slip_number(). Defaults to 1 for new companies; legacy-data backfill (PR 4) advances this past the synthetic-shipment count.';

COMMENT ON COLUMN public.companies.default_coc_text
    IS 'Shop-wide default Certificate of Conformance text. Last step in the cascade (shipment.coc_text → customer.default_coc_text → company.default_coc_text → omit).';


COMMIT;
