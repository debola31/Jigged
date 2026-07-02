-- Multiple invoices per job (progressive, quantity-based invoicing).
--
-- Today a job can have many shipments but only ONE QuickBooks invoice: the
-- UNIQUE(job_id, realm_id) constraint on quickbooks_invoice_links enforces it,
-- push_invoice keys idempotency on (job_id, realm_id), and load_firm_invoice_lines
-- bills every job_part at full ordered quantity. This migration turns invoicing
-- into a per-quantity axis that MIRRORS the shipments model:
--   * many invoice links per job (drop the unique; re-home idempotency onto the
--     client-minted qb_request_id),
--   * a new quickbooks_invoice_line_items child table = the Jigged-side source of
--     truth for "how much of each part is invoiced" (+ a price snapshot),
--   * a third status axis invoicing_status (uninvoiced/partially_invoiced/
--     fully_invoiced) on job_parts + jobs, maintained by triggers cloned from the
--     fulfillment_status family (compute_job_part_fulfillment_status et al.).
--
-- v1 is ADDITIVE: invoices are only ever created; reducing below already-invoiced
-- qty is blocked in the access layer; void/credit is deferred (but voided_at is
-- added now and filtered everywhere so the future void phase needs no schema change).

-- ============================================================================
-- 1. quickbooks_invoice_links: allow many per job + re-home idempotency + void cols
-- ============================================================================

-- The unique constraint was doing double duty: (i) the "one invoice per job"
-- business rule (now deleted — that's the feature) and (ii) the idempotency latch
-- for push_invoice's SELECT-then-insert. The latch moves onto qb_request_id.
ALTER TABLE public.quickbooks_invoice_links
    DROP CONSTRAINT IF EXISTS quickbooks_invoice_links_job_realm_key;

-- New idempotency latch: one row per (realm, client-minted request id). A retried
-- submit reuses the same qb_request_id and collides here instead of double-POSTing.
CREATE UNIQUE INDEX IF NOT EXISTS quickbooks_invoice_links_realm_request_key
    ON public.quickbooks_invoice_links (realm_id, qb_request_id);

-- Supports the new read pattern (many links per job, filtered by status, newest first).
CREATE INDEX IF NOT EXISTS idx_qb_invoice_links_job_status
    ON public.quickbooks_invoice_links (company_id, job_id, status, created_at DESC);

-- Future-proof the (deferred) void path now, so compute functions can filter it
-- from day one — when voiding ships later it needs no schema change.
ALTER TABLE public.quickbooks_invoice_links
    ADD COLUMN IF NOT EXISTS voided_at timestamptz,
    ADD COLUMN IF NOT EXISTS voided_by uuid;

-- ============================================================================
-- 2. quickbooks_invoice_line_items: per-part invoiced quantity + price snapshot
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.quickbooks_invoice_line_items (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    invoice_link_id uuid NOT NULL,
    job_part_id uuid NOT NULL,
    quantity numeric(12,4) NOT NULL,
    unit_price numeric(12,4) NOT NULL,   -- snapshot at push time (price is locked once invoiced)
    total_price numeric(12,4) NOT NULL,  -- round(quantity*unit_price, 4), same convention as job_parts
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT quickbooks_invoice_line_items_pkey PRIMARY KEY (id),
    CONSTRAINT qb_ili_quantity_positive CHECK (quantity > 0),
    -- one line per (invoice, part): makes a resume re-insert idempotent (ON CONFLICT
    -- DO NOTHING) and prevents accidental duplicate lines within one invoice.
    CONSTRAINT qb_ili_link_part_unique UNIQUE (invoice_link_id, job_part_id),
    CONSTRAINT qb_ili_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    -- parent link CASCADE: deleting a link (only ever a pending/error one) cleans its lines.
    CONSTRAINT qb_ili_link_fk FOREIGN KEY (invoice_link_id)
        REFERENCES public.quickbooks_invoice_links(id) ON DELETE CASCADE,
    -- RESTRICT: an invoiced part must not silently vanish (same "keep for recordkeeping"
    -- philosophy as deleteJob's shipment guard).
    CONSTRAINT qb_ili_job_part_fk FOREIGN KEY (job_part_id)
        REFERENCES public.job_parts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_qb_ili_job_part ON public.quickbooks_invoice_line_items (job_part_id);
CREATE INDEX IF NOT EXISTS idx_qb_ili_link ON public.quickbooks_invoice_line_items (invoice_link_id);

-- Member reads (Invoices card + per-part summaries). Writes are service-role only
-- (the FastAPI push endpoint), which bypasses RLS — so only a SELECT policy is needed.
ALTER TABLE public.quickbooks_invoice_line_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view their company's qb invoice line items" ON public.quickbooks_invoice_line_items;
CREATE POLICY "Users can view their company's qb invoice line items"
    ON public.quickbooks_invoice_line_items
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

CREATE TRIGGER quickbooks_invoice_line_items_updated_at
    BEFORE UPDATE ON public.quickbooks_invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 3. invoicing_status axis on job_parts + jobs
-- ============================================================================

ALTER TABLE public.job_parts ADD COLUMN IF NOT EXISTS invoicing_status text NOT NULL DEFAULT 'uninvoiced'
    CONSTRAINT job_parts_invoicing_status_check
    CHECK (invoicing_status IN ('uninvoiced','partially_invoiced','fully_invoiced'));
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS invoicing_status text NOT NULL DEFAULT 'uninvoiced'
    CONSTRAINT jobs_invoicing_status_check
    CHECK (invoicing_status IN ('uninvoiced','partially_invoiced','fully_invoiced'));

CREATE INDEX IF NOT EXISTS idx_jobs_invoicing_status ON public.jobs (company_id, invoicing_status);

-- ============================================================================
-- 4. Compute functions (clones of the fulfillment_status family)
-- ============================================================================

-- Part-level truth: qty invoiced (created, non-void lines) vs qty ordered.
CREATE OR REPLACE FUNCTION public.compute_job_part_invoicing_status(p_job_part_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_qty_ordered numeric;
    v_qty_invoiced numeric;
BEGIN
    SELECT jp.quantity INTO v_qty_ordered
      FROM public.job_parts jp
     WHERE jp.id = p_job_part_id;
    IF v_qty_ordered IS NULL THEN
        RETURN 'uninvoiced';
    END IF;

    SELECT COALESCE(SUM(ili.quantity), 0) INTO v_qty_invoiced
      FROM public.quickbooks_invoice_line_items ili
      JOIN public.quickbooks_invoice_links l ON l.id = ili.invoice_link_id
     WHERE ili.job_part_id = p_job_part_id
       AND l.status = 'created'
       AND l.voided_at IS NULL;

    IF v_qty_invoiced <= 0 THEN
        RETURN 'uninvoiced';
    END IF;
    IF v_qty_invoiced >= v_qty_ordered THEN
        RETURN 'fully_invoiced';
    END IF;
    RETURN 'partially_invoiced';
END $function$;

-- Job rollup: fold the per-part statuses (same shape as compute_job_fulfillment_status).
CREATE OR REPLACE FUNCTION public.compute_job_invoicing_status(p_job_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_total int;
    v_full int;
    v_partial int;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE invoicing_status = 'fully_invoiced'),
           count(*) FILTER (WHERE invoicing_status = 'partially_invoiced')
      INTO v_total, v_full, v_partial
      FROM public.job_parts WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'uninvoiced'; END IF;
    IF v_full = v_total THEN RETURN 'fully_invoiced'; END IF;
    IF v_full > 0 OR v_partial > 0 THEN RETURN 'partially_invoiced'; END IF;
    RETURN 'uninvoiced';
END $function$;

-- ============================================================================
-- 5. Trigger functions (clones of recompute_/sync_ fulfillment family)
-- ============================================================================

-- line-item ins/upd/del -> recompute the affected part's invoicing_status
CREATE OR REPLACE FUNCTION public.recompute_job_part_invoicing_from_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_jp_id uuid;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_jp_id := COALESCE(NEW.job_part_id, OLD.job_part_id);
    v_new := public.compute_job_part_invoicing_status(v_jp_id);
    SELECT invoicing_status INTO v_old FROM public.job_parts WHERE id = v_jp_id;
    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.job_parts SET invoicing_status = v_new, updated_at = now() WHERE id = v_jp_id;
    END IF;
    RETURN NULL;
END $function$;

-- link status/void change -> recompute every part on that invoice (a pending->created
-- flip, or a future void, changes which lines count). No shipment analogue: shipments
-- have no "status" flip, but an invoice link does.
CREATE OR REPLACE FUNCTION public.recompute_job_part_invoicing_from_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    r record;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    IF NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at THEN
        RETURN NULL;
    END IF;
    FOR r IN
        SELECT DISTINCT ili.job_part_id
          FROM public.quickbooks_invoice_line_items ili
         WHERE ili.invoice_link_id = NEW.id
    LOOP
        v_new := public.compute_job_part_invoicing_status(r.job_part_id);
        SELECT invoicing_status INTO v_old FROM public.job_parts WHERE id = r.job_part_id;
        IF v_new IS DISTINCT FROM v_old THEN
            UPDATE public.job_parts SET invoicing_status = v_new, updated_at = now() WHERE id = r.job_part_id;
        END IF;
    END LOOP;
    RETURN NULL;
END $function$;

-- job_parts.quantity edit -> recompute invoicing_status (ordered qty is the
-- denominator: raising order 10->15 must reopen a fully_invoiced part to
-- partially_invoiced). Mirrors recompute_job_part_fulfillment_from_qty.
CREATE OR REPLACE FUNCTION public.recompute_job_part_invoicing_from_qty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_new text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_new := public.compute_job_part_invoicing_status(NEW.id);
    IF v_new IS DISTINCT FROM NEW.invoicing_status THEN
        UPDATE public.job_parts SET invoicing_status = v_new, updated_at = now() WHERE id = NEW.id;
    END IF;
    RETURN NULL;
END $function$;

-- part invoicing_status change -> roll up to the job (mirror sync_job_fulfillment_status_from_parts)
CREATE OR REPLACE FUNCTION public.sync_job_invoicing_status_from_parts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_job_id uuid;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new := public.compute_job_invoicing_status(v_job_id);
    SELECT invoicing_status INTO v_old FROM public.jobs WHERE id = v_job_id;
    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.jobs SET invoicing_status = v_new, updated_at = now() WHERE id = v_job_id;
    END IF;
    RETURN NULL;
END $function$;

-- Over-invoice hard backstop: Σ(created, non-void invoiced qty for the part, across
-- OTHER invoices) + this line's qty must not exceed the ordered quantity. Excluding
-- the same invoice_link_id keeps a resume re-insert (ON CONFLICT DO NOTHING) from
-- double-counting against itself. The ship-cap (invoice <= shipped) is enforced at
-- push time in the route, NOT here — a shipment voided after invoicing may legitimately
-- leave invoiced > shipped, which this at-rest invariant must still allow.
CREATE OR REPLACE FUNCTION public.assert_invoice_not_over_ordered()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_ordered numeric;
    v_existing numeric;
BEGIN
    SELECT quantity INTO v_ordered FROM public.job_parts WHERE id = NEW.job_part_id;
    IF v_ordered IS NULL THEN
        RAISE EXCEPTION 'Job part % not found for invoice line', NEW.job_part_id;
    END IF;
    SELECT COALESCE(SUM(ili.quantity), 0) INTO v_existing
      FROM public.quickbooks_invoice_line_items ili
      JOIN public.quickbooks_invoice_links l ON l.id = ili.invoice_link_id
     WHERE ili.job_part_id = NEW.job_part_id
       AND ili.invoice_link_id <> NEW.invoice_link_id
       AND l.status = 'created'
       AND l.voided_at IS NULL;
    IF v_existing + NEW.quantity > v_ordered THEN
        RAISE EXCEPTION 'Cannot invoice % of job_part %: % ordered, % already invoiced',
            NEW.quantity, NEW.job_part_id, v_ordered, v_existing
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $function$;

-- ============================================================================
-- 6. Triggers
-- ============================================================================

-- over-invoice backstop (BEFORE, so it blocks the write)
DROP TRIGGER IF EXISTS trigger_assert_invoice_not_over_ordered ON public.quickbooks_invoice_line_items;
CREATE TRIGGER trigger_assert_invoice_not_over_ordered
    BEFORE INSERT OR UPDATE OF quantity, job_part_id, invoice_link_id ON public.quickbooks_invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION assert_invoice_not_over_ordered();

-- line items -> part invoicing_status
DROP TRIGGER IF EXISTS trigger_recompute_jp_invoicing_on_line_ins ON public.quickbooks_invoice_line_items;
CREATE TRIGGER trigger_recompute_jp_invoicing_on_line_ins
    AFTER INSERT ON public.quickbooks_invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION recompute_job_part_invoicing_from_line();
DROP TRIGGER IF EXISTS trigger_recompute_jp_invoicing_on_line_upd ON public.quickbooks_invoice_line_items;
CREATE TRIGGER trigger_recompute_jp_invoicing_on_line_upd
    AFTER UPDATE OF quantity, job_part_id, invoice_link_id ON public.quickbooks_invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION recompute_job_part_invoicing_from_line();
DROP TRIGGER IF EXISTS trigger_recompute_jp_invoicing_on_line_del ON public.quickbooks_invoice_line_items;
CREATE TRIGGER trigger_recompute_jp_invoicing_on_line_del
    AFTER DELETE ON public.quickbooks_invoice_line_items
    FOR EACH ROW EXECUTE FUNCTION recompute_job_part_invoicing_from_line();

-- link status/void -> part invoicing_status
DROP TRIGGER IF EXISTS trigger_recompute_jp_invoicing_on_link ON public.quickbooks_invoice_links;
CREATE TRIGGER trigger_recompute_jp_invoicing_on_link
    AFTER UPDATE OF status, voided_at ON public.quickbooks_invoice_links
    FOR EACH ROW EXECUTE FUNCTION recompute_job_part_invoicing_from_link();

-- job_part qty edit -> part invoicing_status
DROP TRIGGER IF EXISTS trigger_recompute_jp_invoicing_on_qty ON public.job_parts;
CREATE TRIGGER trigger_recompute_jp_invoicing_on_qty
    AFTER UPDATE OF quantity ON public.job_parts
    FOR EACH ROW WHEN (old.quantity IS DISTINCT FROM new.quantity)
    EXECUTE FUNCTION recompute_job_part_invoicing_from_qty();

-- part invoicing_status -> job rollup
DROP TRIGGER IF EXISTS trigger_sync_job_invoicing_from_parts_ins ON public.job_parts;
CREATE TRIGGER trigger_sync_job_invoicing_from_parts_ins
    AFTER INSERT ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION sync_job_invoicing_status_from_parts();
DROP TRIGGER IF EXISTS trigger_sync_job_invoicing_from_parts_del ON public.job_parts;
CREATE TRIGGER trigger_sync_job_invoicing_from_parts_del
    AFTER DELETE ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION sync_job_invoicing_status_from_parts();
DROP TRIGGER IF EXISTS trigger_sync_job_invoicing_from_parts_upd ON public.job_parts;
CREATE TRIGGER trigger_sync_job_invoicing_from_parts_upd
    AFTER UPDATE OF invoicing_status ON public.job_parts
    FOR EACH ROW WHEN (old.invoicing_status IS DISTINCT FROM new.invoicing_status)
    EXECUTE FUNCTION sync_job_invoicing_status_from_parts();

-- ============================================================================
-- 7. Backfill (CLAUDE.md: every existing row satisfies the new invariant at rest;
--    no runtime "compute if empty" fallback)
-- ============================================================================

-- 7a. Pre-assert: a legacy created invoice with a null-price part cannot get an
-- accurate price snapshot. The current push already refuses null-price lines, so
-- this should be 0; if not, STOP and hand to a human rather than silently skipping.
DO $$
DECLARE v_bad int;
BEGIN
    SELECT count(*) INTO v_bad
      FROM public.quickbooks_invoice_links l
      JOIN public.job_parts jp ON jp.job_id = l.job_id
     WHERE l.status = 'created' AND l.voided_at IS NULL AND jp.unit_price IS NULL;
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Backfill aborted: % job_part(s) on created invoices have NULL unit_price', v_bad;
    END IF;
END $$;

-- 7b. Line items from every legacy created invoice. Historically an invoice billed
-- the whole job at full qty (load_firm_invoice_lines), and the old gate blocked qty
-- edits once invoiced — so current job_parts.quantity == the invoiced qty. A clean,
-- exact backfill: one line per job_part at current qty/price. (The over-invoice
-- trigger passes: 0 other-invoice qty + full qty == ordered.)
INSERT INTO public.quickbooks_invoice_line_items
    (company_id, invoice_link_id, job_part_id, quantity, unit_price, total_price)
SELECT l.company_id, l.id, jp.id, jp.quantity, jp.unit_price, round(jp.quantity * jp.unit_price, 4)
  FROM public.quickbooks_invoice_links l
  JOIN public.job_parts jp ON jp.job_id = l.job_id
 WHERE l.status = 'created'
   AND l.voided_at IS NULL
   AND jp.quantity > 0;

-- 7c. Statuses: parts first, then jobs (the rollup reads part statuses). The inserts
-- above already fired the recompute triggers; these explicit passes are idempotent
-- and guarantee correctness for parts/jobs with no invoice too.
UPDATE public.job_parts jp SET invoicing_status = public.compute_job_part_invoicing_status(jp.id);
UPDATE public.jobs j SET invoicing_status = public.compute_job_invoicing_status(j.id);

-- ============================================================================
-- 8. Comments
-- ============================================================================
COMMENT ON TABLE public.quickbooks_invoice_line_items IS
  'Per-part quantity + price snapshot for each QuickBooks invoice push. The Jigged-side source of truth for "how much of each job_part is invoiced" (created, non-void links). Written service-role by the FastAPI push endpoint, atomic with the Intuit call.';
COMMENT ON COLUMN public.quickbooks_invoice_links.voided_at IS
  'Reserved for the deferred invoice-void phase. Compute functions already exclude voided links so voiding needs no schema change when built.';
COMMENT ON FUNCTION public.compute_job_part_invoicing_status(uuid) IS
  'Single source of truth for a job_part''s invoicing_status: SUM(created non-void invoice line qty) vs ordered qty. Clone of compute_job_part_fulfillment_status.';
COMMENT ON FUNCTION public.assert_invoice_not_over_ordered() IS
  'Hard at-rest invariant: total created non-void invoiced qty per job_part cannot exceed ordered qty. The ship-cap (invoice <= shipped) is enforced at push time, not here (a post-invoice shipment void may leave invoiced > shipped).';
