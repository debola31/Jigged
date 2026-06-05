-- Snapshot the pricing basis on every quote_line_item.
--
-- Background: before this migration, `quote_line_items` stored unit_price
-- plus a `source_tier_id` FK. That FK pointed at a mutable row in
-- `part_pricing_tiers`, so tier movement after quote creation silently
-- changed what looked like the "historical" basis on read paths. Quote-edit
-- needs to detect tier drift between create-time and edit-time, which
-- requires freezing the basis as JSON on the line itself.
--
-- The snapshot captures everything required to:
--   1. Recompute unit_price from the same tier table at any quantity
--      ("quantity-curve movement" is computed against the snapshot, not
--      current tiers).
--   2. Detect drift by diffing the snapshot against the current tier
--      table at edit time.
--
-- basis_unknown carries Option C from the locked sub-decision in #317:
-- pre-snapshot rows have no historical basis to record. Rather than
-- backfilling a fabricated basis from current tiers (Option A — explicitly
-- dropped because it would write false history and then report "no drift"
-- on genuinely-drifted quotes), we mark these rows so the edit UI renders
-- a "basis unknown" chip and uses degraded resolved-vs-current comparison.

ALTER TABLE public.quote_line_items
    ADD COLUMN pricing_basis_snapshot jsonb,
    ADD COLUMN basis_unknown boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.quote_line_items.pricing_basis_snapshot IS
    'JSON snapshot of the pricing tiers, markup, and resolved tier at quote-create time. Shape: { tiers: [{ id, quantity, unit_price, markup_percent }], resolved_tier_id, resolved_quantity, captured_at }. NULL when basis_unknown=true (pre-snapshot rows).';

COMMENT ON COLUMN public.quote_line_items.basis_unknown IS
    'TRUE when this line was created before the basis-snapshot column existed. Renders a "basis unknown" chip on edit; drift detection uses degraded resolved-vs-current comparison. Option C from Issue #317 — Option A (backfill from current tiers) was explicitly dropped to avoid fabricating historical pricing.';

-- Mark every existing row as basis_unknown. New inserts via
-- createQuote() / insertLineItemForPart() will populate the snapshot
-- and leave basis_unknown=false (the column default).
UPDATE public.quote_line_items
SET basis_unknown = true
WHERE pricing_basis_snapshot IS NULL;
