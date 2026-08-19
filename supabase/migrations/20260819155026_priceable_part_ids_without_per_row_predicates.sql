-- ═══════════════════════════════════════════════════════════════════════════════
-- The parts list stopped answering, and answered "incomplete" instead
-- ═══════════════════════════════════════════════════════════════════════════════
-- On 2026-08-19 every part at the pilot shop rendered ⚠ Incomplete. Nothing was
-- wrong with the parts. `get_priceable_part_ids` was exceeding the 8s
-- `authenticated` statement_timeout, PostgREST returned 500 with SQLSTATE 57014,
-- and the browser turned that into an empty set — so "we could not check" was
-- drawn as "none of these can be quoted". The read path is fixed separately;
-- this migration removes the reason the query was slow.
--
-- ## Where the time went
--
-- The fixed point re-derived, on EVERY iteration, three facts that cannot change
-- between iterations:
--
--   1. `public.part_has_cost_basis(p.id)` — a `LANGUAGE sql` function carrying a
--      `SET search_path` clause. A SET clause makes a SQL function permanently
--      NON-INLINABLE: the planner cannot fold its body into the surrounding
--      query, so it stays a per-row function call with its own executor setup,
--      running a CASE over two correlated subqueries. Once per made part, per
--      iteration.
--   2. Whether any routing operation is unpriced or untimed.
--   3. Whether any BOM line charges a child at price without that child carrying
--      a markup tier.
--
-- Only the fourth condition — are this part's BOM children costable YET — is
-- what the loop is actually iterating toward. So the loop paid depth × parts for
-- work whose answer was fixed before it started. At seed scale (18 parts) this is
-- invisible; a real catalogue with a routed, BOM'd item master crosses 8s.
--
-- ## What changed
--
-- The three invariants are computed ONCE, into `v_ready`, before the loop. The
-- loop then does the only thing it needs to: grow the costable set until it stops
-- growing. Splitting them out is sound because the original tested them inside a
-- single `NOT EXISTS (A OR B)` over parts_bom, and
--     NOT EXISTS (A OR B)  ≡  NOT EXISTS (A) AND NOT EXISTS (B)
-- so the price-basis half (invariant) hoists out and the child-costable half
-- (iterative) stays. The verdict is unchanged for every input — that is the
-- point, and `api/tests/integration/test_priceability_agreement.py` is what holds
-- it to that.
--
-- ## On duplicating part_has_cost_basis
--
-- `part_has_cost_basis` remains the scalar definition and remains what
-- `compute_part_cost_explain` (the DETAIL view) calls — there it runs once per
-- request, where a non-inlinable call costs nothing worth restructuring for.
-- This function now expresses the same rule set-based, because a per-row call is
-- exactly what it cannot afford. That is a deliberate second expression of one
-- rule, and the thing that stops the two drifting is the agreement test above,
-- which asserts list and detail return the same verdict across the full matrix.
-- Change the rule in one place and that test fails — which is the intended
-- tripwire. Do not "simplify" this back to a per-row call.

CREATE OR REPLACE FUNCTION public.get_priceable_part_ids(p_company_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_costable  uuid[];
    v_ready     uuid[];
    v_priceable uuid[];
    v_new       uuid[];
BEGIN
    -- COSTABLE base case: bought parts whose purchase price is on file. This is
    -- part_has_cost_basis's 'bought' arm, expressed set-based.
    SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
    INTO v_costable
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'bought'
      AND EXISTS (
          SELECT 1
            FROM public.part_procurement_tiers t
           WHERE t.part_id = p.id
             AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
      );

    -- Everything true of a made part REGARDLESS of what is costable yet. Computed
    -- once; the loop below never re-derives it.
    SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
    INTO v_ready
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'made'
      -- part_has_cost_basis's 'made' arm: work, materials, or both. Neither means
      -- there is no basis, NOT that the part is free.
      AND (
          EXISTS (
              SELECT 1
                FROM public.routings r
                JOIN public.routing_operations ro ON ro.routing_id = r.id
               WHERE r.part_id = p.id
          )
          OR EXISTS (
              SELECT 1 FROM public.parts_bom b WHERE b.parent_part_id = p.id
          )
      )
      -- Every routing op must have full pricing.
      AND NOT EXISTS (
          SELECT 1
            FROM public.routings r
            JOIN public.routing_operations ro ON ro.routing_id = r.id
            JOIN public.work_centers wc ON wc.id = ro.work_center_id
           WHERE r.part_id = p.id
             AND (
                 -- Nobody said what an hour on this station costs.
                 (wc.kind = 'internal'
                     AND ro.labor_rate_override IS NULL
                     AND wc.labor_rate IS NULL)
                 -- Or nobody said how long it takes. A rate with no time multiplies
                 -- out to zero, and zero is a PRICE — it reads as "this operation is
                 -- free" rather than "we have not costed this yet".
                 OR (wc.kind = 'internal'
                     AND ro.setup_minutes IS NULL
                     AND ro.cycle_minutes_per_unit IS NULL)
                 -- An outside process is a price per unit, and its absence is the
                 -- same silence.
                 OR (wc.kind <> 'internal'
                     AND ro.external_unit_price IS NULL)
             )
      )
      -- A BOM line that charges its child at PRICE needs that child to carry its
      -- own markup tier. Nothing covers for a missing one. (Invariant half of the
      -- original combined NOT EXISTS.)
      AND NOT EXISTS (
          SELECT 1
            FROM public.parts_bom b
           WHERE b.parent_part_id = p.id
             AND b.charge_basis = 'price'
             AND NOT EXISTS (
                 SELECT 1
                   FROM public.part_pricing_tiers t
                  WHERE t.part_id = b.child_part_id
                    AND t.markup_percent IS NOT NULL
             )
      );

    -- Fixed point over the BOM DAG (parts_bom_no_cycles guarantees a DAG, so this
    -- terminates in at most BOM-depth iterations): a ready part becomes costable
    -- once every child it consumes is costable.
    LOOP
        SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[])
        INTO v_new
        FROM unnest(v_ready) AS r(id)
        WHERE NOT (r.id = ANY(v_costable))
          AND NOT EXISTS (
              SELECT 1
                FROM public.parts_bom b
               WHERE b.parent_part_id = r.id
                 AND NOT (b.child_part_id = ANY(v_costable))
          );

        EXIT WHEN cardinality(v_new) = 0;
        v_costable := v_costable || v_new;
    END LOOP;

    -- PRICEABLE = costable AND has its own non-null-markup pricing tier. Only the
    -- part being sold needs a markup of its own; its materials need one only when
    -- a line charges them at price (handled in v_ready above).
    SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
    INTO v_priceable
    FROM public.parts p
    WHERE p.id = ANY(v_costable)
      AND EXISTS (
          SELECT 1
            FROM public.part_pricing_tiers t
           WHERE t.part_id = p.id
             AND t.markup_percent IS NOT NULL
      );

    RETURN v_priceable;
END;
$function$;

COMMENT ON FUNCTION public.get_priceable_part_ids(uuid) IS
  'Ids of every part in a company that is ready to quote: its cost resolves (bought = a non-expired procurement tier; made = a cost basis, every routing op priced and timed, and every BOM child costable) AND the part itself carries a markup tier. Enforces the identical structural rule as compute_part_cost_explain.is_priceable, so the parts list and the part detail page can never disagree — locked by test_priceability_agreement.py. The per-part invariants (cost basis, op pricing, price-basis child markups) are evaluated ONCE into v_ready rather than on every pass of the fixed point; doing them per-pass via the non-inlinable part_has_cost_basis is what pushed this past the 8s statement timeout on a real catalogue and made the list render every part as Incomplete.';
