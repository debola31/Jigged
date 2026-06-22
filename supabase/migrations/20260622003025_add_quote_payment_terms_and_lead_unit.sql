-- Quote enhancements: payment terms + lead-time units.
--
-- 1. payment_terms: free-form/preset payment terms string shown on the quote
--    (e.g. 'Net 30', '2/10 Net 30', 'Net 30, 1% late charge').
-- 2. lead_time_value + lead_time_unit: the lead time as the user states it
--    (e.g. 6 weeks). The existing lead_time_days column is KEPT as the
--    normalized canonical day count consumed by convertQuoteToJob — the
--    access layer recomputes it from (value, unit) on every save, so reads
--    have a single clean shape and never branch on a missing normalization.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS payment_terms text,
  ADD COLUMN IF NOT EXISTS lead_time_value integer,
  ADD COLUMN IF NOT EXISTS lead_time_unit text
    DEFAULT 'business_days'
    CHECK (lead_time_unit IN ('business_days', 'calendar_days', 'weeks'));

-- Backfill existing rows: their lead_time_days was always a calendar-day count,
-- so the value carries over 1:1 with unit 'calendar_days'. Leaving lead_time_days
-- untouched keeps the conversion path working unchanged.
UPDATE quotes
SET lead_time_value = lead_time_days,
    lead_time_unit = 'calendar_days'
WHERE lead_time_days IS NOT NULL
  AND lead_time_value IS NULL;

COMMENT ON COLUMN quotes.payment_terms IS
  'Payment terms shown on the quote (preset or custom free text), e.g. Net 30, 2/10 Net 30.';
COMMENT ON COLUMN quotes.lead_time_value IS
  'Lead time as stated by the user, in the unit given by lead_time_unit. Normalized into lead_time_days on save.';
COMMENT ON COLUMN quotes.lead_time_unit IS
  'Unit for lead_time_value: business_days | calendar_days | weeks.';
