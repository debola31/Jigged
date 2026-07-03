-- Remove the shipment-notes concept.
--
-- shipments.notes was write-only: the Create Shipment form captured it and the RPC
-- persisted it, but nothing ever read or rendered it (no packing-slip surface, no
-- list column, no detail view). Drop the column and stop writing it.

ALTER TABLE public.shipments DROP COLUMN IF EXISTS notes;

-- Recreate create_shipment_with_line_items so its INSERT no longer references the
-- dropped column. p_notes is retained as a trailing DEFAULT NULL argument (ignored)
-- so this migration is safe to apply *ahead of* the app deploy: an older client that
-- still passes p_notes keeps working, and the updated client omits it entirely. The
-- vestigial argument can be dropped in a follow-up once every caller has shipped.
-- The old function had no explicit grants (default PUBLIC execute), so DROP + CREATE
-- preserves callability.
DROP FUNCTION IF EXISTS public.create_shipment_with_line_items(
    uuid, uuid, uuid, jsonb, date, text, text, text, jsonb
);

CREATE FUNCTION public.create_shipment_with_line_items(
    p_company_id uuid,
    p_customer_id uuid,
    p_shipping_address_id uuid,
    p_one_time_address jsonb,
    p_ship_date date,
    p_carrier text,
    p_shipping_method text,
    p_line_items jsonb,
    p_notes text DEFAULT NULL  -- vestigial: ignored; retained for deploy-order safety
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_packing_slip text;
    v_shipment_id uuid;
    v_user_id uuid := auth.uid();
    v_item jsonb;
    v_pre_status jsonb := '{}'::jsonb;
    v_job_ids uuid[];
    v_job_id uuid;
    v_job_number text;
    v_base text;
    v_seq int;
    r record;
BEGIN
    IF NOT (p_company_id IN (SELECT get_user_company_ids())) THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: caller does not have access to company %',
            p_company_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 1. Resolve the job(s) behind the line items. A packing slip belongs to
    --    exactly one job — reject empty or multi-job inputs.
    SELECT array_agg(DISTINCT jp.job_id)
      INTO v_job_ids
      FROM public.job_parts jp
     WHERE jp.id IN (
        SELECT (item->>'job_part_id')::uuid
          FROM jsonb_array_elements(p_line_items) AS item
     );

    IF v_job_ids IS NULL OR array_length(v_job_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: no job parts resolved from line items';
    END IF;
    IF array_length(v_job_ids, 1) > 1 THEN
        RAISE EXCEPTION 'create_shipment_with_line_items: a packing slip must belong to a single job (got % jobs)',
            array_length(v_job_ids, 1);
    END IF;
    v_job_id := v_job_ids[1];

    -- 2. Lock the job so the per-job packing-slip sequence is collision-free
    --    under concurrent callers. Released at COMMIT/ROLLBACK.
    PERFORM pg_advisory_xact_lock(hashtext('job:' || v_job_id::text));

    -- 3. Snapshot pre-cascade fulfillment_status for the audit row.
    SELECT COALESCE(jsonb_object_agg(j.id::text, j.fulfillment_status), '{}'::jsonb)
      INTO v_pre_status
      FROM public.jobs j
     WHERE j.id = v_job_id;

    -- 4. Mint the job-derived packing-slip number: PS-{jobBase}-{n}, n from 1.
    --    jobBase strips the alpha prefix off job_number (J-0141 -> 0141).
    SELECT j.job_number INTO v_job_number FROM public.jobs j WHERE j.id = v_job_id;
    v_base := regexp_replace(v_job_number, '^[A-Za-z]+-?', '');
    SELECT count(*) + 1 INTO v_seq FROM public.shipments WHERE job_id = v_job_id;
    v_packing_slip := 'PS-' || v_base || '-' || v_seq::text;

    -- 5. Insert shipment + line items. Triggers cascade fulfillment_status.
    INSERT INTO public.shipments (
        company_id, customer_id, shipping_address_id, one_time_address,
        packing_slip_number, ship_date, job_id, carrier, shipping_method,
        created_by
    ) VALUES (
        p_company_id, p_customer_id, p_shipping_address_id, p_one_time_address,
        v_packing_slip, COALESCE(p_ship_date, current_date), v_job_id, p_carrier, p_shipping_method,
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

    -- 6. Audit the job iff it crossed forward into fully_shipped.
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
END $function$;
