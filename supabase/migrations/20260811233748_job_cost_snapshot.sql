-- Freeze a job's COST the way its revenue is already frozen.
--
-- A job_part has carried `unit_price` / `total_price` since 20260621162024 — the
-- agreed money, denormalised off the quote so it survives a post-conversion
-- quantity edit and so a job created without a quote still has a price. The cost
-- side got no such treatment: `job_operations` freezes the MINUTES
-- (estimated_setup_minutes, estimated_run_minutes_per_unit) and `job_materials`
-- freezes the QUANTITIES (expected_quantity), but not one rate or unit cost is
-- recorded anywhere on a job.
--
-- So `get_part_profitability` re-read `work_centers.labor_rate` and
-- `routing_operations.labor_rate_override` LIVE, every time. Raise a work-centre
-- rate today and last year's shipped job reports a different profit. A job that
-- shipped is history; recomputing it against today's rates is not measurement.
-- It also had no way to charge materials at all — there was no number to read —
-- so "profit" meant revenue minus labour, with every bought part free.
--
-- Two snapshots, at the two levels that need them:
--
--   1. `job_parts.true_cost_per_unit` — the authoritative all-in TRUE cost of one
--      unit: labour + materials + the whole nested BOM, at the quantity ordered.
--      Taken from `compute_part_cost_at_qty`, the same function the quote used,
--      so there is exactly ONE implementation of the cost rule and nothing here
--      can drift from it.
--
--   2. `job_operations.labor_rate_snapshot` / `external_unit_price_snapshot` /
--      `work_center_kind_snapshot` — the rates behind the already-frozen minutes,
--      so labour stays itemisable per operation. The labour formula is
--      minutes ÷ 60 × rate; that much is safe to hold outside the rollup.
--
-- MATERIALS ARE NOT SNAPSHOT PER LINE, DELIBERATELY. Costing one BOM line needs
-- the unit conversion, the consume_whole_units ceiling, and the made-vs-bought
-- valuation rule — all of which live inside `part_rollup_at_qty`'s loop.
-- Re-deriving them here would be a second copy of a money rule in a second
-- place, which is the dual-engine debt this repo already carries once. Instead:
--
--      material cost per unit  =  true_cost_per_unit  −  Σ(labour from job_operations)
--
-- One authoritative total, itemised labour, materials by subtraction. Exact, and
-- impossible to drift.
--
-- NULL MEANS "WE COULD NOT TELL", NEVER ZERO. `compute_part_cost_at_qty` raises
-- rather than silently costing an unpriced operation at $0, and a job must never
-- fail to be created because a part's costing is incomplete. So the snapshot is
-- taken inside an exception handler and left NULL when it cannot be determined.
-- The read path reports those job_parts as EXCLUDED from profitability — an
-- explicit "no data available", per the no-silent-fallbacks standard — and must
-- never fold a NULL into a total as zero cost.

-- ── 1. The authoritative per-unit cost, on the job_part ──────────────────────

ALTER TABLE public.job_parts
  ADD COLUMN true_cost_per_unit numeric;

COMMENT ON COLUMN public.job_parts.true_cost_per_unit IS
  'Snapshot of compute_part_cost_at_qty(part_id, quantity) — the all-in TRUE cost of one unit (labour + materials + nested BOM) as it stood when this job_part was created, or when its quantity last changed. Frozen so historical profit does not move when a labour rate or material cost changes later. NULL = the cost could not be determined at snapshot time (incomplete costing); treat as EXCLUDED from profitability, never as zero.';

-- ── 2. The rates behind the already-frozen minutes, on the operation ─────────

ALTER TABLE public.job_operations
  ADD COLUMN work_center_kind_snapshot text
    CHECK (work_center_kind_snapshot IN ('internal', 'external')),
  ADD COLUMN labor_rate_snapshot numeric(10,2),
  ADD COLUMN external_unit_price_snapshot numeric(12,4);

COMMENT ON COLUMN public.job_operations.work_center_kind_snapshot IS
  'work_centers.kind as it stood when this operation was cloned onto the job. Decides which of the two rate columns applies; snapshot because a work centre can be switched between internal and external after the fact.';

COMMENT ON COLUMN public.job_operations.labor_rate_snapshot IS
  'INTERNAL operations only: COALESCE(routing_operations.labor_rate_override, work_centers.labor_rate) as it stood when this operation was cloned. Cost = (estimated_setup_minutes + estimated_run_minutes_per_unit × job_parts.quantity) / 60 × this. NULL on an internal op = no rate was available; the operation is unpriceable and its job_part is excluded from profitability, never costed at zero.';

COMMENT ON COLUMN public.job_operations.external_unit_price_snapshot IS
  'EXTERNAL operations only: routing_operations.external_unit_price as it stood when this operation was cloned. Cost = this × job_parts.quantity. NULL on an external op = no price was available; same exclusion rule as labor_rate_snapshot.';

-- ── 3. Take the snapshot on every job_part, however it was created ───────────
--
-- A trigger, not a line in the conversion path, because job_parts arrive by more
-- than one road: quote conversion, a job built by hand with no quote at all
-- (37 of 128 jobs in production have no quote_id), and the routing-clone RPC
-- below only ever runs for MADE parts — a bought part has no routing, and would
-- otherwise never be costed.
--
-- Re-taken when the quantity changes, because cost genuinely depends on
-- quantity: procurement tiers and amortised setup both move. Note this is NOT
-- symmetric with price, which `updateJobPartQuantity` deliberately keeps sticky
-- on a quantity edit — a price is an agreement with the customer, a cost is a
-- measurement of us. Renegotiating one should not silently rewrite the other.

CREATE OR REPLACE FUNCTION public.snapshot_job_part_true_cost()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Only on insert, or when the quantity actually moved. An unrelated UPDATE
    -- must not silently re-price history.
    IF TG_OP = 'UPDATE' AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
        RETURN NEW;
    END IF;

    BEGIN
        NEW.true_cost_per_unit :=
            public.compute_part_cost_at_qty(NEW.part_id, NEW.quantity);
    EXCEPTION WHEN OTHERS THEN
        -- Incomplete costing (an operation with no labour rate, a material with
        -- no cost, a missing unit conversion) raises out of the rollup by
        -- design. That must never block creating the job. Record that we do not
        -- know rather than inventing a number.
        NEW.true_cost_per_unit := NULL;
    END;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.snapshot_job_part_true_cost() IS
  'BEFORE INSERT OR UPDATE OF quantity on job_parts: freezes true_cost_per_unit from compute_part_cost_at_qty. Swallows a costing failure into NULL so an incomplete part can still be put on a job — NULL means unknown, and profitability excludes it rather than costing it at zero.';

-- Trigger functions need no EXECUTE grant (permission is checked when the
-- trigger is created, not when it fires), and revoking costs nothing.
REVOKE EXECUTE ON FUNCTION public.snapshot_job_part_true_cost() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_snapshot_job_part_true_cost
  BEFORE INSERT OR UPDATE OF quantity ON public.job_parts
  FOR EACH ROW
  EXECUTE FUNCTION public.snapshot_job_part_true_cost();

-- ── 4. Clone the rates alongside the minutes ─────────────────────────────────
--
-- Carried forward verbatim from the baseline (20260527151536) with one change:
-- the job_operations INSERT now also writes the three rate-snapshot columns.
-- CREATE OR REPLACE rather than DROP + CREATE, so the ACL and COMMENT survive.

CREATE OR REPLACE FUNCTION public.create_job_part_operations_from_routing(
    p_job_part_id uuid,
    p_routing_id uuid
) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_count integer := 0;
    v_op record;
    v_seq integer := 10;
    v_job_id uuid;
    v_part_id uuid;
    v_min_seq integer;
BEGIN
    SELECT job_id INTO v_job_id FROM job_parts WHERE id = p_job_part_id;
    IF v_job_id IS NULL THEN
        RAISE EXCEPTION 'job_part % not found', p_job_part_id;
    END IF;

    -- The routing's part_id is the parent for any BOM snapshot below.
    SELECT part_id INTO v_part_id FROM routings WHERE id = p_routing_id;
    IF v_part_id IS NULL THEN
        RAISE EXCEPTION 'routing % not found', p_routing_id;
    END IF;

    -- Snapshot routing_operations → job_operations, now including the RATES the
    -- cost of this operation will forever be measured against.
    FOR v_op IN
        SELECT ro.*,
               wc.name AS operation_name,
               wc.kind AS work_center_kind,
               wc.labor_rate AS work_center_labor_rate
        FROM routing_operations ro
        JOIN work_centers wc ON ro.work_center_id = wc.id
        WHERE ro.routing_id = p_routing_id
          AND NOT EXISTS (
              SELECT 1 FROM job_operations jo
              WHERE jo.job_part_id = p_job_part_id
                AND jo.routing_operation_id = ro.id
          )
        ORDER BY ro.sequence, ro.created_at
    LOOP
        INSERT INTO job_operations (
            job_id, job_part_id, sequence, operation_name, work_center_id,
            instructions, estimated_setup_minutes, estimated_run_minutes_per_unit,
            status, routing_operation_id,
            work_center_kind_snapshot, labor_rate_snapshot, external_unit_price_snapshot
        ) VALUES (
            v_job_id, p_job_part_id, v_seq, v_op.operation_name, v_op.work_center_id,
            v_op.instructions, COALESCE(v_op.setup_minutes, 0), v_op.cycle_minutes_per_unit,
            'pending', v_op.id,
            v_op.work_center_kind,
            CASE WHEN v_op.work_center_kind IS DISTINCT FROM 'external'
                 THEN COALESCE(v_op.labor_rate_override, v_op.work_center_labor_rate) END,
            CASE WHEN v_op.work_center_kind = 'external'
                 THEN v_op.external_unit_price END
        );
        v_seq := v_seq + 10;
        v_count := v_count + 1;
    END LOOP;

    -- Snapshot parts_bom (the part's BOM) → job_materials. Idempotent on
    -- parts_bom_id. The BOM is now part-attached, not routing-attached, so
    -- we read parts_bom WHERE parent_part_id = the routing's part.
    INSERT INTO job_materials (job_id, job_part_id, parts_bom_id, material_part_id, expected_quantity, unit)
    SELECT v_job_id, p_job_part_id, b.id, b.child_part_id, b.quantity, b.unit
    FROM parts_bom b
    WHERE b.parent_part_id = v_part_id
      AND NOT EXISTS (
          SELECT 1 FROM job_materials jm
          WHERE jm.job_part_id = p_job_part_id
            AND jm.parts_bom_id = b.id
      );

    -- Set the job_part's current operation cursor to the lowest sequence we wrote.
    SELECT MIN(sequence) INTO v_min_seq FROM job_operations WHERE job_part_id = p_job_part_id;
    IF v_min_seq IS NOT NULL THEN
        UPDATE job_parts SET current_operation_sequence = v_min_seq WHERE id = p_job_part_id;
    END IF;

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.create_job_part_operations_from_routing(uuid, uuid) IS
  'Snapshots a routing onto a job_part: routing_operations → job_operations (with work_center_id, routing_operation_id, and the work-centre kind + labour/external RATES the operation will be costed at) and parts_bom (where parent_part = routing.part) → job_materials (with parts_bom_id). Idempotent on the snapshot keys. Sets job_parts.current_operation_sequence to the lowest seq written.';

-- ── 5. Backfill: every existing row satisfies the new invariant now ──────────
--
-- Not a runtime fallback — the data is fixed at rest, so the read path has one
-- shape and no "what if it's missing" branch. Both backfills copy TODAY's rates,
-- which is exactly what the live-recomputing code was already using, so no
-- number changes the moment this lands. What changes is that they stop moving
-- from here on.

UPDATE public.job_operations jo
SET work_center_kind_snapshot    = s.kind,
    labor_rate_snapshot          = s.labor_rate,
    external_unit_price_snapshot = s.external_unit_price
FROM (
    SELECT jo2.id,
           wc.kind AS kind,
           CASE WHEN wc.kind IS DISTINCT FROM 'external'
                THEN COALESCE(ro.labor_rate_override, wc.labor_rate) END AS labor_rate,
           CASE WHEN wc.kind = 'external'
                THEN ro.external_unit_price END AS external_unit_price
    FROM public.job_operations jo2
    LEFT JOIN public.work_centers wc ON wc.id = jo2.work_center_id
    LEFT JOIN public.routing_operations ro ON ro.id = jo2.routing_operation_id
) s
WHERE s.id = jo.id;

-- Per-row, because compute_part_cost_at_qty raises on an incomplete part and a
-- set-based UPDATE would abort the whole migration on the first one.
DO $$
DECLARE
    v_row record;
    v_cost numeric;
    v_ok integer := 0;
    v_unknown integer := 0;
BEGIN
    FOR v_row IN SELECT id, part_id, quantity FROM public.job_parts LOOP
        BEGIN
            v_cost := public.compute_part_cost_at_qty(v_row.part_id, v_row.quantity);
        EXCEPTION WHEN OTHERS THEN
            v_cost := NULL;
        END;

        UPDATE public.job_parts SET true_cost_per_unit = v_cost WHERE id = v_row.id;

        IF v_cost IS NULL THEN
            v_unknown := v_unknown + 1;
        ELSE
            v_ok := v_ok + 1;
        END IF;
    END LOOP;

    RAISE NOTICE 'job_parts.true_cost_per_unit backfill: % costed, % unknown', v_ok, v_unknown;
END;
$$;
