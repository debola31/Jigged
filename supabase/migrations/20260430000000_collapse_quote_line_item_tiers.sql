-- Collapse multi-tier quote_line_items down to one row per (quote, part).
--
-- The old model captured every selected tier as its own line item. The new
-- model commits to one Order Quantity per part on the quote and resolves the
-- unit price from the part's master tier table at quote save time.
--
-- For each (quote_id, part_id) group of existing rows we keep the row with the
-- LOWEST quantity (treat it as the salesperson's most conservative starting
-- commitment) and delete the rest. The salesperson can edit the order qty
-- afterwards if a different tier is the right one.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY quote_id, part_id
      ORDER BY quantity ASC, sequence ASC, created_at ASC
    ) AS rn
  FROM quote_line_items
)
DELETE FROM quote_line_items
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
