-- ============================================================================
-- inventory_on_hand_cost gains `last_moved_at`
-- ============================================================================
-- The Inventory table replaced its Heat column with "Updated". The heat was
-- redundant there -- the side rail breaks a part down by heat already, and a
-- column that could only ever show one of them made a part on three shelves
-- look like three unrelated things. What the list wants instead is when this
-- stock last changed, which is the question you ask of a row you are unsure
-- about.
--
-- `CREATE OR REPLACE VIEW` with the column APPENDED, so this applies to a
-- database that already carries 20260909152729 and to a fresh replay alike.
--
-- Everything else is unchanged from 20260909152729 and is repeated verbatim so
-- the two can be diffed line for line. See that file for why money may be
-- summed where quantity may not, why this is a view rather than an RPC, and
-- why the tier rule has two arms.

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
         END AS gap_reason,
         -- WHEN THIS STOCK LAST MOVED. Appended, never inserted: `CREATE OR REPLACE VIEW` refuses
         -- to reorder or rename existing columns, so the shape may only ever grow -- which is the
         -- guard you want on a view other code selects by name.
         --
         -- Derived from the ledger rather than stored. `part_location_stock` carries `created_at`
         -- and no `updated_at`, and adding one would mean a trigger writing a column every stock
         -- RPC would then have to keep honest on every path. The ledger already records each
         -- movement with its location and lot, so the answer is there to be read.
         --
         -- COALESCE to the balance's own `created_at`, and that is NOT a silent fallback for a
         -- data-at-rest gap: a row with no matching movement is one written directly (an import, a
         -- seed), and the moment that balance appeared genuinely IS when the stock last changed.
         -- Both branches are a real fact about the row rather than a guess standing in for one.
         COALESCE(
           (SELECT max(t.created_at)
              FROM public.inventory_transactions t
             WHERE t.part_id = pls.part_id
               AND t.location_id = pls.location_id
               AND t.lot_id IS NOT DISTINCT FROM pls.lot_id),
           pls.created_at
         ) AS last_moved_at
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
