-- Agreed price on job_parts.
--
-- Until now a job_part reached its price only via source_quote_line_item_id ->
-- quote_line_items. Jobs created directly from a customer PO (no quote) have no
-- such line, so the agreed price needs a home on the job_part itself.
--
-- To keep the invoice read-path single-shaped (no "quote line vs job_part"
-- branching), we make job_parts the source of price for EVERY job:
--   * convertQuoteToJob now copies unit_price/total_price from the quote line,
--   * createJobFromPurchaseOrder writes the operator-entered price,
--   * and the backfill below fills historic rows from their source quote line.
-- After this migration every job_part that can have a price carries one.
-- Columns stay nullable: genuinely pre-snapshot legacy lines may have no price,
-- and the QuickBooks invoice builder already guards a null unit price.

ALTER TABLE public.job_parts
  ADD COLUMN unit_price  numeric(12,4),
  ADD COLUMN total_price numeric(12,4);

UPDATE public.job_parts jp
SET unit_price  = qli.unit_price,
    total_price = COALESCE(qli.total_price, qli.unit_price * jp.quantity)
FROM public.quote_line_items qli
WHERE jp.source_quote_line_item_id = qli.id
  AND jp.unit_price IS NULL;
