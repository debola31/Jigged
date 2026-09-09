-- ============================================================================
-- inventory_on_hand_cost: what is on the shelves, and what it cost us
-- ============================================================================
-- The Storage page gains an Inventory tab: a table of every balance, with the
-- part's own cost against it and a total at the foot. Until now an owner could
-- not ask anywhere how much material is sitting in the building, and the answer
-- is a number the shop already owns -- on hand x its own cost tier.
--
-- WHAT THIS WITHDRAWS. docs/modules/inventory.md:168 lists "Valuation / COGS /
-- postings" as an explicit non-goal, on the ground that QuickBooks owns money
-- and Jigged tracks quantities and identity. That is withdrawn FOR THE READ
-- ONLY. Every WRITE stays a non-goal: no COGS posting, no journal entry, no
-- cost layer (FIFO / LIFO / average), no landed or standard cost, and no second
-- place a cost is stored. Nothing here writes anything.
--
-- WHY MONEY MAY BE SUMMED WHERE QUANTITY MAY NOT. utils/locationOccupancy.ts
-- and 20260729205302 both refuse a quantity roll-up, and that refusal stands:
-- `primary_unit` is per part, `parts_unit_conversions` converts only WITHIN one
-- part, and nothing relates one part's unit to another's -- so 40 bearings + 3
-- castings + 200 inches of bar is a number with no dimension. `cost_per_unit`
-- is dollars per THAT PART'S OWN unit, so multiplying by the balance carries
-- every row out of its own unit into one they all share. The multiplication IS
-- the unit conversion, and it is the only one the schema owns.
--
-- The ban on a fill percentage (UnitGridView.tsx) is untouched and rests on
-- something else entirely: a percentage needs a DENOMINATOR, and
-- inventory_locations has no capacity column, so "72% full" invents one. This
-- invents nothing -- every factor is a number a human typed. The rule to carry
-- forward is that we refuse numbers whose inputs we do not have, not numbers
-- that are aggregates.
--
-- WHY A VIEW AND NOT AN RPC. There is no write, no atomicity requirement and no
-- cross-tenant work, so a SECURITY DEFINER function would buy nothing and cost
-- the full REVOKE/GRANT block plus an entry in function_execute_leaks(). More
-- importantly the money gate must NOT live in SQL: docs/modules/dashboard.md
-- is explicit that it is a display choice and not a security boundary, and
-- part_pricing_tiers already grants SELECT to `authenticated` under a
-- company-scoped policy, so costs are readable through PostgREST by anyone who
-- can reach the company. An is_company_admin() check inside a definer function
-- would make the flag LOOK like access control, which is the exact misreading
-- dashboard.md spends three paragraphs preventing.
--
-- WHY THE TOTAL IS NOT A SECOND VIEW. The table filters -- by place, and by
-- "show me the ones with no cost" -- and the footer has to describe the rows
-- above it, not the shop. A server-side aggregate cannot follow a client-side
-- filter without a round trip per keystroke, so the browser sums whatever is
-- showing. That is only safe because this view's grain is one row per BALANCE:
-- the reader pages the whole set past supabase/config.toml's `max_rows = 1000`
-- and refuses to print a total at all if it ever hits its ceiling, rather than
-- printing a short one.
--
-- security_invoker: runs with the CALLER's permissions, so the existing
-- company-scoped SELECT policies on part_location_stock, parts, material_lots,
-- inventory_locations and part_pricing_tiers all apply and this needs no policy
-- of its own. No billing write gate: tenant_tables_missing_write_gate() filters
-- relkind = 'r', so a view is invisible to it and has nothing to write to.

CREATE OR REPLACE VIEW public.inventory_on_hand_cost
WITH (security_invoker = true) AS
  WITH part_on_hand AS (
    -- What the shop holds of each part, ACROSS every place.
    --
    -- The tier is chosen at this total, not at each balance, and that is
    -- deliberate: choosing per balance would give the same bar two different
    -- unit costs on two shelves, which reads as a bug, and would stop a
    -- filtered total being the sum of its rows.
    SELECT pls.company_id,
           pls.part_id,
           sum(pls.quantity) AS total_quantity
      FROM public.part_location_stock pls
      JOIN public.parts p ON p.id = pls.part_id
     WHERE p.deleted_at IS NULL          -- archived parts are not stock on a shelf
     GROUP BY pls.company_id, pls.part_id
  ),
  part_cost AS (
    -- THE CANONICAL TIER RULE, AND IT HAS TWO ARMS.
    --
    -- Mirrors part_rollup_at_qty's bought arm (20260906182521) and resolveTier
    -- (utils/quotePricingResolver.ts) line for line, so the three can be
    -- diffed. Taking only the first arm would report every part held below its
    -- smallest break as having no cost -- manufacturing gaps out of ordinary
    -- data, which is worse than no total at all.
    SELECT poh.company_id,
           poh.part_id,
           poh.total_quantity,
           COALESCE(tier.at_break, tier.at_floor) AS cost_per_unit,
           -- Costed at the LOWEST break because we hold fewer than the smallest
           -- one. An honest caveat, not a gap.
           (tier.at_break IS NULL AND tier.at_floor IS NOT NULL) AS cost_below_min
      FROM part_on_hand poh
      CROSS JOIN LATERAL (
        SELECT
          -- Highest break <= what we hold.
          (SELECT t.cost_per_unit
             FROM public.part_pricing_tiers t
            WHERE t.part_id = poh.part_id
              AND t.cost_per_unit IS NOT NULL
              AND t.quantity <= poh.total_quantity
            ORDER BY t.quantity DESC
            LIMIT 1) AS at_break,
          -- Below every break: floor to the lowest, so the part is still costable.
          (SELECT t.cost_per_unit
             FROM public.part_pricing_tiers t
            WHERE t.part_id = poh.part_id
              AND t.cost_per_unit IS NOT NULL
            ORDER BY t.quantity ASC
            LIMIT 1) AS at_floor
      ) tier
  )
  SELECT pls.company_id,
         pls.id                AS balance_id,
         pls.part_id,
         p.part_name,
         p.primary_unit,
         p.source,
         pls.location_id,
         loc.name              AS location_name,
         pls.lot_id,
         lot.lot_code,
         lot.heat_number,
         pls.quantity,
         pc.total_quantity     AS part_total_quantity,
         pc.cost_per_unit,
         pc.cost_below_min,
         -- Rounded to the cent HERE so the browser's footer sums exactly the
         -- numbers the table prints. Rounding at display and summing unrounded
         -- is how a total stops matching the rows above it.
         round(pls.quantity * pc.cost_per_unit, 2) AS on_hand_cost,
         -- WHY there is no cost, never a silent zero.
         --
         -- 'made' is not a data-quality complaint: cost_per_unit is NULL for a
         -- made part BY DESIGN (20260906182521), its cost being the routing +
         -- BOM rollup rather than a purchase tier. Collapsing the two into one
         -- "uncosted" count would accuse a shop of not filling in a field that
         -- does not exist for that part.
         CASE
           WHEN pc.cost_per_unit IS NOT NULL THEN NULL
           WHEN p.source = 'made' THEN 'made'
           ELSE 'no_cost_tier'
         END AS gap_reason
    FROM public.part_location_stock pls
    JOIN public.parts p ON p.id = pls.part_id
    JOIN part_cost pc ON pc.part_id = pls.part_id AND pc.company_id = pls.company_id
    JOIN public.inventory_locations loc ON loc.id = pls.location_id
    LEFT JOIN public.material_lots lot ON lot.id = pls.lot_id
   WHERE p.deleted_at IS NULL;
   -- No `quantity > 0` filter, and that is not an omission: 20260802144310 added
   -- CHECK (quantity > 0) and deletes emptied rows, so a row existing and the
   -- material being there are the same fact. Filtering would restate the
   -- constraint and hide it if the constraint ever moved.
   --
   -- No `lot.deleted_at IS NULL` either: this is a BY-ID join from a live
   -- balance, and a balance whose lot was archived is still material on a shelf.
   -- Dropping it would make stock disappear from the table while remaining in
   -- the bin, which is the one thing a stock list may never do.

COMMENT ON VIEW public.inventory_on_hand_cost IS
  'One row per balance -- (part, place, lot) -- with what the part cost us at the tier its TOTAL '
  'on-hand quantity lands on: highest break <= quantity, floored to the lowest break when the shop '
  'holds fewer than the smallest one. The tier is chosen at the part total, not per balance, so one '
  'bar cannot show two unit costs on two shelves. cost_per_unit NULL is a GAP with a named reason in '
  'gap_reason (''made'' = cost lives in the routing rollup by design; ''no_cost_tier'' = nobody has '
  'recorded one), NEVER a zero. Carries no quantity sum across parts and no fill percentage.';

-- No `anon` grant: never read logged out.
-- No billing write-gate: relkind = 'r' only, and a view has nothing to write to.
-- No jigged_ai_readonly grant: the insights AI reaches the same facts through the
-- underlying tables, and a view it cannot see cannot drift from them.
GRANT SELECT ON public.inventory_on_hand_cost TO authenticated;
GRANT SELECT ON public.inventory_on_hand_cost TO service_role;
