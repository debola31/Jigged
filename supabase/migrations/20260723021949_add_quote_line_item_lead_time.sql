-- Per-item lead time on quote line items.
--
-- Quotes carry a single quote-level lead time (quotes.lead_time_text). When a
-- quote has items with different lead times (e.g. "2–3 weeks" vs "3–4 weeks"),
-- the shop needs to show a lead time under each item rather than being forced
-- into one value for the whole quote (matching the E2 shop system's behavior).
--
-- This adds an OPTIONAL per-line lead time. NULL is a first-class meaning:
-- "this item uses the quote's lead time" — so existing rows need no backfill and
-- the read path is a single clean rule (effective = line value, else quote value).
-- Lead time is per-part; a part quoted at several quantities shares one value,
-- denormalized onto each of its line rows (same shape as the per-part price
-- override).
--
-- No new grants: quote_line_items already has table-level grants; this is a new
-- column, not a new table.

ALTER TABLE public.quote_line_items
  ADD COLUMN IF NOT EXISTS lead_time_text text;

COMMENT ON COLUMN public.quote_line_items.lead_time_text IS
  'Optional per-item lead time (free text, e.g. "2–3 weeks"). NULL = use the quote-level quotes.lead_time_text. Shown per item on the quote/PDF only when items differ.';
