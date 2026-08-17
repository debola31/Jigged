-- One rule for "can this part be costed", in one place.
--
-- THE BUG. A MADE part with no routing operations and no BOM children rolled up
-- to 0 and was flagged by nothing: `missing_leaves` only ever looked at BOUGHT
-- leaves, and `missing_op_rates` only looked at made parts that HAVE a routing.
-- So an empty made part read as a real cost of zero, and `is_priceable` stayed
-- true. Measured in production before this migration: 3,300 live parts across two
-- companies in exactly that state, every one of them reporting "ready to quote"
-- and computing a unit price of $0.00. None had ever been quoted, which is the
-- only reason it had not yet put a zero on a customer's paperwork.
--
-- THE DUPLICATION. The rule was written twice — once as a per-part recursive walk
-- (compute_part_cost_explain, the detail page) and once as a company-wide
-- fixed point (get_priceable_part_ids, the parts list). Both said in a COMMENT
-- that they matched the other, and an integration test checked that they did.
-- A comment is not an implementation and a test is a detector, not a preventer.
--
-- THE FIX. Extract the predicate — not the traversal — into one function both
-- call. The two traversals stay separate on purpose: the list view loads
-- priceability for every part at once, so evaluating a recursive per-part walk N
-- times would be a hot-path regression. What drifts is the predicate, and that is
-- what is now single-sourced.

CREATE OR REPLACE FUNCTION public.part_has_cost_basis(p_part_id uuid)
RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT CASE (SELECT p.source FROM public.parts p WHERE p.id = p_part_id)
        -- Bought: something has to say what it costs to buy.
        WHEN 'bought' THEN EXISTS (
            SELECT 1
              FROM public.part_procurement_tiers t
             WHERE t.part_id = p_part_id
               AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
        )
        -- Made: something has to say what it costs to make — work, materials, or
        -- both. Neither means there is no basis, NOT that the part is free.
        WHEN 'made' THEN (
            EXISTS (
                SELECT 1
                  FROM public.routings r
                  JOIN public.routing_operations ro ON ro.routing_id = r.id
                 WHERE r.part_id = p_part_id
            )
            OR EXISTS (
                SELECT 1 FROM public.parts_bom b WHERE b.parent_part_id = p_part_id
            )
        )
        ELSE false
    END;
$$;

COMMENT ON FUNCTION public.part_has_cost_basis(uuid) IS
  'Does this part have anything to compute a cost FROM? Bought: a non-expired procurement tier. Made: at least one routing operation or one BOM child. Single source of truth shared by compute_part_cost_explain (detail view) and get_priceable_part_ids (list view) so the two cannot drift. A made part with neither is not free — it has no basis, and rolling it up as 0 is what this replaced.';

-- `authenticated` MUST be able to execute this, and the reason is worth stating
-- because the instinct is to lock a helper down.
--
-- `get_priceable_part_ids` is SECURITY INVOKER — it carries no DEFINER — and the
-- parts list calls it by RPC from the browser. So it runs AS the signed-in user,
-- and that user needs EXECUTE on everything it calls. The CLAUDE.md exemption for
-- "helpers called only from a SECURITY DEFINER parent" does not apply: there is no
-- definer in this chain. Revoking from `authenticated` fails the parts list with a
-- bare 42501 whose only clue is the function name.
--
-- Granting it leaks nothing. The function is SECURITY INVOKER too, so every table
-- it touches is still filtered by that user's RLS: asked about a part in another
-- tenant it sees no rows and answers false, which is what a caller could already
-- infer. `anon` gets nothing — the parts list is behind a session.
REVOKE EXECUTE ON FUNCTION public.part_has_cost_basis(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.part_has_cost_basis(uuid) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.part_has_cost_basis(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Detail view — now flags a made part with no cost basis, not just bought leaves.
-- CREATE OR REPLACE (never DROP): a DROP would destroy the ACL and the COMMENT.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_part_cost_explain(p_part_id uuid, p_qty numeric)
RETURNS TABLE(
    unit_cost        numeric,
    missing_leaves   jsonb,
    missing_markups  jsonb,
    missing_op_rates jsonb,
    is_priceable     boolean
)
    LANGUAGE plpgsql
    STABLE
    AS $$
DECLARE
    v_missing_leaves   jsonb;
    v_missing_markups  jsonb;
    v_missing_op_rates jsonb;
    v_unit_cost        numeric;
BEGIN
    WITH RECURSIVE tree(part_id, part_name, source, cumulative_qty, depth, charged_at_price) AS (
        SELECT p.id, p.part_name, p.source, p_qty, 0, false
          FROM public.parts p
         WHERE p.id = p_part_id

        UNION ALL

        SELECT c.id,
               c.part_name,
               c.source,
               CASE
                   -- Made child: value its subtree at its standard costing lot
                   -- size (fixed, not the cascaded consumed qty).
                   WHEN c.source = 'made' THEN
                       c.costing_batch_quantity
                   -- Bought whole-unit line: ceiling the cascaded consumption.
                   WHEN b.consume_whole_units THEN
                       ceil(
                           t.cumulative_qty *
                           CASE
                               WHEN b.unit IS DISTINCT FROM c.primary_unit THEN
                                   b.quantity * COALESCE(
                                       (SELECT uc.to_primary_factor
                                          FROM public.parts_unit_conversions uc
                                         WHERE uc.part_id = c.id
                                           AND uc.from_unit = b.unit),
                                       1
                                   )
                               ELSE b.quantity
                           END
                       )
                   -- Bought fractional cascade.
                   ELSE
                       t.cumulative_qty *
                       CASE
                           WHEN b.unit IS DISTINCT FROM c.primary_unit THEN
                               b.quantity * COALESCE(
                                   (SELECT uc.to_primary_factor
                                      FROM public.parts_unit_conversions uc
                                     WHERE uc.part_id = c.id
                                       AND uc.from_unit = b.unit),
                                   1
                               )
                           ELSE b.quantity
                       END
               END,
               t.depth + 1,
               -- Is THIS node charged into its parent at price? Per-edge, so the
               -- same part can be cost-charged in one BOM and price-charged in
               -- another.
               b.charge_basis = 'price'
          FROM tree t
          JOIN public.parts_bom b ON b.parent_part_id = t.part_id
          JOIN public.parts c     ON c.id = b.child_part_id
         WHERE t.source = 'made'
           AND t.depth < 50
    ),
    -- A leaf is "missing" when it has NO COST BASIS AT ALL. Shared with
    -- get_priceable_part_ids via public.part_has_cost_basis so the rule cannot
    -- drift between the detail view and the list view.
    leaves AS (
        SELECT tr.part_id, tr.part_name, tr.depth, tr.cumulative_qty AS qty_required
          FROM tree tr
         WHERE NOT public.part_has_cost_basis(tr.part_id)
    ),
    -- Markup is needed by the ROOT (the part being quoted) and by any child
    -- CHARGED AT PRICE — its markup is what the parent pays, and there is no
    -- shop-wide fallback to cover for a missing tier.
    markups AS (
        SELECT tr.part_id, tr.part_name, tr.source, MIN(tr.depth) AS depth
          FROM tree tr
         WHERE (tr.depth = 0 OR tr.charged_at_price)
           AND NOT EXISTS (
                   SELECT 1 FROM public.part_pricing_tiers pt
                    WHERE pt.part_id = tr.part_id
                      AND pt.markup_percent IS NOT NULL
               )
         GROUP BY tr.part_id, tr.part_name, tr.source
    ),
    op_rates AS (
        SELECT tr.part_id, tr.part_name, MIN(tr.depth) AS depth
          FROM tree tr
          JOIN public.routings r            ON r.part_id = tr.part_id
          JOIN public.routing_operations ro ON ro.routing_id = r.id
          JOIN public.work_centers wc       ON wc.id = ro.work_center_id
         WHERE tr.source = 'made'
           AND (
               (wc.kind = 'internal'
                   AND ro.labor_rate_override IS NULL
                   AND wc.labor_rate IS NULL)
               OR
               (wc.kind <> 'internal'
                   AND ro.external_unit_price IS NULL)
           )
         GROUP BY tr.part_id, tr.part_name
    )
    SELECT
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',      l.part_id,
                            'part_name',    l.part_name,
                            'depth',        l.depth,
                            'qty_required', l.qty_required
                        )
                        ORDER BY l.depth DESC, l.part_name ASC
                    ), '[]'::jsonb)
           FROM leaves l),
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',   m.part_id,
                            'part_name', m.part_name,
                            'depth',     m.depth,
                            'source',    m.source
                        )
                        ORDER BY m.depth ASC, m.part_name ASC
                    ), '[]'::jsonb)
           FROM markups m),
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',   o.part_id,
                            'part_name', o.part_name,
                            'depth',     o.depth
                        )
                        ORDER BY o.depth ASC, o.part_name ASC
                    ), '[]'::jsonb)
           FROM op_rates o)
      INTO v_missing_leaves, v_missing_markups, v_missing_op_rates;

    BEGIN
        v_unit_cost := public.compute_part_cost_at_qty(p_part_id, p_qty);
    EXCEPTION WHEN OTHERS THEN
        v_unit_cost := NULL;
    END;

    unit_cost        := v_unit_cost;
    missing_leaves   := v_missing_leaves;
    missing_markups  := v_missing_markups;
    missing_op_rates := v_missing_op_rates;
    is_priceable     := (v_missing_leaves = '[]'::jsonb
                         AND v_missing_markups = '[]'::jsonb
                         AND v_missing_op_rates = '[]'::jsonb);
    RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.compute_part_cost_explain(uuid, numeric) IS
  'TRUE unit cost (charge bases ignored) plus the three structural gap arrays: parts with NO COST BASIS (bought with no procurement tier, or made with neither operations nor BOM), parts that need a markup and lack one, and routing ops with no rate. A part needs a markup when it is the ROOT being quoted or when a BOM line charges it AT PRICE. is_priceable is the AND of the three arrays being empty, and matches get_priceable_part_ids — now by construction, since both share public.part_has_cost_basis.';

-- ---------------------------------------------------------------------------
-- List view — same predicate, in both the bought base case and the made loop.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_priceable_part_ids(p_company_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_costable uuid[];
    v_priceable uuid[];
    v_new uuid[];
BEGIN
    -- COSTABLE — a part whose cost resolves. Markup is NOT required here unless a
    -- BOM line charges the child at price (below). Base case: bought parts with a
    -- non-expired procurement tier.
    SELECT COALESCE(array_agg(DISTINCT p.id), ARRAY[]::uuid[])
    INTO v_costable
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'bought'
      AND public.part_has_cost_basis(p.id);

    -- Fixed-point: add made parts whose routing is complete and whose BOM
    -- children (if any) are all already costable. Bounded by BOM depth.
    LOOP
        SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
        INTO v_new
        FROM public.parts p
        WHERE p.company_id = p_company_id
          AND p.source = 'made'
          AND NOT (p.id = ANY(v_costable))
          -- A made part with no operations AND no BOM is not "free" — it has no
          -- cost basis. Same predicate the detail view uses.
          AND public.part_has_cost_basis(p.id)
          -- Every routing op (if any) must have full pricing.
          AND NOT EXISTS (
              SELECT 1
              FROM public.routings r
              JOIN public.routing_operations ro ON ro.routing_id = r.id
              JOIN public.work_centers wc ON wc.id = ro.work_center_id
              WHERE r.part_id = p.id
                AND (
                    (wc.kind = 'internal'
                        AND ro.labor_rate_override IS NULL
                        AND wc.labor_rate IS NULL)
                    OR
                    (wc.kind <> 'internal'
                        AND ro.external_unit_price IS NULL)
                )
          )
          -- Every BOM child must already be costable — AND, when the line charges
          -- it at price, must carry its own markup tier. Nothing covers for a
          -- missing one.
          AND NOT EXISTS (
              SELECT 1
              FROM public.parts_bom b
              WHERE b.parent_part_id = p.id
                AND (
                    NOT (b.child_part_id = ANY(v_costable))
                    OR (
                        b.charge_basis = 'price'
                        AND NOT EXISTS (
                            SELECT 1
                            FROM public.part_pricing_tiers t
                            WHERE t.part_id = b.child_part_id
                              AND t.markup_percent IS NOT NULL
                        )
                    )
                )
          );

        EXIT WHEN cardinality(v_new) = 0;
        v_costable := v_costable || v_new;
    END LOOP;

    -- PRICEABLE = costable AND has its own non-null-markup pricing tier. Only the
    -- part being sold needs a markup of its own; its materials need one only when
    -- a line charges them at price.
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
    'Returns the part ids in a company that are ready to quote: the part has a cost basis and its cost resolves (made: all ops priced and all BOM children costable) AND the part itself has a non-null-markup pricing tier. A material''s own markup is required only when a BOM line charges it AT PRICE. Shares public.part_has_cost_basis with compute_part_cost_explain, so the two agree by construction rather than by comment.';
