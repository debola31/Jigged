-- ============================================================================
-- Shipments — PR 3: dual-status migration (production + fulfillment)
-- ============================================================================
--
-- Context. Today jobs and job_parts carry a single `status` enum that
-- conflates two independent lifecycles:
--   - What's happening in the shop (not_started / in_progress / completed / cancelled)
--   - What's physically left the building (unshipped / partially_shipped / fully_shipped)
-- The existing `shipped` value tries to do both at once and breaks the
-- moment real shipments exist (e.g. partial shipments while production
-- continues). See docs/modules/PRD-shipments-2.md §7 for the full
-- argument.
--
-- This migration splits the single column into two:
--   production_status  text NOT NULL (not_started | in_progress | completed | cancelled)
--   fulfillment_status text NOT NULL (unshipped   | partially_shipped | fully_shipped)
--
-- Backfill rule (PRD §7.3):
--   status='shipped'     → production_status='completed', fulfillment_status='fully_shipped'
--   status in (other)    → production_status=status,      fulfillment_status='unshipped'
--
-- The old status column is dropped outright. No deprecated alias — every
-- read site is migrated in the same PR (101 references across 20 files),
-- and the type check is the gate. Same for shipped_at on jobs and
-- job_parts: dropped, replaced by a SQL helper job_last_ship_date(uuid)
-- whose body is filled in by PR 4 (when shipments exist). PR 3 ships
-- NULL-returning stubs so the 26 existing shipped_at read sites can be
-- rewritten through the helpers without waiting for PR 4.
--
-- Triggers:
--   - DROP the existing compute_job_status / sync_job_status_from_parts /
--     track_job_status_change family (replaced).
--   - CREATE compute_job_production_status / sync_job_production_status_from_parts /
--     track_job_production_status_change. Same shape as the old family,
--     but operates on production_status and stamps started_at /
--     completed_at only (shipped_at is gone).
--   - No fulfillment trigger here — fulfillment_status stays 'unshipped'
--     until PR 4 wires up the cascade from shipment_line_items.
--
-- IDEMPOTENT. Each ADD/DROP uses IF [NOT] EXISTS; backfill only fires when
-- the old status column still exists, so re-running on a fully-migrated
-- DB is a no-op.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

-- ============================================================================
-- Phase 1: Add the new columns (nullable for the duration of the backfill)
-- ============================================================================

ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS production_status text,
    ADD COLUMN IF NOT EXISTS fulfillment_status text;

ALTER TABLE public.job_parts
    ADD COLUMN IF NOT EXISTS production_status text,
    ADD COLUMN IF NOT EXISTS fulfillment_status text;


-- ============================================================================
-- Phase 2: Backfill from the old status column when it still exists.
--          Wrapped in a column-existence guard so re-running is safe.
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'job_parts'
           AND column_name = 'status'
    ) THEN
        UPDATE public.job_parts SET
            production_status = COALESCE(
                production_status,
                CASE WHEN status = 'shipped' THEN 'completed' ELSE status END
            ),
            fulfillment_status = COALESCE(
                fulfillment_status,
                CASE WHEN status = 'shipped' THEN 'fully_shipped' ELSE 'unshipped' END
            );

        UPDATE public.jobs SET
            production_status = COALESCE(
                production_status,
                CASE WHEN status = 'shipped' THEN 'completed' ELSE status END
            ),
            fulfillment_status = COALESCE(
                fulfillment_status,
                CASE WHEN status = 'shipped' THEN 'fully_shipped' ELSE 'unshipped' END
            );
    END IF;
END $$;


-- ============================================================================
-- Phase 3: Defensive backfill for rows that ended up null
--          (e.g. brand-new rows inserted between Phase 1 and the column drop)
-- ============================================================================

UPDATE public.job_parts SET production_status = 'not_started' WHERE production_status IS NULL;
UPDATE public.job_parts SET fulfillment_status = 'unshipped' WHERE fulfillment_status IS NULL;
UPDATE public.jobs      SET production_status = 'not_started' WHERE production_status IS NULL;
UPDATE public.jobs      SET fulfillment_status = 'unshipped' WHERE fulfillment_status IS NULL;


-- ============================================================================
-- Phase 4: NOT NULL + CHECK constraints on the new columns
-- ============================================================================

ALTER TABLE public.jobs
    ALTER COLUMN production_status SET NOT NULL,
    ALTER COLUMN fulfillment_status SET NOT NULL;

ALTER TABLE public.job_parts
    ALTER COLUMN production_status SET NOT NULL,
    ALTER COLUMN fulfillment_status SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints cc
          JOIN information_schema.constraint_table_usage ctu
            ON cc.constraint_name = ctu.constraint_name
           AND cc.constraint_schema = ctu.constraint_schema
         WHERE ctu.table_schema = 'public'
           AND ctu.table_name = 'jobs'
           AND cc.constraint_name = 'jobs_production_status_check'
    ) THEN
        ALTER TABLE public.jobs
            ADD CONSTRAINT jobs_production_status_check
            CHECK (production_status IN ('not_started','in_progress','completed','cancelled'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints cc
          JOIN information_schema.constraint_table_usage ctu
            ON cc.constraint_name = ctu.constraint_name
           AND cc.constraint_schema = ctu.constraint_schema
         WHERE ctu.table_schema = 'public'
           AND ctu.table_name = 'jobs'
           AND cc.constraint_name = 'jobs_fulfillment_status_check'
    ) THEN
        ALTER TABLE public.jobs
            ADD CONSTRAINT jobs_fulfillment_status_check
            CHECK (fulfillment_status IN ('unshipped','partially_shipped','fully_shipped'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints cc
          JOIN information_schema.constraint_table_usage ctu
            ON cc.constraint_name = ctu.constraint_name
           AND cc.constraint_schema = ctu.constraint_schema
         WHERE ctu.table_schema = 'public'
           AND ctu.table_name = 'job_parts'
           AND cc.constraint_name = 'job_parts_production_status_check'
    ) THEN
        ALTER TABLE public.job_parts
            ADD CONSTRAINT job_parts_production_status_check
            CHECK (production_status IN ('not_started','in_progress','completed','cancelled'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints cc
          JOIN information_schema.constraint_table_usage ctu
            ON cc.constraint_name = ctu.constraint_name
           AND cc.constraint_schema = ctu.constraint_schema
         WHERE ctu.table_schema = 'public'
           AND ctu.table_name = 'job_parts'
           AND cc.constraint_name = 'job_parts_fulfillment_status_check'
    ) THEN
        ALTER TABLE public.job_parts
            ADD CONSTRAINT job_parts_fulfillment_status_check
            CHECK (fulfillment_status IN ('unshipped','partially_shipped','fully_shipped'));
    END IF;
END $$;


-- ============================================================================
-- Phase 5: Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_jobs_production_status
    ON public.jobs (company_id, production_status);

CREATE INDEX IF NOT EXISTS idx_jobs_fulfillment_status
    ON public.jobs (company_id, fulfillment_status);

CREATE INDEX IF NOT EXISTS idx_job_parts_production_status
    ON public.job_parts (production_status);


-- ============================================================================
-- Phase 6: Drop the old triggers + functions
-- ============================================================================

DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_del ON public.job_parts;
DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_ins ON public.job_parts;
DROP TRIGGER IF EXISTS trigger_sync_job_status_from_parts_upd ON public.job_parts;
DROP TRIGGER IF EXISTS trigger_job_status_change ON public.jobs;

DROP FUNCTION IF EXISTS public.sync_job_status_from_parts() CASCADE;
DROP FUNCTION IF EXISTS public.track_job_status_change() CASCADE;
DROP FUNCTION IF EXISTS public.compute_job_status(uuid) CASCADE;


-- ============================================================================
-- Phase 7: Drop the old status columns + shipped_at columns
-- ============================================================================
-- Dropping status also drops the jobs_status_check / job_parts_status_check
-- constraints automatically. Drop the old idx_job_parts_status index too
-- (also auto-dropped, but explicit for re-runnable migrations).

DROP INDEX IF EXISTS public.idx_job_parts_status;

ALTER TABLE public.jobs
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS shipped_at;

ALTER TABLE public.job_parts
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS shipped_at;


-- ============================================================================
-- Phase 8: New production-status sync trigger family
-- ============================================================================
-- compute_job_production_status: aggregates over job_parts.production_status.
-- Rules per PRD §7.2:
--   * No parts                                  → not_started
--   * All cancelled                             → cancelled
--   * All non-cancelled parts completed         → completed
--   * Any in_progress OR mixed                  → in_progress
--   * All not_started (ignoring cancelled)      → not_started
-- Partial-cancellation cases (one cancelled + one not_started, etc.) return
-- not_started — the documented convention. PR 4's permutation harness
-- exercises this explicitly.

CREATE OR REPLACE FUNCTION public.compute_job_production_status(p_job_id uuid)
    RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_total int;
    v_cancelled int;
    v_completed int;
    v_in_progress int;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE production_status = 'cancelled'),
           count(*) FILTER (WHERE production_status = 'completed'),
           count(*) FILTER (WHERE production_status = 'in_progress')
      INTO v_total, v_cancelled, v_completed, v_in_progress
      FROM public.job_parts WHERE job_id = p_job_id;

    IF v_total = 0 THEN RETURN 'not_started'; END IF;
    IF v_cancelled = v_total THEN RETURN 'cancelled'; END IF;
    -- All non-cancelled parts completed → completed
    IF v_completed = v_total - v_cancelled THEN RETURN 'completed'; END IF;
    IF v_in_progress > 0 OR v_completed > 0 THEN RETURN 'in_progress'; END IF;
    RETURN 'not_started';
END $$;

-- sync_job_production_status_from_parts: AFTER INSERT/UPDATE OF
-- production_status/DELETE on job_parts. Replaces sync_job_status_from_parts.
-- Mirrors the old trigger's timestamp behavior (started_at, completed_at)
-- minus the shipped_at handling.

CREATE OR REPLACE FUNCTION public.sync_job_production_status_from_parts()
    RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_job_id uuid;
    v_new text;
    v_now timestamptz := now();
BEGIN
    IF pg_trigger_depth() > 2 THEN RETURN NULL; END IF;
    v_job_id := COALESCE(NEW.job_id, OLD.job_id);
    v_new := public.compute_job_production_status(v_job_id);

    UPDATE public.jobs
       SET production_status = v_new,
           status_changed_at = CASE
               WHEN production_status IS DISTINCT FROM v_new THEN v_now
               ELSE status_changed_at
           END,
           started_at = CASE
               WHEN started_at IS NULL AND v_new IN ('in_progress','completed')
                   THEN v_now
               ELSE started_at
           END,
           completed_at = CASE
               WHEN v_new = 'completed' AND completed_at IS NULL THEN v_now
               WHEN v_new = 'in_progress' THEN NULL
               ELSE completed_at
           END,
           updated_at = v_now
     WHERE id = v_job_id;

    RETURN NULL;
END $$;

CREATE TRIGGER trigger_sync_job_production_status_from_parts_ins
    AFTER INSERT ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION public.sync_job_production_status_from_parts();

CREATE TRIGGER trigger_sync_job_production_status_from_parts_upd
    AFTER UPDATE OF production_status ON public.job_parts
    FOR EACH ROW
    WHEN (OLD.production_status IS DISTINCT FROM NEW.production_status)
    EXECUTE FUNCTION public.sync_job_production_status_from_parts();

CREATE TRIGGER trigger_sync_job_production_status_from_parts_del
    AFTER DELETE ON public.job_parts
    FOR EACH ROW EXECUTE FUNCTION public.sync_job_production_status_from_parts();

-- track_job_production_status_change: BEFORE UPDATE on jobs.
-- Replaces track_job_status_change. Handles direct jobs.production_status
-- updates (rare — most updates come through the AFTER trigger on
-- job_parts, but cover the case for completeness). Stamps started_at /
-- completed_at the same way the old trigger did, minus shipped_at.

CREATE OR REPLACE FUNCTION public.track_job_production_status_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.production_status IS DISTINCT FROM NEW.production_status THEN
        NEW.status_changed_at := now();
        IF NEW.production_status = 'in_progress' AND NEW.started_at IS NULL THEN
            NEW.started_at := now();
        ELSIF NEW.production_status = 'completed' AND NEW.completed_at IS NULL THEN
            NEW.completed_at := now();
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trigger_job_production_status_change
    BEFORE UPDATE ON public.jobs
    FOR EACH ROW EXECUTE FUNCTION public.track_job_production_status_change();


-- ============================================================================
-- Phase 9: NULL-returning ship-date helpers
-- ============================================================================
-- The 26 existing read sites for jobs.shipped_at / job_parts.shipped_at
-- (15 in api/services/insights_service.py, 5 in api/tools/schema_context.py,
-- 2 in utils/dashboardAccess.ts, etc.) route through these helpers in
-- PR 3. PR 4 replaces the bodies with real implementations that sum
-- non-voided shipments. Until then, every legacy caller sees NULL —
-- which is the truthful answer because no shipments exist yet.

CREATE OR REPLACE FUNCTION public.job_last_ship_date(p_job_id uuid)
    RETURNS date LANGUAGE sql STABLE AS $$
    SELECT NULL::date  -- PR 4 will replace this body
$$;

CREATE OR REPLACE FUNCTION public.job_part_last_ship_date(p_job_part_id uuid)
    RETURNS date LANGUAGE sql STABLE AS $$
    SELECT NULL::date  -- PR 4 will replace this body
$$;


COMMIT;
