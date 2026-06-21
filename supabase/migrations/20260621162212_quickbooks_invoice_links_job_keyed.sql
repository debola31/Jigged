-- Re-key the QuickBooks invoice ledger from quote -> job.
--
-- Invoicing now lives on the job, not the quote: a job created directly from a
-- customer PO has no quote, and conceptually you invoice the deliverable (job),
-- not the offer (quote). The ledger already records job_id on every push
-- (see push_invoice), so this is a constraint swap, not a data migration:
--   * job_id becomes the required idempotency key (was quote_id),
--   * quote_id becomes nullable provenance (null for PO-sourced jobs),
--   * deleting the JOB now cascades the link; deleting a quote must not (the
--     job and its invoice outlive the quote).

-- Defensive: every existing row was inserted with job_id, but never NULL a key
-- we're about to require.
UPDATE public.quickbooks_invoice_links l
SET job_id = j.id
FROM public.jobs j
WHERE l.job_id IS NULL
  AND j.quote_id = l.quote_id;

ALTER TABLE public.quickbooks_invoice_links
  ALTER COLUMN job_id SET NOT NULL,
  ALTER COLUMN quote_id DROP NOT NULL;

-- Idempotency moves from (quote_id, realm_id) to (job_id, realm_id).
ALTER TABLE public.quickbooks_invoice_links
  DROP CONSTRAINT quickbooks_invoice_links_quote_realm_key,
  ADD CONSTRAINT quickbooks_invoice_links_job_realm_key UNIQUE (job_id, realm_id);

-- Swap delete behavior: job delete cascades the link; quote delete only clears
-- the provenance pointer.
ALTER TABLE public.quickbooks_invoice_links
  DROP CONSTRAINT quickbooks_invoice_links_job_id_fkey,
  ADD CONSTRAINT quickbooks_invoice_links_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE,
  DROP CONSTRAINT quickbooks_invoice_links_quote_id_fkey,
  ADD CONSTRAINT quickbooks_invoice_links_quote_id_fkey
    FOREIGN KEY (quote_id) REFERENCES public.quotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_qb_invoice_links_job
  ON public.quickbooks_invoice_links USING btree (job_id);
