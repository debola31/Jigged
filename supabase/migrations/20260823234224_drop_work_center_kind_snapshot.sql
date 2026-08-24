-- ═══════════════════════════════════════════════════════════════════════════════
-- job_operations.work_center_kind_snapshot is redundant. Drop it.
-- ═══════════════════════════════════════════════════════════════════════════════
-- The column existed to say which of the two rate columns applied to an
-- operation, because a work centre could be switched between internal and
-- external after the fact and the live `kind` would then lie about frozen
-- history.
--
-- Neither half of that is true any more. `kind` is gone, a work centre cannot
-- become a service, and `vendor_service_id IS NOT NULL` answers the same
-- question directly from the row. Keeping a snapshot of a column that no longer
-- exists, whose value is derivable, is exactly the vestigial state this whole
-- change set was about removing.
--
-- ── The assertion is the point ──────────────────────────────────────────────
--
-- This is dropping a column that DOES carry information today, so it must be
-- provably the same information first. Every operation's snapshot has to agree
-- with its target: an outside op carrying 'internal', or an in-house op
-- carrying 'external', would mean the split repointed a row against its own
-- frozen history — and dropping the column would erase the evidence.
--
-- If this raises, DO NOT relax it. The rows it names are the ones whose costing
-- is already ambiguous.

DO $checks$
DECLARE
    v_mismatch bigint;
BEGIN
    SELECT count(*) INTO v_mismatch
      FROM public.job_operations
     WHERE work_center_kind_snapshot IS NOT NULL
       AND work_center_kind_snapshot
           IS DISTINCT FROM CASE WHEN vendor_service_id IS NOT NULL
                                 THEN 'external' ELSE 'internal' END;

    IF v_mismatch > 0 THEN
        RAISE EXCEPTION
            'Cannot drop work_center_kind_snapshot: % job operation(s) carry a snapshot that disagrees with their target. The column is still load-bearing for those rows; resolve them first.',
            v_mismatch
            USING ERRCODE = 'check_violation';
    END IF;
END
$checks$;

ALTER TABLE public.job_operations
    DROP CONSTRAINT IF EXISTS job_operations_work_center_kind_snapshot_check,
    DROP COLUMN work_center_kind_snapshot;

-- The two rate snapshots STAY. They are not derivable — they freeze what was
-- charged at the moment the op was cloned, which is the whole point of a
-- snapshot, and a later price change must not move a shipped job. Only the
-- discriminator was redundant.
COMMENT ON COLUMN public.job_operations.external_unit_price_snapshot IS
  'OUTSIDE operations only (vendor_service_id IS NOT NULL): the effective price per piece — COALESCE(routing_operations.external_unit_price, vendor_services.unit_price) — as it stood when this operation was cloned. Cost = this × job_parts.quantity. NULL on an outside op = no price was available anywhere; the operation is unpriceable and its job_part is excluded from profitability, never costed at zero.';

COMMENT ON COLUMN public.job_operations.labor_rate_snapshot IS
  'IN-HOUSE operations only (work_center_id IS NOT NULL): COALESCE(routing_operations.labor_rate_override, work_centers.labor_rate) as it stood when this operation was cloned. Cost = (estimated_setup_minutes + estimated_run_minutes_per_unit × job_parts.quantity) / 60 × this. NULL = no rate was available; same exclusion rule as above.';


-- ── The writer stops writing it ─────────────────────────────────────────────
-- Rebuilt from its newest definition (the split migration). One change: the
-- snapshot column leaves the INSERT. `is_outside` is still what decides which
-- rate column is filled — that logic is unchanged, it simply no longer also
-- records its own answer in a third column.
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
               COALESCE(wc.name, vs.name) AS operation_name,
               (ro.vendor_service_id IS NOT NULL) AS is_outside,
               wc.labor_rate AS work_center_labor_rate,
               vs.unit_price AS vendor_service_unit_price
        FROM routing_operations ro
        LEFT JOIN work_centers    wc ON wc.id = ro.work_center_id
        LEFT JOIN vendor_services vs ON vs.id = ro.vendor_service_id
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
            vendor_service_id,
            instructions, estimated_setup_minutes, estimated_run_minutes_per_unit,
            status, routing_operation_id,
            labor_rate_snapshot, external_unit_price_snapshot
        ) VALUES (
            v_job_id, p_job_part_id, v_seq, v_op.operation_name, v_op.work_center_id,
            v_op.vendor_service_id,
            v_op.instructions, COALESCE(v_op.setup_minutes, 0), v_op.cycle_minutes_per_unit,
            'pending', v_op.id,
            CASE WHEN NOT v_op.is_outside
                 THEN COALESCE(v_op.labor_rate_override, v_op.work_center_labor_rate) END,
            -- The EFFECTIVE price, so a shipped job freezes what was actually
            -- charged rather than a NULL that later reads as "never priced".
            CASE WHEN v_op.is_outside
                 THEN COALESCE(v_op.external_unit_price, v_op.vendor_service_unit_price) END
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
