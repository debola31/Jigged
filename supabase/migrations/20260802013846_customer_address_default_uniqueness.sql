-- Make the one-default-address rule real.
--
-- customer_addresses.default_billing and .default_shipping have been documented
-- as "at most one row per customer can be true (enforced by
-- idx_customer_addresses_one_default_billing / _shipping)" since the baseline —
-- in the column COMMENTs, in utils/customerAddressesAccess.ts, and in
-- docs/modules/customers.md. Those two indexes have never existed. The rule was
-- enforced only by app code that clears the other rows first, so anything that
-- bypassed it — a concurrent save, an importer, a service-role script — could
-- leave a customer with two default billing addresses and nothing would notice.
--
-- What a second default actually does: pickBillingAddress returns the first row
-- matching default_billing, i.e. whichever PostgREST happened to return first,
-- so a quote silently bills to an arbitrary one of the two and can pick
-- differently on a later load. That is the failure mode this closes.
--
-- customer_addresses has no deleted_at (addresses are edited or removed, not
-- archived — unlike contacts, which gain one in the migration alongside this),
-- so the predicates need no liveness clause.

-- ---------------------------------------------------------------------------
-- 1. Backfill: keep the OLDEST default of each kind, clear the rest.
-- ---------------------------------------------------------------------------
-- Oldest wins because it is the one that has been in use longest and is
-- therefore the one already frozen onto existing quotes and jobs — clearing it
-- in favour of a newer row would make the live default disagree with what every
-- historical document was issued with. Both statements are no-ops on clean data.
WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY customer_id
               ORDER BY created_at, id
           ) AS rn
      FROM public.customer_addresses
     WHERE default_billing
)
UPDATE public.customer_addresses a
   SET default_billing = false,
       updated_at = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY customer_id
               ORDER BY created_at, id
           ) AS rn
      FROM public.customer_addresses
     WHERE default_shipping
)
UPDATE public.customer_addresses a
   SET default_shipping = false,
       updated_at = now()
  FROM ranked r
 WHERE a.id = r.id
   AND r.rn > 1;

-- ---------------------------------------------------------------------------
-- 2. The indexes the comments have been promising.
-- ---------------------------------------------------------------------------
-- Names match the ones already cited in the column COMMENTs, so the
-- documentation becomes true rather than needing a rewrite.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_addresses_one_default_billing
    ON public.customer_addresses (customer_id)
    WHERE default_billing;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_addresses_one_default_shipping
    ON public.customer_addresses (customer_id)
    WHERE default_shipping;
