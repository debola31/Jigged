-- Migration: Simplify pricing model.
--   * Drop part_pricing_tiers.is_price_override — markup % is the source of truth on a part tier;
--     unit price is always live = base_cost × (1 + markup/100). Typing a unit price back-calculates markup.
--   * Add quote_line_items.is_quote_override — when the salesperson types a one-off price on the
--     quote form, the line-item snapshot records that and renders a distinct "adjusted for this quote" chip.
--   * Drop part_categories entirely. The category concept was anemic (one number) and got replaced by
--     a "Copy pricing from another part" UX. New tier markups are blank by default; the user types them.

BEGIN;

-- 1. Drop part-level override flag
ALTER TABLE part_pricing_tiers
  DROP COLUMN is_price_override;

-- 2. Quote-level override flag
ALTER TABLE quote_line_items
  ADD COLUMN is_quote_override boolean NOT NULL DEFAULT false;

-- 3. Drop categories
ALTER TABLE parts DROP COLUMN category_id;
DROP TABLE part_categories CASCADE;
-- (RLS policies, indexes, FK, comments, triggers all dropped via CASCADE)

COMMIT;
