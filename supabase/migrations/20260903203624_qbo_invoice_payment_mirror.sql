-- Read-only mirror of what QuickBooks Online last said about each invoice Jigged created.
--
-- Jigged has never read anything back from QuickBooks: the push is one-directional and
-- quickbooks_invoice_links.status is PUSH status ('did the create land'), never payment
-- status. A shop owner asking "which of these got paid" had to open QuickBooks. This adds
-- the answer to the invoice row itself.
--
-- WHAT THIS IS NOT. It is not the AR subledger docs/modules/customers.md refuses. There is
-- no payment record, no aging bucket, no statement, no dunning, and customers.credit_status
-- is still typed by a human and never derived from a balance. This is the latest answer to
-- one question per invoice, kept because asking Intuit on every render is not viable.
--
-- COLUMNS, NOT A SIDE TABLE. The link row IS the invoice record and is 1:1 with these
-- facts. It is already member-readable / service-role-written, already exempt from the
-- billing write gate, and already carries an updated_at trigger -- a side table would
-- reproduce all of that to hold six columns that can never outnumber their parent.
--
-- WHY THE AI ROLE NEEDS NO CHANGE HERE. 20260826103645 established that AI readability is
-- a SELECT grant AND an ai_readonly_select policy, and this table has the baseline grant
-- with no policy, so jigged_ai_readonly already sees zero rows. Balances must stay that
-- way: do not add a policy to this table.

-- ============================================================================
-- 1. The mirror columns
-- ============================================================================
ALTER TABLE public.quickbooks_invoice_links
    ADD COLUMN IF NOT EXISTS qb_status            text,
    ADD COLUMN IF NOT EXISTS qb_total_amt         numeric(12,2),
    ADD COLUMN IF NOT EXISTS qb_balance           numeric(12,2),
    ADD COLUMN IF NOT EXISTS qb_due_date          date,
    ADD COLUMN IF NOT EXISTS qb_txn_date          date,
    ADD COLUMN IF NOT EXISTS qb_status_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS qb_stale_at          timestamptz;

ALTER TABLE public.quickbooks_invoice_links
    DROP CONSTRAINT IF EXISTS quickbooks_invoice_links_qb_status_check;
ALTER TABLE public.quickbooks_invoice_links
    ADD CONSTRAINT quickbooks_invoice_links_qb_status_check
    CHECK (qb_status IS NULL OR qb_status IN ('paid', 'partial', 'open', 'voided', 'missing'));

-- NULL status and NULL timestamp travel together. "Never checked" is an explicit state the
-- UI renders as such; there is no backfill that could make it false, because the facts live
-- in Intuit and only a successful read produces them. Splitting the two would allow a row
-- claiming a status nobody can date, which is the shape a silent fallback takes.
ALTER TABLE public.quickbooks_invoice_links
    DROP CONSTRAINT IF EXISTS quickbooks_invoice_links_qb_status_checked_consistent;
ALTER TABLE public.quickbooks_invoice_links
    ADD CONSTRAINT quickbooks_invoice_links_qb_status_checked_consistent
    CHECK ((qb_status IS NULL) = (qb_status_checked_at IS NULL));

COMMENT ON COLUMN public.quickbooks_invoice_links.qb_status IS
  'What QuickBooks Online last said: paid | partial | open | voided | missing. NULL = never checked, and nothing but a successful read can change that. voided = QBO reports TotalAmt 0 for an invoice Jigged issued with a non-zero line total (a 100%-discount edit reads the same way). missing = the Id was absent from two consecutive SUCCESSFUL queries, i.e. deleted in QBO; it is not terminal, since every refresh re-queries it. Overdue is deliberately NOT stored: it depends on today''s date, so it is derived at render from qb_due_date.';
COMMENT ON COLUMN public.quickbooks_invoice_links.qb_total_amt IS
  'Invoice.TotalAmt as at qb_status_checked_at. Tax-inclusive, so it may legitimately exceed the sum of Jigged''s line items -- never compare the two to decide partial vs open. Its only use against Jigged''s total is the void test.';
COMMENT ON COLUMN public.quickbooks_invoice_links.qb_balance IS
  'Invoice.Balance as at qb_status_checked_at: what is still owed. 0 means paid.';
COMMENT ON COLUMN public.quickbooks_invoice_links.qb_due_date IS
  'Invoice.DueDate as QuickBooks computed it from the terms. NULL after a check means QBO reported none, and such an invoice is never rendered overdue.';
COMMENT ON COLUMN public.quickbooks_invoice_links.qb_txn_date IS
  'Invoice.TxnDate -- the invoice date QuickBooks holds. transaction_date is what the browser sent at push time; for Online this is the authoritative one.';
COMMENT ON COLUMN public.quickbooks_invoice_links.qb_status_checked_at IS
  'When Intuit last answered for this row. Stamped ONLY on a definitive answer -- a failed read leaves it alone, so "we could not ask" never renders as "nothing is owed". Also the monotonic guard in apply_qbo_invoice_mirror.';
COMMENT ON COLUMN public.quickbooks_invoice_links.qb_stale_at IS
  'When an Intuit webhook last told us this invoice changed. Compared against qb_status_checked_at to decide whether opening the job''s Invoices menu should ask QuickBooks. The webhook itself never reads Intuit and never writes a balance -- it only says WHICH row is out of date.';

-- voided_at was reserved by 20260702011324 for a deferred in-app void phase and has never
-- been written. The mirror is now its first writer, for a different reason, so the column
-- has two possible owners and voided_by is what tells them apart.
COMMENT ON COLUMN public.quickbooks_invoice_links.voided_at IS
  'When this invoice stopped counting toward invoiced quantity. Written by the QuickBooks Online mirror when QBO reports the invoice voided or deleted (voided_by NULL), or by a future in-app void (voided_by set). The mirror only ever touches rows where voided_by IS NULL, so it can never undo a human void.';

-- ============================================================================
-- 2. Webhook bookkeeping on the connection
-- ============================================================================
ALTER TABLE public.quickbooks_connections
    ADD COLUMN IF NOT EXISTS qb_invoices_stale_since  timestamptz,
    ADD COLUMN IF NOT EXISTS webhook_last_received_at timestamptz;

COMMENT ON COLUMN public.quickbooks_connections.qb_invoices_stale_since IS
  'When a Payment or CreditMemo webhook last arrived for this realm. Those events name only the payment or memo id, and resolving one to the invoices it touches would need an Intuit call inside the webhook handler -- which must stay a pure DB write. So the marker is company-wide: every invoice checked before this instant is treated as out of date.';
COMMENT ON COLUMN public.quickbooks_connections.webhook_last_received_at IS
  'Last signature-verified webhook of any kind for this realm. Evidence for the settings card that live updates are actually arriving -- a webhook registered on the wrong host fails silently and nothing else would show it.';

-- ============================================================================
-- 3. The single guarded write
-- ============================================================================
-- One statement per refresh pass. SECURITY INVOKER, not DEFINER: the only caller is the
-- backend on the service-role key, which already bypasses RLS, so DEFINER would buy nothing
-- and would put another function inside function_execute_leaks()'s remit.
--
-- The monotonic guard (qb_status_checked_at <= p_checked_at) matters because two passes can
-- overlap -- two people opening the same job, or a menu open racing the backfill script.
-- Without it the slower Intuit response wins and a paid invoice flips back to open. Same
-- shape as apply_stripe_subscription's guard on event time.
CREATE OR REPLACE FUNCTION public.apply_qbo_invoice_mirror(
    p_company_id uuid,
    p_realm_id text,
    p_checked_at timestamptz,
    p_rows jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_updated integer;
BEGIN
    WITH incoming AS (
        SELECT (r->>'link_id')::uuid      AS id,
               r->>'status'               AS status,
               (r->>'total_amt')::numeric AS total_amt,
               (r->>'balance')::numeric   AS balance,
               (r->>'due_date')::date     AS due_date,
               (r->>'txn_date')::date     AS txn_date
          FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) r
    )
    UPDATE public.quickbooks_invoice_links l
       SET qb_status            = i.status,
           qb_total_amt         = i.total_amt,
           qb_balance           = i.balance,
           qb_due_date          = i.due_date,
           qb_txn_date          = i.txn_date,
           qb_status_checked_at = p_checked_at,
           -- A void or delete in QuickBooks releases the quantity: setting voided_at fires
           -- trigger_recompute_jp_invoicing_on_link, so the parts become invoiceable again
           -- and "Left to invoice" reopens with no further code. Clearing it again (the
           -- invoice came back) re-locks them. Rows a human voided (voided_by NOT NULL) are
           -- filtered out below and never touched here.
           voided_at = CASE
               WHEN i.status IN ('voided', 'missing') THEN COALESCE(l.voided_at, p_checked_at)
               WHEN l.voided_at IS NOT NULL           THEN NULL
               ELSE l.voided_at
           END,
           updated_at = now()
      FROM incoming i
     WHERE l.id = i.id
       AND l.company_id = p_company_id
       AND l.realm_id = p_realm_id
       AND l.provider = 'qbo'
       AND l.status = 'created'
       AND l.voided_by IS NULL
       AND (l.qb_status_checked_at IS NULL OR l.qb_status_checked_at <= p_checked_at);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_qbo_invoice_mirror(uuid, text, timestamptz, jsonb)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_qbo_invoice_mirror(uuid, text, timestamptz, jsonb)
    TO service_role;

COMMENT ON FUNCTION public.apply_qbo_invoice_mirror(uuid, text, timestamptz, jsonb) IS
  'Apply one QuickBooks Online read to the invoice ledger in a single guarded statement. Backend-only: the browser never writes what QuickBooks said. Rows older than what is stored are ignored, so overlapping refresh passes cannot regress a status.';
