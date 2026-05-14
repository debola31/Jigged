-- Migration: relax customer_addresses constraints applied in
-- 20260515_customer_addresses.sql.
--
-- Why: that migration was applied with two constraints we've since decided
-- against — every row must serve a role, and every row carries a label.
-- Both turned out to be friction in the form (a user wants to keep an
-- address on file without designating Billing or Shipping; the label
-- adds clutter without earning its keep). We edited the original
-- migration file but applied DBs still carry the old shape, hence this
-- follow-up.
--
-- Idempotent via IF EXISTS — safe to re-run against a DB that was
-- never on the constrained version.

BEGIN;

ALTER TABLE public.customer_addresses
    DROP CONSTRAINT IF EXISTS customer_addresses_has_a_role;

ALTER TABLE public.customer_addresses
    DROP COLUMN IF EXISTS label;

COMMIT;
