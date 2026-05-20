-- ============================================================================
-- Shipments — PR 4: shipments core (tables, triggers, RPC, helpers, backfill)
-- ============================================================================
--
-- Context. PR 3 split the single `status` enum on jobs/job_parts into
-- production_status + fulfillment_status, but left fulfillment_status as
-- a placeholder ('unshipped' for live rows, 'fully_shipped' for migrated
-- 'shipped' rows). PR 4 ships the shipments domain that drives the
-- fulfillment lifecycle, plus the synthetic backfill that keeps the
-- column and the function-derived value in lock-step for legacy rows
-- (CLAUDE.md "no silent runtime fallbacks for data-at-rest issues").
--
-- Tables introduced:
--   - shipments              one packing-slip-issued shipment per row
--   - shipment_line_items    qty per (shipment, job_part)
--   - job_fulfillment_audit  causal record of forward transitions into
--                            fully_shipped (RPC-written, never trigger-written)
--
-- Functions introduced:
--   - compute_job_part_fulfillment_status(uuid)  STABLE — derived from
--       non-voided shipment_line_items.quantity / job_parts.quantity
--   - compute_job_fulfillment_status(uuid)       STABLE — aggregates the
--       child statuses without filtering cancelled parts (see PRD §7.1)
--   - format_packing_slip_number(text,int,int)   IMMUTABLE — template subst
--   - next_packing_slip_number(uuid)             VOLATILE SECURITY DEFINER —
--       atomic row-locked counter on companies.packing_slip_next_seq
--   - create_shipment_with_line_items(...)       VOLATILE SECURITY DEFINER —
--       single transaction; sorted pg_advisory_xact_lock per affected
--       job_id (deadlock-free); snapshot pre/post fulfillment_status and
--       write the audit row from the RPC directly. No trigger D.
--   - _migrate_legacy_shipment_for_job(uuid)     VOLATILE — backfill helper,
--       single-use, REVOKE'd from public roles
--
-- Triggers introduced:
--   - A: recompute_job_part_fulfillment_from_line  AFTER ins/upd/del on
--                                                  shipment_line_items
--   - B: recompute_job_part_fulfillment_from_void  AFTER upd of voided_at
--                                                  on shipments
--   - C: sync_job_fulfillment_status_from_parts    AFTER ins/upd of
--                                                  fulfillment_status / del
--                                                  on job_parts
--   - enforce_shipment_address_contact_customer    BEFORE ins/upd on
--                                                  shipments (FK integrity)
--
-- Indexes introduced:
--   - shipments / shipment_line_items / job_fulfillment_audit B-trees
--   - pg_trgm GIN indexes on jobs.job_number, quotes.customer_po_number,
--     customers.name, parts.part_number, shipments.packing_slip_number
--     (consumed by the extended jobs-list search in PR 6)
--
-- Synthetic-shipment backfill. Every job_part that PR 3 marked
-- fulfillment_status = 'fully_shipped' (because its old status was
-- 'shipped') and has no shipment_line_items today gets a synthetic
-- shipment record so that compute_job_part_fulfillment_status agrees
-- with the column value forever. The backfill is gated by
-- `NOT EXISTS (SELECT 1 FROM shipment_line_items WHERE job_part_id = jp.id)`,
-- so re-running the migration produces no duplicates.
--
-- Security model. Functions that write to internal state (companies
-- counter, shipments, line items, audit) run SECURITY DEFINER with
-- search_path locked to public + pg_temp and an explicit
-- company-membership guard at the top of the body. Pure read functions
-- (compute_*, format_*) stay SECURITY INVOKER.
--
-- IDEMPOTENT. Tables/indexes use IF NOT EXISTS, triggers use
-- DROP IF EXISTS + CREATE, functions use CREATE OR REPLACE. The
-- synthetic backfill skips job_parts that already have line items, so
-- re-running on a fully-migrated DB is a no-op.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;


-- ============================================================================
-- Phase 1: Extensions
-- ============================================================================
-- pg_trgm is the GIN/GIST trigram opclass used by the extended jobs-list
-- search (PR 6). CREATE EXTENSION IF NOT EXISTS is a no-op on Supabase
-- where the extension is already provisioned.

CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ============================================================================
-- Phase 2: shipments
-- ============================================================================
-- one_time_address is reserved for Phase 3 ad-hoc shipping to addresses
-- not on the customer's roster. Either shipping_address_id OR
-- one_time_address must be set (XOR), enforced by
-- shipments_one_address_source. Phase 1 always uses shipping_address_id;
-- the synthetic-legacy backfill below is the only Phase-1 writer that
-- may fall back to a one_time_address sentinel when the customer has no
-- addresses recorded.
--
-- shipping_arrangement is an enum-via-CHECK. The 'other' value requires
-- shipping_arrangement_other to be non-null
-- (shipments_arrangement_other_text).
--
-- voided_at + voided_by are columns on the table from day one even
-- though Phase 1 has no void UI. The trigger family handles the cascade
-- correctly when Phase 3 adds the action.

CREATE TABLE IF NOT EXISTS public.shipments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id),
    customer_id uuid NOT NULL REFERENCES public.customers(id),
    shipping_address_id uuid REFERENCES public.customer_addresses(id),
    one_time_address jsonb,
    packing_slip_number text NOT NULL,
    ship_date date NOT NULL DEFAULT current_date,
    carrier text,
    tracking_number text,
    shipping_arrangement text,
    shipping_arrangement_other text,
    weight_lbs numeric(10,2),
    package_count integer,
    package_type text,
    notes text,
    coc_text text,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    voided_at timestamptz,
    voided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Constraints (gated so re-runs are no-ops)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'shipments_packing_slip_company_unique'
           AND conrelid = 'public.shipments'::regclass
    ) THEN
        ALTER TABLE public.shipments
            ADD CONSTRAINT shipments_packing_slip_company_unique
            UNIQUE (company_id, packing_slip_number);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'shipments_one_address_source'
           AND conrelid = 'public.shipments'::regclass
    ) THEN
        ALTER TABLE public.shipments
            ADD CONSTRAINT shipments_one_address_source
            CHECK (
                (shipping_address_id IS NOT NULL AND one_time_address IS NULL)
             OR (shipping_address_id IS NULL AND one_time_address IS NOT NULL)
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'shipments_shipping_arrangement_check'
           AND conrelid = 'public.shipments'::regclass
    ) THEN
        ALTER TABLE public.shipments
            ADD CONSTRAINT shipments_shipping_arrangement_check
            CHECK (
                shipping_arrangement IS NULL
             OR shipping_arrangement IN (
                    'prepaid_and_add','prepaid','collect','third_party_account',
                    'customer_pickup','customer_arranged_freight','other'
                )
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'shipments_arrangement_other_text'
           AND conrelid = 'public.shipments'::regclass
    ) THEN
        ALTER TABLE public.shipments
            ADD CONSTRAINT shipments_arrangement_other_text
            CHECK (
                shipping_arrangement IS DISTINCT FROM 'other'
             OR shipping_arrangement_other IS NOT NULL
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipments_company
    ON public.shipments (company_id);
CREATE INDEX IF NOT EXISTS idx_shipments_customer
    ON public.shipments (customer_id);
CREATE INDEX IF NOT EXISTS idx_shipments_packing_slip
    ON public.shipments (company_id, packing_slip_number);
CREATE INDEX IF NOT EXISTS idx_shipments_ship_date
    ON public.shipments (company_id, ship_date DESC);

COMMENT ON TABLE public.shipments IS
    'One shipment per packing slip. Drives jobs.fulfillment_status via shipment_line_items + the recompute_job_part_fulfillment trigger family. voided_at + voided_by support the Phase-3 void action; the cascade reverses fulfillment when set.';
COMMENT ON COLUMN public.shipments.one_time_address IS
    'Reserved for Phase 3 ad-hoc shipping. Either shipping_address_id OR one_time_address must be set (XOR shipments_one_address_source).';
COMMENT ON COLUMN public.shipments.shipping_arrangement IS
    'Enum-via-CHECK. ''other'' requires shipping_arrangement_other (shipments_arrangement_other_text).';

-- Integrity trigger. A CHECK cannot reference other rows, so the cross-row
-- assertion "shipping_address_id belongs to customer_id" lives here.
CREATE OR REPLACE FUNCTION public.enforce_shipment_address_contact_customer()
    RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.shipping_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.shipping_address_id
           AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'shipping_address_id % does not belong to customer %',
                NEW.shipping_address_id, NEW.customer_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_shipment_address_contact_customer_trg
    ON public.shipments;
CREATE TRIGGER enforce_shipment_address_contact_customer_trg
    BEFORE INSERT OR UPDATE OF shipping_address_id, customer_id
    ON public.shipments
    FOR EACH ROW EXECUTE FUNCTION public.enforce_shipment_address_contact_customer();

-- RLS
ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view shipments" ON public.shipments;
CREATE POLICY "Users can view shipments"
    ON public.shipments
    FOR SELECT
    USING (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS "Users can insert shipments" ON public.shipments;
CREATE POLICY "Users can insert shipments"
    ON public.shipments
    FOR INSERT
    WITH CHECK (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS "Users can update shipments" ON public.shipments;
CREATE POLICY "Users can update shipments"
    ON public.shipments
    FOR UPDATE
    USING (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS "Users can delete shipments" ON public.shipments;
CREATE POLICY "Users can delete shipments"
    ON public.shipments
    FOR DELETE
    USING (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.shipments;
CREATE POLICY "ai_readonly_select"
    ON public.shipments
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);


-- ============================================================================
-- Phase 3: shipment_line_items
-- ============================================================================
-- One row per (shipment, job_part). quantity must be positive; a shipment
-- can include multiple parts (rolled-up packing slip) or a single part.

CREATE TABLE IF NOT EXISTS public.shipment_line_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
    job_part_id uuid NOT NULL REFERENCES public.job_parts(id),
    quantity numeric(12,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'shipment_line_items_quantity_positive'
           AND conrelid = 'public.shipment_line_items'::regclass
    ) THEN
        ALTER TABLE public.shipment_line_items
            ADD CONSTRAINT shipment_line_items_quantity_positive
            CHECK (quantity > 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipment_line_items_shipment
    ON public.shipment_line_items (shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_line_items_job_part
    ON public.shipment_line_items (job_part_id);

COMMENT ON TABLE public.shipment_line_items IS
    'Single source of truth for "what shipped per job_part". Drives compute_job_part_fulfillment_status via trigger A. Voided shipments contribute zero (filtered by shipments.voided_at IS NULL).';

ALTER TABLE public.shipment_line_items ENABLE ROW LEVEL SECURITY;

-- shipment_line_items has no own company_id; authorize via the parent shipment.
DROP POLICY IF EXISTS "Users can view shipment_line_items" ON public.shipment_line_items;
CREATE POLICY "Users can view shipment_line_items"
    ON public.shipment_line_items
    FOR SELECT
    USING (shipment_id IN (
        SELECT s.id FROM public.shipments s
         WHERE s.company_id IN (SELECT get_user_company_ids())
    ));

DROP POLICY IF EXISTS "Users can insert shipment_line_items" ON public.shipment_line_items;
CREATE POLICY "Users can insert shipment_line_items"
    ON public.shipment_line_items
    FOR INSERT
    WITH CHECK (shipment_id IN (
        SELECT s.id FROM public.shipments s
         WHERE s.company_id IN (SELECT get_user_company_ids())
    ));

DROP POLICY IF EXISTS "Users can update shipment_line_items" ON public.shipment_line_items;
CREATE POLICY "Users can update shipment_line_items"
    ON public.shipment_line_items
    FOR UPDATE
    USING (shipment_id IN (
        SELECT s.id FROM public.shipments s
         WHERE s.company_id IN (SELECT get_user_company_ids())
    ));

DROP POLICY IF EXISTS "Users can delete shipment_line_items" ON public.shipment_line_items;
CREATE POLICY "Users can delete shipment_line_items"
    ON public.shipment_line_items
    FOR DELETE
    USING (shipment_id IN (
        SELECT s.id FROM public.shipments s
         WHERE s.company_id IN (SELECT get_user_company_ids())
    ));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.shipment_line_items;
CREATE POLICY "ai_readonly_select"
    ON public.shipment_line_items
    FOR SELECT
    TO jigged_ai_readonly
    USING (EXISTS (
        SELECT 1 FROM public.shipments s
         WHERE s.id = shipment_line_items.shipment_id
           AND s.company_id = (current_setting('jigged.company_id', true))::uuid
    ));


-- ============================================================================
-- Phase 4: job_fulfillment_audit
-- ============================================================================
-- Append-only causal record of forward transitions
-- (anything → fully_shipped). Reverse transitions (a void that takes a
-- job out of fully_shipped) are captured by the shipment's own
-- voided_at + voided_by columns, not by a new audit row.
--
-- Writes happen inside create_shipment_with_line_items (SECURITY DEFINER).
-- Regular users have SELECT only; no INSERT/UPDATE/DELETE policies.

CREATE TABLE IF NOT EXISTS public.job_fulfillment_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    from_status text,
    to_status text NOT NULL,
    triggering_shipment_id uuid REFERENCES public.shipments(id) ON DELETE SET NULL,
    triggering_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_fulfillment_audit_job
    ON public.job_fulfillment_audit (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_fulfillment_audit_company
    ON public.job_fulfillment_audit (company_id, created_at DESC);

COMMENT ON TABLE public.job_fulfillment_audit IS
    'Forward-transition log into fully_shipped. Written from create_shipment_with_line_items; never from a trigger (no incidental-ordering ambiguity for triggering_shipment_id). Reverse transitions are captured on shipments.voided_at/voided_by.';

ALTER TABLE public.job_fulfillment_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view job_fulfillment_audit" ON public.job_fulfillment_audit;
CREATE POLICY "Users can view job_fulfillment_audit"
    ON public.job_fulfillment_audit
    FOR SELECT
    USING (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS "ai_readonly_select" ON public.job_fulfillment_audit;
CREATE POLICY "ai_readonly_select"
    ON public.job_fulfillment_audit
    FOR SELECT
    TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);


-- ============================================================================
-- Phase 5: Fulfillment computation functions
-- ============================================================================
-- compute_job_part_fulfillment_status: derived from non-voided
-- shipment_line_items.quantity divided by job_parts.quantity.
--   0   shipped → unshipped
--   <ordered → partially_shipped
--   >=ordered → fully_shipped

CREATE OR REPLACE FUNCTION public.compute_job_part_fulfillment_status(p_job_part_id uuid)
    RETURNS text LANGUAGE plpgsql STABLE
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_qty_ordered numeric;
    v_qty_shipped numeric;
BEGIN
    SELECT jp.quantity INTO v_qty_ordered
      FROM public.job_parts jp
     WHERE jp.id = p_job_part_id;
    IF v_qty_ordered IS NULL THEN
        RETURN 'unshipped';
    END IF;

    SELECT COALESCE(SUM(sli.quantity), 0) INTO v_qty_shipped
      FROM public.shipment_line_items sli
      JOIN public.shipments s ON s.id = sli.shipment_id
     WHERE sli.job_part_id = p_job_part_id
       AND s.voided_at IS NULL;

    IF v_qty_shipped <= 0 THEN
        RETURN 'unshipped';
    END IF;
    IF v_qty_shipped >= v_qty_ordered THEN
        RETURN 'fully_shipped';
    END IF;
    RETURN 'partially_shipped';
END $$;

COMMENT ON FUNCTION public.compute_job_part_fulfillment_status(uuid) IS
    'Derived from non-voided shipment_line_items.quantity / job_parts.quantity. Single source of truth for the column value — the trigger family ensures the column matches this function''s output for every row.';

-- compute_job_fulfillment_status: aggregates job_parts.fulfillment_status
-- WITHOUT filtering cancelled parts. PRD §7.1: a job can be
-- production_status='cancelled' AND fulfillment_status='partially_shipped'
-- (customer cancelled the remainder after we shipped some).

CREATE OR REPLACE FUNCTION public.compute_job_fulfillment_status(p_job_id uuid)
    RETURNS text LANGUAGE plpgsql STABLE
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_total int;
    v_full int;
    v_partial int;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE fulfillment_status = 'fully_shipped'),
           count(*) FILTER (WHERE fulfillment_status = 'partially_shipped')
      INTO v_total, v_full, v_partial
      FROM public.job_parts WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'unshipped'; END IF;
    IF v_full = v_total THEN RETURN 'fully_shipped'; END IF;
    IF v_full > 0 OR v_partial > 0 THEN RETURN 'partially_shipped'; END IF;
    RETURN 'unshipped';
END $$;

COMMENT ON FUNCTION public.compute_job_fulfillment_status(uuid) IS
    'Aggregates job_parts.fulfillment_status. Does NOT filter cancelled parts — a cancelled-after-partial-ship job legitimately reports fulfillment_status = partially_shipped (PRD §7.1).';


-- ============================================================================
-- Phase 6: Fulfillment cascade triggers (A / B / C)
-- ============================================================================
-- A: shipment_line_items change → recompute affected job_part
-- B: shipments.voided_at change → recompute every job_part the shipment touched
-- C: job_parts.fulfillment_status change → recompute job
--
-- pg_trigger_depth() > 2 short-circuit guards against accidental recursion
-- under future writers that might daisy-chain edits.

CREATE OR REPLACE FUNCTION public.recompute_job_part_fulfillment_from_line()
    RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_jp_id uuid;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_jp_id := COALESCE(NEW.job_part_id, OLD.job_part_id);
    v_new := public.compute_job_part_fulfillment_status(v_jp_id);
    SELECT fulfillment_status INTO v_old
      FROM public.job_parts WHERE id = v_jp_id;
    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.job_parts
           SET fulfillment_status = v_new,
               updated_at = now()
         WHERE id = v_jp_id;
    END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trigger_recompute_jp_fulfillment_on_line_ins ON public.shipment_line_items;
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_line_ins
    AFTER INSERT ON public.shipment_line_items
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_part_fulfillment_from_line();

DROP TRIGGER IF EXISTS trigger_recompute_jp_fulfillment_on_line_upd ON public.shipment_line_items;
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_line_upd
    AFTER UPDATE OF quantity, job_part_id, shipment_id ON public.shipment_line_items
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_part_fulfillment_from_line();

DROP TRIGGER IF EXISTS trigger_recompute_jp_fulfillment_on_line_del ON public.shipment_line_items;
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_line_del
    AFTER DELETE ON public.shipment_line_items
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_part_fulfillment_from_line();


CREATE OR REPLACE FUNCTION public.recompute_job_part_fulfillment_from_void()
    RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
DECLARE
    r record;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    IF NEW.voided_at IS NOT DISTINCT FROM OLD.voided_at THEN RETURN NULL; END IF;
    FOR r IN
        SELECT DISTINCT sli.job_part_id
          FROM public.shipment_line_items sli
         WHERE sli.shipment_id = NEW.id
    LOOP
        v_new := public.compute_job_part_fulfillment_status(r.job_part_id);
        SELECT fulfillment_status INTO v_old
          FROM public.job_parts WHERE id = r.job_part_id;
        IF v_new IS DISTINCT FROM v_old THEN
            UPDATE public.job_parts
               SET fulfillment_status = v_new,
                   updated_at = now()
             WHERE id = r.job_part_id;
        END IF;
    END LOOP;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trigger_recompute_jp_fulfillment_on_void ON public.shipments;
CREATE TRIGGER trigger_recompute_jp_fulfillment_on_void
    AFTER UPDATE OF voided_at ON public.shipments
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_part_fulfillment_from_void();


CREATE OR REPLACE FUNCTION public.sync_job_fulfillment_status_from_parts()
    RETURNS trigger LANGUAGE plpgsql
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_job_id uuid;
    v_new text;
    v_old text;
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new := public.compute_job_fulfillment_status(v_job_id);
    SELECT fulfillment_status INTO v_old
      FROM public.jobs WHERE id = v_job_id;
    IF v_new IS DISTINCT FROM v_old THEN
        UPDATE public.jobs
           SET fulfillment_status = v_new,
               updated_at = now()
         WHERE id = v_job_id;
    END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trigger_sync_job_fulfillment_from_parts_ins ON public.job_parts;
CREATE TRIGGER trigger_sync_job_fulfillment_from_parts_ins
    AFTER INSERT ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION public.sync_job_fulfillment_status_from_parts();

DROP TRIGGER IF EXISTS trigger_sync_job_fulfillment_from_parts_upd ON public.job_parts;
CREATE TRIGGER trigger_sync_job_fulfillment_from_parts_upd
    AFTER UPDATE OF fulfillment_status ON public.job_parts
    FOR EACH ROW
    WHEN (OLD.fulfillment_status IS DISTINCT FROM NEW.fulfillment_status)
    EXECUTE FUNCTION public.sync_job_fulfillment_status_from_parts();

DROP TRIGGER IF EXISTS trigger_sync_job_fulfillment_from_parts_del ON public.job_parts;
CREATE TRIGGER trigger_sync_job_fulfillment_from_parts_del
    AFTER DELETE ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION public.sync_job_fulfillment_status_from_parts();


-- ============================================================================
-- Phase 7: Packing-slip number generation
-- ============================================================================
-- format_packing_slip_number is a pure template substitutor. IMMUTABLE so
-- the planner can fold constant calls. The {seq:0...0} token determines
-- zero-padding width from the count of zeros (e.g. {seq:0000} → 0042).
--
-- next_packing_slip_number is the atomic counter. UPDATE ... RETURNING on
-- companies takes a per-row lock for the duration of the transaction;
-- concurrent calls serialize on that lock, so the returned sequence
-- numbers are guaranteed distinct and gap-free per company per year.
-- Year boundary uses current_date (server-UTC on Supabase); per-company
-- timezone reset is a future-Phase enhancement noted in the column COMMENT.

CREATE OR REPLACE FUNCTION public.format_packing_slip_number(
    p_format text,
    p_year int,
    p_seq int
) RETURNS text LANGUAGE plpgsql IMMUTABLE
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_result text := p_format;
    v_pad_match text;
    v_width int;
BEGIN
    v_result := replace(v_result, '{YYYY}', p_year::text);
    v_pad_match := substring(v_result FROM '\{seq:(0+)\}');
    IF v_pad_match IS NOT NULL THEN
        v_width := length(v_pad_match);
        v_result := regexp_replace(v_result, '\{seq:0+\}', lpad(p_seq::text, v_width, '0'));
    ELSE
        v_result := replace(v_result, '{seq}', p_seq::text);
    END IF;
    RETURN v_result;
END $$;

COMMENT ON FUNCTION public.format_packing_slip_number(text,int,int) IS
    'Pure template substitutor for packing-slip numbers. Tokens: {YYYY} = year, {seq:0...0} = zero-padded sequence (width = zero-count), {seq} = un-padded. IMMUTABLE.';

CREATE OR REPLACE FUNCTION public.next_packing_slip_number(p_company_id uuid)
    RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_year int := EXTRACT(year FROM current_date)::int;
    v_format text;
    v_current_year int;
    v_current_seq int;
    v_seq int;
BEGIN
    -- Defensive: a caller without company access must not be able to
    -- advance another company's counter, even though SECURITY DEFINER
    -- bypasses RLS.
    IF NOT (p_company_id IN (SELECT get_user_company_ids())) THEN
        RAISE EXCEPTION 'next_packing_slip_number: caller does not have access to company %', p_company_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE public.companies
       SET packing_slip_next_seq = CASE
               WHEN packing_slip_seq_year = v_year THEN packing_slip_next_seq + 1
               ELSE 2  -- next caller gets 2; this caller consumes seq 1
           END,
           packing_slip_seq_year = v_year,
           updated_at = now()
     WHERE id = p_company_id
    RETURNING packing_slip_seq_year, packing_slip_next_seq, packing_slip_number_format
        INTO v_current_year, v_current_seq, v_format;

    IF v_current_year IS NULL THEN
        RAISE EXCEPTION 'next_packing_slip_number: company % not found', p_company_id;
    END IF;

    v_seq := v_current_seq - 1;
    RETURN public.format_packing_slip_number(v_format, v_year, v_seq);
END $$;

COMMENT ON FUNCTION public.next_packing_slip_number(uuid) IS
    'Atomic per-company counter. Row-level lock via UPDATE...RETURNING serializes concurrent callers — no PS# collisions possible. SECURITY DEFINER + explicit company-membership guard.';

REVOKE ALL ON FUNCTION public.next_packing_slip_number(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_packing_slip_number(uuid) TO authenticated;


-- ============================================================================
-- Phase 8: create_shipment_with_line_items RPC
-- ============================================================================
-- Single-transaction shipment creation. Acquires a sorted advisory lock
-- per affected job_id (deadlock-free), snapshots pre-cascade
-- fulfillment_status for every locked job, inserts the shipment + line
-- items (cascading triggers run), then writes audit rows from the RPC
-- itself for every job that transitioned forward into fully_shipped.
-- Reverse transitions (voids) are NOT audited here — that's the
-- shipment's own voided_at/voided_by columns.
--
-- SECURITY DEFINER with explicit company-membership guard. Triggers fired
-- inside this RPC inherit the elevated context, so RLS does not block
-- the cascade updates.

CREATE OR REPLACE FUNCTION public.create_shipment_with_line_items(
    p_company_id uuid,
    p_customer_id uuid,
    p_shipping_address_id uuid,
    p_one_time_address jsonb,
    p_ship_date date,
    p_carrier text,
    p_tracking_number text,
    p_shipping_arrangement text,
    p_shipping_arrangement_other text,
    p_weight_lbs numeric,
    p_package_count int,
    p_package_type text,
    p_notes text,
    p_coc_text text,
    p_line_items jsonb
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_packing_slip text;
    v_shipment_id uuid;
    v_user_id uuid := auth.uid();
    v_item jsonb;
    v_pre_status jsonb := '{}'::jsonb;
    v_job_id uuid;
    r record;
BEGIN
    IF NOT (p_company_id IN (SELECT get_user_company_ids())) THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: caller does not have access to company %',
            p_company_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 1. Acquire per-job advisory locks in sorted order to prevent
    --    deadlock between concurrent RPCs touching the same job set.
    --    pg_advisory_xact_lock is released at COMMIT/ROLLBACK.
    FOR v_job_id IN
        SELECT DISTINCT jp.job_id
          FROM public.job_parts jp
         WHERE jp.id IN (
            SELECT (item->>'job_part_id')::uuid
              FROM jsonb_array_elements(p_line_items) AS item
         )
         ORDER BY jp.job_id
    LOOP
        PERFORM pg_advisory_xact_lock(hashtext('job:' || v_job_id::text));
    END LOOP;

    -- 2. Snapshot pre-cascade fulfillment_status.
    SELECT COALESCE(jsonb_object_agg(j.id::text, j.fulfillment_status), '{}'::jsonb)
      INTO v_pre_status
      FROM public.jobs j
     WHERE j.id IN (
        SELECT DISTINCT jp.job_id FROM public.job_parts jp
         WHERE jp.id IN (
            SELECT (item->>'job_part_id')::uuid
              FROM jsonb_array_elements(p_line_items) AS item
         )
     );

    -- 3. Mint packing slip number.
    v_packing_slip := public.next_packing_slip_number(p_company_id);

    -- 4. Insert shipment + line items. Triggers A → C cascade automatically.
    INSERT INTO public.shipments (
        company_id, customer_id, shipping_address_id, one_time_address,
        packing_slip_number, ship_date, carrier, tracking_number,
        shipping_arrangement, shipping_arrangement_other,
        weight_lbs, package_count, package_type, notes, coc_text,
        created_by
    ) VALUES (
        p_company_id, p_customer_id, p_shipping_address_id, p_one_time_address,
        v_packing_slip, COALESCE(p_ship_date, current_date), p_carrier, p_tracking_number,
        p_shipping_arrangement, p_shipping_arrangement_other,
        p_weight_lbs, p_package_count, p_package_type, p_notes, p_coc_text,
        v_user_id
    ) RETURNING id INTO v_shipment_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_line_items) LOOP
        INSERT INTO public.shipment_line_items (shipment_id, job_part_id, quantity)
        VALUES (
            v_shipment_id,
            (v_item->>'job_part_id')::uuid,
            (v_item->>'quantity')::numeric
        );
    END LOOP;

    -- 5. For each touched job, write an audit row IFF it crossed
    --    forward into fully_shipped. v_pre_status defaults to '{}' so the
    --    loop no-ops when p_line_items is empty.
    FOR r IN
        SELECT j.id AS job_id, j.fulfillment_status AS new_status,
               v_pre_status->>(j.id::text) AS old_status
          FROM public.jobs j
         WHERE j.id::text IN (SELECT jsonb_object_keys(v_pre_status))
    LOOP
        IF r.new_status = 'fully_shipped'
           AND r.old_status IS DISTINCT FROM 'fully_shipped' THEN
            INSERT INTO public.job_fulfillment_audit (
                job_id, company_id, from_status, to_status,
                triggering_shipment_id, triggering_user_id
            ) VALUES (
                r.job_id, p_company_id, r.old_status, r.new_status,
                v_shipment_id, v_user_id
            );
        END IF;
    END LOOP;

    RETURN v_shipment_id;
END $$;

COMMENT ON FUNCTION public.create_shipment_with_line_items(
    uuid, uuid, uuid, jsonb, date, text, text, text, text, numeric, int, text, text, text, jsonb
) IS
    'Atomic shipment creation: sorted advisory lock per affected job → snapshot pre-cascade → insert shipment + line items (cascade fires) → write audit rows for forward transitions into fully_shipped. SECURITY DEFINER with explicit company-membership guard.';

REVOKE ALL ON FUNCTION public.create_shipment_with_line_items(
    uuid, uuid, uuid, jsonb, date, text, text, text, text, numeric, int, text, text, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_shipment_with_line_items(
    uuid, uuid, uuid, jsonb, date, text, text, text, text, numeric, int, text, text, text, jsonb
) TO authenticated;


-- ============================================================================
-- Phase 9: Replace ship-date helper stubs with real implementations
-- ============================================================================
-- PR 3 created NULL-returning stubs so the 26 legacy shipped_at read
-- sites could be rewritten in PR 3. PR 4 swaps in the real bodies.

CREATE OR REPLACE FUNCTION public.job_part_last_ship_date(p_job_part_id uuid)
    RETURNS date LANGUAGE sql STABLE
    SET search_path = public, pg_temp
AS $$
    SELECT MAX(s.ship_date)
      FROM public.shipments s
      JOIN public.shipment_line_items sli ON sli.shipment_id = s.id
     WHERE s.voided_at IS NULL
       AND sli.job_part_id = p_job_part_id;
$$;

CREATE OR REPLACE FUNCTION public.job_last_ship_date(p_job_id uuid)
    RETURNS date LANGUAGE sql STABLE
    SET search_path = public, pg_temp
AS $$
    SELECT MAX(s.ship_date)
      FROM public.shipments s
      JOIN public.shipment_line_items sli ON sli.shipment_id = s.id
      JOIN public.job_parts jp ON jp.id = sli.job_part_id
     WHERE s.voided_at IS NULL
       AND jp.job_id = p_job_id;
$$;

COMMENT ON FUNCTION public.job_last_ship_date(uuid) IS
    'Most recent non-voided ship date for any line item belonging to the job. NULL if no shipments. Replaces the dropped jobs.shipped_at column for all 26 legacy read sites.';
COMMENT ON FUNCTION public.job_part_last_ship_date(uuid) IS
    'Most recent non-voided ship date for the job_part. NULL if no shipments. Replaces the dropped job_parts.shipped_at column.';


-- ============================================================================
-- Phase 10: Trigram indexes for the jobs-list extended search (PR 6)
-- ============================================================================
-- pg_trgm GIN indexes make `ILIKE '%pattern%'` fast on the five search
-- fields the extended search hits. Consumed by the
-- search_jobs_by_identifier RPC (PR 6).

CREATE INDEX IF NOT EXISTS idx_jobs_job_number_trgm
    ON public.jobs USING gin (job_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_quotes_customer_po_number_trgm
    ON public.quotes USING gin (customer_po_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm
    ON public.customers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_parts_part_number_trgm
    ON public.parts USING gin (part_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shipments_packing_slip_trgm
    ON public.shipments USING gin (packing_slip_number gin_trgm_ops);


-- ============================================================================
-- Phase 11: Synthetic legacy shipments backfill
-- ============================================================================
-- Every job_part that PR 3 marked fulfillment_status = 'fully_shipped'
-- (because its old status was 'shipped') gets a synthetic shipment row
-- so that compute_job_part_fulfillment_status(jp.id) agrees with the
-- column for legacy data. Without this, legacy rows would have the
-- column saying "fully_shipped" while the function returns "unshipped"
-- — a permanent two-source-of-truth divergence. Per CLAUDE.md "no
-- silent runtime fallbacks for data-at-rest issues."
--
-- One synthetic shipment per job (multiple shipped job_parts on the
-- same job roll up into one packing slip). Address resolved via the
-- customer's default_shipping → default_billing, falling back to a
-- one_time_address sentinel if neither exists.
--
-- The DO block at the bottom is gated by
-- `NOT EXISTS (SELECT 1 FROM shipment_line_items WHERE job_part_id = jp.id)`,
-- so re-running the migration after backfill is a no-op.

CREATE OR REPLACE FUNCTION public._migrate_legacy_shipment_for_job(p_job_id uuid)
    RETURNS uuid LANGUAGE plpgsql VOLATILE
    SET search_path = public, pg_temp
AS $$
DECLARE
    v_job record;
    v_shipment_id uuid;
    v_ps text;
    v_address_id uuid;
    v_format text;
    v_year int;
    v_current_year int;
    v_current_seq int;
BEGIN
    SELECT j.id, j.company_id, j.customer_id,
           COALESCE(j.completed_at::date, j.updated_at::date, current_date) AS ship_date
      INTO v_job
      FROM public.jobs j WHERE j.id = p_job_id;

    -- Address resolution: default_shipping → default_billing → sentinel.
    SELECT COALESCE(
        (SELECT a.id FROM public.customer_addresses a
          WHERE a.customer_id = v_job.customer_id AND a.default_shipping = true LIMIT 1),
        (SELECT a.id FROM public.customer_addresses a
          WHERE a.customer_id = v_job.customer_id AND a.default_billing = true LIMIT 1)
    ) INTO v_address_id;

    -- Mint the PS#. This function is invoked at migration time as the
    -- migration role (superuser/postgres), so the SECURITY DEFINER
    -- company-access guard inside next_packing_slip_number would block
    -- it. Inline a copy of the increment logic here — equivalent
    -- arithmetic, no auth check.
    v_year := EXTRACT(year FROM v_job.ship_date)::int;
    UPDATE public.companies
       SET packing_slip_next_seq = CASE
               WHEN packing_slip_seq_year = v_year THEN packing_slip_next_seq + 1
               ELSE 2
           END,
           packing_slip_seq_year = v_year,
           updated_at = now()
     WHERE id = v_job.company_id
    RETURNING packing_slip_seq_year, packing_slip_next_seq, packing_slip_number_format
        INTO v_current_year, v_current_seq, v_format;
    v_ps := public.format_packing_slip_number(v_format, v_year, v_current_seq - 1);

    INSERT INTO public.shipments (
        company_id, customer_id, shipping_address_id, one_time_address,
        packing_slip_number, ship_date, notes,
        created_by, created_at
    ) VALUES (
        v_job.company_id, v_job.customer_id,
        v_address_id,
        CASE WHEN v_address_id IS NULL
             THEN jsonb_build_object(
                'legacy', true,
                'note', 'Address unknown at migration time'
             )
             ELSE NULL END,
        v_ps, v_job.ship_date,
        'Legacy migration: historical shipment imported on schema migration',
        NULL, v_job.ship_date::timestamptz
    ) RETURNING id INTO v_shipment_id;

    INSERT INTO public.shipment_line_items (shipment_id, job_part_id, quantity)
    SELECT v_shipment_id, jp.id, jp.quantity
      FROM public.job_parts jp
     WHERE jp.job_id = p_job_id
       AND jp.fulfillment_status = 'fully_shipped'
       AND NOT EXISTS (
           SELECT 1 FROM public.shipment_line_items sli WHERE sli.job_part_id = jp.id
       );

    RETURN v_shipment_id;
END $$;

REVOKE ALL ON FUNCTION public._migrate_legacy_shipment_for_job(uuid) FROM PUBLIC;

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT jp.job_id
          FROM public.job_parts jp
         WHERE jp.fulfillment_status = 'fully_shipped'
           AND NOT EXISTS (
               SELECT 1 FROM public.shipment_line_items sli
                WHERE sli.job_part_id = jp.id
           )
    LOOP
        PERFORM public._migrate_legacy_shipment_for_job(r.job_id);
    END LOOP;
END $$;


COMMIT;
