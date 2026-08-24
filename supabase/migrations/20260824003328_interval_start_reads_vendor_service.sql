-- ═══════════════════════════════════════════════════════════════════════════════
-- start_operation_interval still asked work_centers for a `kind`.
-- ═══════════════════════════════════════════════════════════════════════════════
-- Missed by the split, and worth recording HOW, because the same blind spot
-- will exist next time.
--
-- Three guards cover this class of change and none of them saw this one:
--   * TypeScript cannot see inside a plpgsql body.
--   * The schema/embed guard reads `.select()` strings in TS, not SQL functions.
--   * `CREATE OR REPLACE FUNCTION` does not validate a plpgsql body, so the
--     migration that dropped `work_centers.kind` applied cleanly with this
--     function left pointing at it.
--
-- So it failed at RUNTIME, on the first operator who tapped "start this step",
-- and the thing that actually caught it was an E2E test.
--
-- The reliable check is to ask the DATABASE rather than the migration files:
--
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.prosrc ~* 'wc\.kind|work_center_kind';
--
-- That returns every function body still naming the dropped column, whatever
-- migration defined it. It now returns nothing.

CREATE OR REPLACE FUNCTION public.start_operation_interval(p_job_operation_id uuid)
RETURNS TABLE(interval_id uuid, started_at timestamptz, server_now timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_company_id uuid;
    v_job_part_id uuid;
    v_work_center_id uuid;
    v_vendor_service_id uuid;
    v_operator_id uuid;
    v_new_id uuid;
    v_started timestamptz;
BEGIN
    SELECT jp.company_id, o.job_part_id, o.work_center_id, o.vendor_service_id
      INTO v_company_id, v_job_part_id, v_work_center_id, v_vendor_service_id
      FROM public.job_operations o
      JOIN public.job_parts jp ON jp.id = o.job_part_id
     WHERE o.id = p_job_operation_id;

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION 'Operation not found';
    END IF;

    -- Membership. SECURITY DEFINER bypasses RLS, so this is the only thing
    -- standing between a caller and another company's data.
    v_operator_id := public.get_operator_access_id(v_company_id);
    IF v_operator_id IS NULL THEN
        RAISE EXCEPTION 'You do not have access to this company';
    END IF;

    -- THE BILLING GATE, BY HAND. company_can_write is enforced through a
    -- RESTRICTIVE RLS policy, and SECURITY DEFINER bypasses RLS — so without this
    -- line a lapsed shop could still write, and test_no_tenant_table_left_ungated
    -- would not catch it, because the TABLE is gated. The bypass is the hole, not
    -- the table.
    IF NOT public.company_can_write(v_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_insert)'
            USING ERRCODE = '42501';
    END IF;

    -- Outside operations are done off-site and use the send/receive
    -- lifecycle, never a clock. Mirrors the guard in createOperationCompletion
    -- (utils/operationCompletionsAccess.ts). Reads the column rather than
    -- joining for a kind, like every other caller now does.
    IF v_vendor_service_id IS NOT NULL THEN
        RAISE EXCEPTION 'This is an outside (vendor) operation — it has no shop time to record.';
    END IF;

    -- Close whatever holds this chain slot. Two branches because the ad-hoc chain
    -- keys on the operator instead of the machine, exactly matching the two
    -- partial unique indexes.
    IF v_work_center_id IS NOT NULL THEN
        UPDATE public.job_operation_intervals
           SET ended_at = now(), close_reason = 'switched'
         WHERE company_id = v_company_id
           AND work_center_id = v_work_center_id
           AND ended_at IS NULL
           AND voided_at IS NULL;
    ELSE
        UPDATE public.job_operation_intervals
           SET ended_at = now(), close_reason = 'switched'
         WHERE company_id = v_company_id
           AND operator_id = v_operator_id
           AND work_center_id IS NULL
           AND ended_at IS NULL
           AND voided_at IS NULL;
    END IF;

    INSERT INTO public.job_operation_intervals
        (company_id, job_operation_id, job_part_id, work_center_id, operator_id)
    VALUES
        (v_company_id, p_job_operation_id, v_job_part_id, v_work_center_id, v_operator_id)
    RETURNING id, job_operation_intervals.started_at INTO v_new_id, v_started;

    RETURN QUERY SELECT v_new_id, v_started, now();
END;
$$;
