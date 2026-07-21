-- Partial quantity completion on operations.
--
-- Today an operation is whole-or-nothing: job_operations.status is a bare
-- pending/in_progress/completed with NO quantity. An operator who finishes 3 of
-- 12 pieces can only leave a free-text note ("3 done, 9 to go"). This migration
-- makes operation-level quantity progress first-class, MIRRORING the existing
-- partial-shipment / partial-invoice pattern:
--
--   * a new append-only child table job_operation_completions carrying per-event
--     quantity_good (the Jigged-side source of truth for "how much of this op is
--     done"), with voided_at/voided_by for corrections — never edit-in-place;
--   * job_operations.status is now DERIVED from those events vs the part's ordered
--     quantity (job_parts.quantity), by a trigger cloned from the fulfillment /
--     invoicing status families. The status ENUM is unchanged, so every existing
--     rollup (recomputeJobPartStatus, compute_job_production_status) keeps working.
--
-- v1 decisions (see docs/modules/partial-operation-completion-design.md):
--   * GOOD-ONLY: quantity_scrap is deferred (additive later; no rollup impact).
--   * OVER-COMPLETION WARNED, NOT BLOCKED: the only hard floor is quantity_good > 0
--     (follows shipments, not invoices — extra good parts are legitimate, no money).
--   * FULLY DECOUPLED FROM MONEY: this touches production_status only. Nothing here
--     changes fulfillment_status (shippable) or invoicing_status (invoiceable).

-- ============================================================================
-- 1. job_operation_completions: per-event good-quantity, append-only
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.job_operation_completions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL,
    job_operation_id uuid NOT NULL,
    -- denormalized-from-operation for rollup-query convenience + parity with
    -- shipment_line_items / quickbooks_invoice_line_items (both carry job_part_id).
    job_part_id uuid NOT NULL,
    quantity_good numeric NOT NULL,
    completed_by uuid,               -- who (auth.users(id), like job_operations.completed_by)
    completed_at timestamptz NOT NULL DEFAULT now(),  -- when
    note text,                       -- optional free-text (the "reason" affordance)
    -- Correction path: void + re-enter, never mutate a recorded event. Filtered
    -- everywhere from day one so a future "void UI" needs no schema change.
    voided_at timestamptz,
    voided_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT job_operation_completions_pkey PRIMARY KEY (id),
    -- the ONLY hard quantity floor (over-completion is allowed, only positivity isn't).
    CONSTRAINT job_op_completions_quantity_positive CHECK (quantity_good > 0),
    CONSTRAINT job_op_completions_note_not_blank CHECK (note IS NULL OR length(btrim(note)) > 0),
    CONSTRAINT job_op_completions_company_fk FOREIGN KEY (company_id)
        REFERENCES public.companies(id) ON DELETE CASCADE,
    -- CASCADE: an op deleted with its job/part takes its completion history with it.
    CONSTRAINT job_op_completions_operation_fk FOREIGN KEY (job_operation_id)
        REFERENCES public.job_operations(id) ON DELETE CASCADE,
    CONSTRAINT job_op_completions_job_part_fk FOREIGN KEY (job_part_id)
        REFERENCES public.job_parts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_op_completions_operation
    ON public.job_operation_completions (job_operation_id);
CREATE INDEX IF NOT EXISTS idx_job_op_completions_job_part
    ON public.job_operation_completions (job_part_id);

-- Data API grants (CLAUDE.md: new public tables need explicit grants). Member-scoped
-- reads + writes; the void stamp is an UPDATE, so authenticated needs UPDATE too.
-- No anon access: operator/admin completion always runs signed-in.
ALTER TABLE public.job_operation_completions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their company's operation completions" ON public.job_operation_completions;
CREATE POLICY "Users can view their company's operation completions"
    ON public.job_operation_completions
    FOR SELECT
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can insert their company's operation completions" ON public.job_operation_completions;
CREATE POLICY "Users can insert their company's operation completions"
    ON public.job_operation_completions
    FOR INSERT
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

DROP POLICY IF EXISTS "Users can update their company's operation completions" ON public.job_operation_completions;
CREATE POLICY "Users can update their company's operation completions"
    ON public.job_operation_completions
    FOR UPDATE
    USING ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)))
    WITH CHECK ((company_id IN ( SELECT get_user_company_ids() AS get_user_company_ids)));

GRANT SELECT, INSERT, UPDATE ON public.job_operation_completions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_operation_completions TO service_role;

CREATE TRIGGER job_operation_completions_updated_at
    BEFORE UPDATE ON public.job_operation_completions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 2. Compute functions (op status from events; part status from op statuses)
-- ============================================================================

-- Op-level truth: SUM(non-void good) vs the part's ordered quantity (the target —
-- every op on a part must produce the full part quantity of good pieces).
--   good == 0            -> pending
--   0 < good < target    -> in_progress
--   good >= target       -> completed   (>= so over-completion still completes)
CREATE OR REPLACE FUNCTION public.compute_job_operation_status(p_job_operation_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_target numeric;
    v_good numeric;
BEGIN
    SELECT jp.quantity INTO v_target
      FROM public.job_operations o
      JOIN public.job_parts jp ON jp.id = o.job_part_id
     WHERE o.id = p_job_operation_id;

    SELECT COALESCE(SUM(c.quantity_good), 0) INTO v_good
      FROM public.job_operation_completions c
     WHERE c.job_operation_id = p_job_operation_id
       AND c.voided_at IS NULL;

    IF v_good <= 0 THEN
        RETURN 'pending';
    END IF;
    IF v_target IS NOT NULL AND v_good >= v_target THEN
        RETURN 'completed';
    END IF;
    RETURN 'in_progress';
END $function$;

-- Part-level truth from its operation statuses. Mirrors the app-side
-- deriveStatusFromOps (utils/jobsAccess.ts): all ops completed -> completed; any
-- op started (non-pending) -> in_progress; else not_started. 'cancelled' is a
-- terminal user state and is never overwritten; a part with no ops keeps its
-- current status (matches the app rollup's skip).
CREATE OR REPLACE FUNCTION public.compute_job_part_production_status(p_job_part_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_current text;
    v_total int;
    v_completed int;
    v_active int;
BEGIN
    SELECT production_status INTO v_current FROM public.job_parts WHERE id = p_job_part_id;
    IF v_current IS NULL OR v_current = 'cancelled' THEN
        RETURN v_current;
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE status = 'completed'),
           count(*) FILTER (WHERE status <> 'pending')
      INTO v_total, v_completed, v_active
      FROM public.job_operations WHERE job_part_id = p_job_part_id;

    IF v_total = 0 THEN RETURN v_current; END IF;
    IF v_completed = v_total THEN RETURN 'completed'; END IF;
    IF v_active > 0 THEN RETURN 'in_progress'; END IF;
    RETURN 'not_started';
END $function$;

-- ============================================================================
-- 3. Trigger functions (completion -> op.status -> part.production_status)
-- ============================================================================

-- Recompute a single operation's status + completion stamps from the events on
-- it, then recompute its parent job_part's production_status IN THE SAME function
-- (depth 1). Doing the part rollup here rather than in a separate op-status
-- trigger keeps the whole cascade within trigger depth 2 for the existing
-- part->job production trigger (which bails at depth > 2); a
-- completion->op->part->job chain of separate triggers would hit depth 3 and the
-- job rollup would be suppressed.
CREATE OR REPLACE FUNCTION public.recompute_job_operation_status_from_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_op uuid;
    v_jp uuid;
    v_op_new text;
    v_op_old text;
    v_part_new text;
    v_part_old text;
BEGIN
    IF pg_trigger_depth() > 4 THEN RETURN NULL; END IF;
    v_op := COALESCE(NEW.job_operation_id, OLD.job_operation_id);

    -- 3a. operation status + stamps
    SELECT status, job_part_id INTO v_op_old, v_jp
      FROM public.job_operations WHERE id = v_op;
    IF v_jp IS NULL THEN RETURN NULL; END IF;   -- op was deleted (CASCADE); nothing to do

    v_op_new := public.compute_job_operation_status(v_op);
    IF v_op_new IS DISTINCT FROM v_op_old THEN
        UPDATE public.job_operations SET
            status = v_op_new,
            -- Only ever set on a real transition (this IF), so now() is the moment
            -- it crossed the threshold. Backfill of already-completed ops does NOT
            -- change status, so their historical completed_at is preserved.
            completed_at = CASE WHEN v_op_new = 'completed' THEN now() ELSE NULL END,
            completed_by = CASE
                WHEN v_op_new = 'completed' THEN (
                    SELECT c.completed_by FROM public.job_operation_completions c
                     WHERE c.job_operation_id = v_op AND c.voided_at IS NULL
                     ORDER BY c.completed_at DESC LIMIT 1)
                ELSE NULL END,
            updated_at = now()
        WHERE id = v_op;
    END IF;

    -- 3b. job_part production_status (fires the existing part->job trigger at depth 2)
    v_part_new := public.compute_job_part_production_status(v_jp);
    SELECT production_status INTO v_part_old FROM public.job_parts WHERE id = v_jp;
    IF v_part_new IS DISTINCT FROM v_part_old THEN
        UPDATE public.job_parts SET
            production_status = v_part_new,
            started_at = CASE
                WHEN v_part_new IN ('in_progress', 'completed') AND started_at IS NULL
                THEN now() ELSE started_at END,
            completed_at = CASE
                WHEN v_part_new = 'completed' THEN COALESCE(completed_at, now())
                ELSE NULL END,
            status_changed_at = now(),
            updated_at = now()
        WHERE id = v_jp;
    END IF;

    RETURN NULL;
END $function$;

-- job_parts.quantity edit changes the TARGET (denominator): raising 10 -> 20
-- reopens a completed op whose good (10) is now < target. Recompute every op on
-- the part, then the part's production_status. Mirrors the fulfillment/invoicing
-- families' recompute_*_from_qty.
CREATE OR REPLACE FUNCTION public.recompute_job_ops_status_from_part_qty()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    r record;
    v_new text;
    v_old text;
    v_part_new text;
BEGIN
    IF pg_trigger_depth() > 4 THEN RETURN NULL; END IF;
    FOR r IN SELECT id, status FROM public.job_operations WHERE job_part_id = NEW.id LOOP
        v_new := public.compute_job_operation_status(r.id);
        v_old := r.status;
        IF v_new IS DISTINCT FROM v_old THEN
            UPDATE public.job_operations SET
                status = v_new,
                completed_at = CASE WHEN v_new = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END,
                completed_by = CASE WHEN v_new = 'completed' THEN completed_by ELSE NULL END,
                updated_at = now()
            WHERE id = r.id;
        END IF;
    END LOOP;

    v_part_new := public.compute_job_part_production_status(NEW.id);
    IF v_part_new IS DISTINCT FROM NEW.production_status THEN
        UPDATE public.job_parts SET
            production_status = v_part_new,
            completed_at = CASE WHEN v_part_new = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END,
            status_changed_at = now(),
            updated_at = now()
        WHERE id = NEW.id;
    END IF;
    RETURN NULL;
END $function$;

-- ============================================================================
-- 4. Triggers
-- ============================================================================

-- completion ins / void-or-qty upd / del -> op status + part rollup
DROP TRIGGER IF EXISTS trigger_recompute_op_status_on_completion_ins ON public.job_operation_completions;
CREATE TRIGGER trigger_recompute_op_status_on_completion_ins
    AFTER INSERT ON public.job_operation_completions
    FOR EACH ROW EXECUTE FUNCTION recompute_job_operation_status_from_completion();
DROP TRIGGER IF EXISTS trigger_recompute_op_status_on_completion_upd ON public.job_operation_completions;
CREATE TRIGGER trigger_recompute_op_status_on_completion_upd
    AFTER UPDATE OF quantity_good, voided_at, job_operation_id ON public.job_operation_completions
    FOR EACH ROW EXECUTE FUNCTION recompute_job_operation_status_from_completion();
DROP TRIGGER IF EXISTS trigger_recompute_op_status_on_completion_del ON public.job_operation_completions;
CREATE TRIGGER trigger_recompute_op_status_on_completion_del
    AFTER DELETE ON public.job_operation_completions
    FOR EACH ROW EXECUTE FUNCTION recompute_job_operation_status_from_completion();

-- job_part qty edit -> op statuses + part rollup
DROP TRIGGER IF EXISTS trigger_recompute_op_status_on_part_qty ON public.job_parts;
CREATE TRIGGER trigger_recompute_op_status_on_part_qty
    AFTER UPDATE OF quantity ON public.job_parts
    FOR EACH ROW WHEN (old.quantity IS DISTINCT FROM new.quantity)
    EXECUTE FUNCTION recompute_job_ops_status_from_part_qty();

-- ============================================================================
-- 5. Backfill (CLAUDE.md: every existing row satisfies the new invariant at rest;
--    no runtime "compute if empty" fallback)
-- ============================================================================

-- 5a. Pre-check: an op-level in_progress with no way to infer a quantity will
-- resolve to 'pending' (there's no event to justify in_progress). In practice
-- op-level in_progress is unused (ops go straight pending -> completed;
-- in_progress is only ever set on the job_part). Log the count rather than abort
-- — 'pending' is the honest, invariant-satisfying resolution for an
-- operator-abandoned start, and 5c makes the stored value match.
DO $$
DECLARE v_orphan int;
BEGIN
    SELECT count(*) INTO v_orphan FROM public.job_operations WHERE status = 'in_progress';
    IF v_orphan > 0 THEN
        RAISE NOTICE 'job_operation_completions backfill: % op(s) are in_progress with no events; they resolve to pending (5c).', v_orphan;
    END IF;
END $$;

-- 5b. One completion event per already-completed op. Whole-op completion meant
-- "all of it", so quantity_good = the part's ordered quantity; who/when copied from
-- the op. The recompute trigger fires but does NOT change status (already
-- completed == derived completed), so historical completed_at/by are preserved.
INSERT INTO public.job_operation_completions
    (company_id, job_operation_id, job_part_id, quantity_good, completed_by, completed_at)
SELECT jp.company_id, o.id, o.job_part_id, jp.quantity, o.completed_by,
       COALESCE(o.completed_at, o.updated_at, now())
  FROM public.job_operations o
  JOIN public.job_parts jp ON jp.id = o.job_part_id
 WHERE o.status = 'completed'
   AND jp.quantity > 0;

-- 5c. Make every stored status match the derived invariant AT REST — no drift,
-- no runtime "compute if empty" fallback (CLAUDE.md). Completed ops with a
-- backfilled full-qty event stay completed (historical completed_at preserved);
-- an in_progress op with no event resolves to pending. Then recompute part
-- production_status from the (now-consistent) op statuses; the part->job sync
-- trigger cascades to jobs. Cancelled parts are left untouched.
UPDATE public.job_operations o
   SET status = public.compute_job_operation_status(o.id),
       completed_at = CASE WHEN public.compute_job_operation_status(o.id) = 'completed'
                           THEN o.completed_at ELSE NULL END,
       completed_by = CASE WHEN public.compute_job_operation_status(o.id) = 'completed'
                           THEN o.completed_by ELSE NULL END
 WHERE o.status IS DISTINCT FROM public.compute_job_operation_status(o.id);

UPDATE public.job_parts jp
   SET production_status = public.compute_job_part_production_status(jp.id),
       status_changed_at = now()
 WHERE jp.production_status <> 'cancelled'
   AND jp.production_status IS DISTINCT FROM public.compute_job_part_production_status(jp.id);

-- ============================================================================
-- 6. Comments
-- ============================================================================
COMMENT ON TABLE public.job_operation_completions IS
  'Append-only per-event good-quantity for partial operation completion. Source of truth for "how much of a job_operation is done" (non-void events). Corrections are void (voided_at) + re-enter, never edit-in-place. quantity_scrap is deferred (v1 is good-only).';
COMMENT ON FUNCTION public.compute_job_operation_status(uuid) IS
  'Single source of truth for a job_operation''s status: SUM(non-void quantity_good) vs the part''s ordered quantity. good==0 -> pending; partial -> in_progress; >= target -> completed. Clone of compute_job_part_fulfillment_status.';
COMMENT ON FUNCTION public.compute_job_part_production_status(uuid) IS
  'Derives a job_part''s production_status from its operation statuses (SQL mirror of the app-side deriveStatusFromOps). Never overwrites cancelled; leaves a no-op part unchanged.';

-- ============================================================================
-- Reversibility (documentation — the branching pipeline is forward-only)
-- ============================================================================
-- This migration is additive and cleanly reversible with ZERO data loss. To
-- revert, run in a new migration:
--
--   DROP TRIGGER IF EXISTS trigger_recompute_op_status_on_part_qty ON public.job_parts;
--   DROP TRIGGER IF EXISTS trigger_recompute_op_status_on_completion_del ON public.job_operation_completions;
--   DROP TRIGGER IF EXISTS trigger_recompute_op_status_on_completion_upd ON public.job_operation_completions;
--   DROP TRIGGER IF EXISTS trigger_recompute_op_status_on_completion_ins ON public.job_operation_completions;
--   DROP FUNCTION IF EXISTS public.recompute_job_ops_status_from_part_qty();
--   DROP FUNCTION IF EXISTS public.recompute_job_operation_status_from_completion();
--   DROP FUNCTION IF EXISTS public.compute_job_part_production_status(uuid);
--   DROP FUNCTION IF EXISTS public.compute_job_operation_status(uuid);
--   DROP TABLE IF EXISTS public.job_operation_completions;
--
-- job_operations.status / completed_at / completed_by are REAL columns the
-- triggers maintain (never replaced), so after the drop they still hold valid
-- last-computed values and manual whole-op completion works exactly as before.
