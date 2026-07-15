-- Material yield / fractional consumption in part costing.
--
-- Three additive, backward-compatible columns. Every default reproduces the
-- CURRENT behavior exactly, so existing rows are untouched:
--   * parts.costing_batch_quantity  (NULL  = value a made child at the cascaded
--                                     consumed qty, i.e. today's rollup)
--   * parts_bom.consume_whole_units (false = fractional consumption, today's math)
--   * quote_materials.units_consumed(NULL  = the stored `quantity` is literal,
--                                     legacy/fractional snapshot)
--
-- See docs / the plan for the full rationale. No backfill: NULL/false are the
-- no-op side for each column.

-- 1) Costing batch quantity on made parts. When set, a made part consumed as a
--    BOM material is valued at compute_part_cost_at_qty(child, this qty) — a
--    FIXED batch cost, decoupled from how many the consuming order draws (so an
--    intermediate like "M48 Ground" priced at a batch of 25 stays $109/each no
--    matter how many strips a downstream insert job consumes). Bought parts
--    ignore it.
ALTER TABLE public.parts
  ADD COLUMN costing_batch_quantity numeric
    CHECK (costing_batch_quantity IS NULL OR costing_batch_quantity > 0);

COMMENT ON COLUMN public.parts.costing_batch_quantity IS
  'Batch qty at which this made part''s cost is amortized when it is consumed as a BOM material; NULL = value at the cascaded consumed qty (current behavior). Ignored for bought parts.';

-- 2) Whole-unit (ceiling) consumption per BOM line. true = the consuming order
--    consumes CEIL(order_qty * per-part consumption) whole units (discrete
--    stock like a steel strip you cannot cut a fraction of); false = fractional
--    (today's exact linear math). Default false = no change to existing rows.
ALTER TABLE public.parts_bom
  ADD COLUMN consume_whole_units boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.parts_bom.consume_whole_units IS
  'true = ceiling material consumption to whole units at the order qty (discrete stock); false = fractional (default, current behavior).';

-- 3) Snapshot fidelity for ceiling lines. In whole-unit mode the per-part
--    `quantity` (e.g. 0.05 strips) no longer multiplies out against
--    `cost_per_unit` to `line_cost` (the total is ceil-driven), so the itemized
--    quote breakdown stores the actual discrete count that reconciles them.
--    NULL = legacy/fractional row where `quantity` is literal.
ALTER TABLE public.quote_materials
  ADD COLUMN units_consumed numeric
    CHECK (units_consumed IS NULL OR units_consumed >= 0);

COMMENT ON COLUMN public.quote_materials.units_consumed IS
  'Whole/fractional units of this material actually consumed across the quoted order (ceil(order_qty * per-part consumption) in whole-unit mode); NULL = legacy row where `quantity` is the literal per-unit value.';
