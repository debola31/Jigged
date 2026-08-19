-- A quote's note to the customer.
--
-- Jigged briefly had a `quotes.notes` column, removed 2026-01-02 (595733c0), whose comment read
-- "Internal notes about the quote". This is deliberately NOT that column brought back. That one was
-- internal and never printed; this one exists only to be printed, and is labelled as such
-- everywhere it is edited. Internal commentary on shop work has its own home in the `notes` feed.
--
-- Nullable with no backfill: a quote without a note is a real state, not an inconsistency, so there
-- is nothing at rest to fix. `quotes` is an existing table, so it already carries its Data API
-- grants and its billing_gate_* write gate — adding a column changes neither.

ALTER TABLE public.quotes
  ADD COLUMN customer_note text,
  ADD CONSTRAINT quotes_customer_note_length CHECK (char_length(customer_note) <= 500);

COMMENT ON COLUMN public.quotes.customer_note IS
  'Free-text note from the shop to the customer, printed on the quote PDF below the grand total. '
  'Customer-facing by definition — there is no internal counterpart. Written per quote and never '
  'inherited from the customer record, so it takes no standing-terms prefill and no drift chip. '
  'Capped at 500 characters by quotes_customer_note_length so an imported or pasted value cannot '
  'overrun the printed document.';
