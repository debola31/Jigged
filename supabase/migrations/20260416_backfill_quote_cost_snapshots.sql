-- Migration: Backfill quote_operations + quote_materials for quotes created
-- before the snapshot tables existed.
--
-- The sibling migration (20260416_quote_simplify_and_lead_time.sql) added the
-- per-line snapshot tables but only populated them for new quotes. Existing
-- quotes still had empty snapshots, which would force the UI into a
-- live-routing fallback (two sources of truth, hides missing data). Instead,
-- we backfill from the part's current routing now and keep the read path
-- branch-free: the UI always reads from the snapshot tables.
--
-- The calculation mirrors utils/routingCostCalculation.ts — nodes/materials
-- with missing run_time / labor_rate / cost_per_unit are skipped (they
-- would have emitted warnings in JS). We only touch quotes whose snapshot
-- tables are completely empty, so re-running this migration is a no-op.

BEGIN;

-- ============================================================
-- Backfill quote_operations from each quote's part routing
-- ============================================================
INSERT INTO public.quote_operations (
  quote_id,
  company_id,
  sequence,
  operation_name,
  run_time_minutes,
  setup_time_minutes,
  labor_rate,
  run_cost,
  setup_cost
)
SELECT
  q.id                                                          AS quote_id,
  q.company_id                                                  AS company_id,
  (ROW_NUMBER() OVER (PARTITION BY q.id ORDER BY rn.sequence) - 1)::integer AS sequence,
  COALESCE(ot.name, 'Unknown Operation')                        AS operation_name,
  rn.run_time_per_unit                                          AS run_time_minutes,
  COALESCE(rn.setup_time, 0)                                    AS setup_time_minutes,
  ot.labor_rate                                                 AS labor_rate,
  ROUND(((rn.run_time_per_unit / 60.0) * ot.labor_rate)::numeric, 2) AS run_cost,
  ROUND(((COALESCE(rn.setup_time, 0) / 60.0) * ot.labor_rate)::numeric, 2) AS setup_cost
FROM public.quotes q
JOIN public.routings r       ON r.part_id = q.part_id
JOIN public.routing_nodes rn ON rn.routing_id = r.id
JOIN public.operation_types ot ON ot.id = rn.operation_type_id
WHERE q.part_id IS NOT NULL
  AND rn.run_time_per_unit IS NOT NULL  -- matches JS: skip nodes with missing run time
  AND ot.labor_rate IS NOT NULL         -- matches JS: skip nodes with missing labor rate
  AND NOT EXISTS (
    SELECT 1 FROM public.quote_operations qo WHERE qo.quote_id = q.id
  );

-- ============================================================
-- Backfill quote_materials from each quote's part routing
-- ============================================================
INSERT INTO public.quote_materials (
  quote_id,
  company_id,
  sequence,
  inventory_item_id,
  item_name,
  quantity,
  unit,
  cost_per_unit,
  line_cost
)
SELECT
  q.id                                                          AS quote_id,
  q.company_id                                                  AS company_id,
  (ROW_NUMBER() OVER (PARTITION BY q.id ORDER BY rm.sequence) - 1)::integer AS sequence,
  rm.inventory_item_id                                          AS inventory_item_id,
  COALESCE(ii.name, 'Unknown Material')                         AS item_name,
  rm.quantity                                                   AS quantity,
  COALESCE(rm.unit, ii.primary_unit)                            AS unit,
  ii.cost_per_unit                                              AS cost_per_unit,
  ROUND((rm.quantity * ii.cost_per_unit)::numeric, 2)           AS line_cost
FROM public.quotes q
JOIN public.routings r           ON r.part_id = q.part_id
JOIN public.routing_materials rm ON rm.routing_id = r.id
JOIN public.inventory_items ii   ON ii.id = rm.inventory_item_id   -- matches JS: skip materials with no inventory item
WHERE q.part_id IS NOT NULL
  AND ii.cost_per_unit IS NOT NULL                                  -- matches JS: skip materials with no cost
  AND NOT EXISTS (
    SELECT 1 FROM public.quote_materials qm WHERE qm.quote_id = q.id
  );

COMMIT;
