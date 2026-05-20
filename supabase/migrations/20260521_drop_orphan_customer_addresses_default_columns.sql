-- ============================================================================
-- Drop orphan is_default_billing / is_default_shipping columns + CHECK
-- constraints from customer_addresses.
-- ============================================================================
--
-- Context. The staging database carries four boolean columns on
-- customer_addresses where there should only be two:
--   default_billing, default_shipping,
--   is_default_billing, is_default_shipping
-- The `is_default_*` pair plus their _implies_ CHECK constraints are not
-- produced by any migration in supabase/migrations/. They appear to have
-- been added out-of-band (likely via Supabase Studio) before the column
-- rename in 20260519_shipments_pr1_customer_addresses.sql.
--
-- Symptom. utils/customerAddressesAccess.ts.clearDefaultShippingForCustomer
-- sets default_shipping = false on existing rows before flipping a new
-- row to default_shipping. When the existing row carries
-- is_default_shipping = true (from whatever populated it), the CHECK
-- constraint
--   customer_addresses_default_shipping_implies_shipping:
--     (NOT is_default_shipping) OR default_shipping
-- becomes false ∨ false → false, and the UPDATE fails with 23514.
-- Same shape for billing.
--
-- Fix. Drop the duplicates outright. The implies-constraint guarantees
-- that wherever is_default_X = true, default_X is also true; the
-- `default_*` columns already carry the truth, and code only reads/writes
-- those. Dropping the orphans loses no information.
--
-- IDEMPOTENT. Every step uses IF EXISTS so the migration can re-apply
-- against a DB where the cleanup has already happened.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

ALTER TABLE public.customer_addresses
    DROP CONSTRAINT IF EXISTS customer_addresses_default_billing_implies_billing;

ALTER TABLE public.customer_addresses
    DROP CONSTRAINT IF EXISTS customer_addresses_default_shipping_implies_shipping;

ALTER TABLE public.customer_addresses
    DROP COLUMN IF EXISTS is_default_billing;

ALTER TABLE public.customer_addresses
    DROP COLUMN IF EXISTS is_default_shipping;

COMMIT;
