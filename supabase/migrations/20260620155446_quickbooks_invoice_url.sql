-- Deep link to the created QBO invoice (e.g. https://app.qbo.intuit.com/app/invoice?txnId=<id>),
-- built backend-side at push time so the quote page can show a "View in QuickBooks" link
-- without exposing the connection's environment to the browser. Nullable; backfilled only
-- for newly pushed invoices.
ALTER TABLE public.quickbooks_invoice_links
    ADD COLUMN IF NOT EXISTS qb_invoice_url text;
