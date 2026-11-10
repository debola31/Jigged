-- Drop two settings that lost their only writer when the Settings page was cleaned up (2026-11-09).
--
-- 1. companies.default_markup_made_percent / default_markup_bought_percent — the shop's starting
--    markup for a new part's first pricing tier (#727). The "Part pricing markups" fields were
--    removed from Settings; at the time every company held 0 for both, so a new part now always
--    starts at 0% and its markup is set on the part's own Pricing card. The app writes that 0
--    directly (ensureStarterPricingTier, the parts importer) instead of reading it from here.
--
-- 2. quickbooks_connections.po_custom_field_id / po_custom_field_name / qb_settings_checked_at —
--    the QuickBooks Online custom field the shop uses for the customer PO, found by the
--    "Check QuickBooks settings" button. That button and its endpoint (POST
--    /{company}/po-field/refresh) are gone, and no connection had a field stored, so the invoice
--    push stops sending a CustomField. The PO still prints on every line and as the "Note to
--    customer" with no setup.
--
-- Nothing else depends on these columns: no function body, view or policy references them
-- (checked against a fresh `supabase db reset`). The one mention is the comment below, re-issued
-- without it.

ALTER TABLE public.companies
  DROP COLUMN IF EXISTS default_markup_made_percent,
  DROP COLUMN IF EXISTS default_markup_bought_percent;

ALTER TABLE public.quickbooks_connections
  DROP COLUMN IF EXISTS po_custom_field_id,
  DROP COLUMN IF EXISTS po_custom_field_name,
  DROP COLUMN IF EXISTS qb_settings_checked_at;

COMMENT ON FUNCTION public.compute_part_price_explain_at_qty(uuid, numeric) IS
  'The price a part is charged at when a BOM line charges it at price: its own pricing tier, with the base evaluated at that tier''s own quantity per the tier-band rule, plus the markup applied. Returns NO ROW when the part has no markup tier — the caller must treat that as un-priceable, never as cost. There is deliberately no shop-wide fallback: a new part''s first tier is written at 0% markup, and nothing shop-wide is consulted here.';
