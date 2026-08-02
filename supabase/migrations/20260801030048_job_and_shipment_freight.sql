-- Freight instructions: who pays, on whose account, at three grains.
--
-- The companion migration stored the customer's carrier account. This one lets
-- an order and a shipment actually USE it, and restores the freight-payment axis
-- that 20260621161856 dropped.
--
-- THREE GRAINS, AND THE MIDDLE ONE IS THE POINT:
--
--     customer default  ->  JOB (set when the PO is read)  ->  shipment (frozen)
--
-- The instruction arrives on the customer's purchase order — "Ship Via UPS
-- Ground, Collect, acct 4A72W9". If the only place to record it is the shipment,
-- then the person packing the box days or weeks later has to re-derive it from a
-- customer-level default that may contradict what the PO actually said. That is
-- the sticky note this project exists to remove, moved later in the process.
-- `jobs` already carries customer_po_number, due_date and is_hot, so it is
-- exactly where a per-order instruction belongs.
--
-- WHY prepaid_and_add IS NOT IN THE ENUM. It promises a billing action — add the
-- freight to the invoice — that Jigged cannot complete: shipments.weight_lbs was
-- dropped in June 2026 and there is no freight amount anywhere to push to
-- QuickBooks. An enum value naming a mechanism the schema cannot execute is
-- exactly why the original default_shipping_arrangement died of non-use. It
-- comes back the day there is a freight amount to carry, not before.
-- customer_arranged IS included: "our truck will collect it" is a real answer
-- the retired enum had, and its absence would push people to mislabel it.

-- ---------------------------------------------------------------------------
-- 1. Job grain — the PO's instruction.
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS freight_terms text,
    ADD COLUMN IF NOT EXISTS customer_carrier_account_id uuid
        REFERENCES public.customer_carrier_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS ship_via text,
    ADD COLUMN IF NOT EXISTS shipping_instructions text;

-- ---------------------------------------------------------------------------
-- 2. Shipment grain — what actually happened, frozen.
-- ---------------------------------------------------------------------------
ALTER TABLE public.shipments
    ADD COLUMN IF NOT EXISTS freight_terms text,
    ADD COLUMN IF NOT EXISTS customer_carrier_account_id uuid
        REFERENCES public.customer_carrier_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS freight_account_snapshot jsonb;

-- Same value domain at BOTH grains, constrained at both. An unconstrained job
-- column would let a bad value flow through the resolver into the constrained
-- shipment column and fail at pack time — the worst possible place to find out.
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_freight_terms_check;
ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_freight_terms_check
    CHECK (freight_terms IS NULL OR freight_terms = ANY (ARRAY[
        'prepaid'::text, 'collect'::text, 'third_party'::text, 'customer_arranged'::text]));

ALTER TABLE public.shipments DROP CONSTRAINT IF EXISTS shipments_freight_terms_check;
ALTER TABLE public.shipments
    ADD CONSTRAINT shipments_freight_terms_check
    CHECK (freight_terms IS NULL OR freight_terms = ANY (ARRAY[
        'prepaid'::text, 'collect'::text, 'third_party'::text, 'customer_arranged'::text]));

-- Freight terms are meaningless on a customer pickup or an internal restock —
-- nobody bills freight on either. The form must null freight_terms in the same
-- update when the method changes, or the user meets this as a raw error.
ALTER TABLE public.shipments DROP CONSTRAINT IF EXISTS shipments_freight_terms_method_check;
ALTER TABLE public.shipments
    ADD CONSTRAINT shipments_freight_terms_method_check
    CHECK (freight_terms IS NULL OR shipping_method = ANY (ARRAY['shipment'::text, 'dropship'::text]));

COMMENT ON COLUMN public.jobs.freight_terms IS
    'Who pays the freight for THIS order, as read off the customer PO: prepaid | collect | third_party | customer_arranged. Resolved from the customer''s carrier account at conversion and editable after. Distinct from FOB (where title and risk transfer, on the quote) and from shipping_method (how the goods left).';

COMMENT ON COLUMN public.jobs.ship_via IS
    'Carrier/service as the PO states it ("UPS Ground", "their truck"). Free text — the PO''s words, not our vocabulary.';

COMMENT ON COLUMN public.shipments.freight_account_snapshot IS
    'REDACTED freight block frozen at ship time: carrier, bill_to_party, has_account, account_last4. Deliberately never the full account number — the packing slip renders from this and rides in the box past carriers, docks and whoever opens the carton. The full number is read live from customer_carrier_accounts by an authenticated user at the bench. Also deliberately NOT the account id: shipments.customer_carrier_account_id is a real FK one column over, and duplicating it here would diverge the moment the account is archived and the FK goes SET NULL.';

-- ---------------------------------------------------------------------------
-- 3. Integrity: the carrier account must belong to the document's customer.
--
--    Without this the DB happily accepts Customer B's UPS account on Customer
--    A's job, and the shop bills freight to the wrong company. That is the worst
--    bug this feature could produce, and a UI-filtered dropdown is not a
--    backstop. The address and contact FKs are already guarded exactly this way;
--    the new FK is the same class of field.
--
--    THE TRAP: the two triggers' UPDATE OF lists are ASYMMETRIC — jobs watches
--    four columns, shipments only two. Miss the shipments list and an update
--    that changes ONLY the carrier account never fires the guard at all, at
--    precisely the grain where the money moves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_job_address_contact_customer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.billing_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.billing_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.billing_address_id % does not belong to customer %',
                NEW.billing_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.shipping_address_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_addresses
         WHERE id = NEW.shipping_address_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.shipping_address_id % does not belong to customer %',
                NEW.shipping_address_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.contact_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_contacts
         WHERE id = NEW.contact_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.contact_id % does not belong to customer %',
                NEW.contact_id, NEW.customer_id;
        END IF;
    END IF;
    IF NEW.customer_carrier_account_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_carrier_accounts
         WHERE id = NEW.customer_carrier_account_id AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'jobs.customer_carrier_account_id % does not belong to customer %',
                NEW.customer_carrier_account_id, NEW.customer_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_job_address_contact_customer_trg ON public.jobs;
CREATE TRIGGER enforce_job_address_contact_customer_trg
    BEFORE INSERT OR UPDATE OF billing_address_id, shipping_address_id, contact_id,
                               customer_id, customer_carrier_account_id
    ON public.jobs FOR EACH ROW
    EXECUTE FUNCTION public.enforce_job_address_contact_customer();

CREATE OR REPLACE FUNCTION public.enforce_shipment_address_contact_customer()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
    IF NEW.customer_carrier_account_id IS NOT NULL THEN
        PERFORM 1 FROM public.customer_carrier_accounts
         WHERE id = NEW.customer_carrier_account_id
           AND customer_id = NEW.customer_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'customer_carrier_account_id % does not belong to customer %',
                NEW.customer_carrier_account_id, NEW.customer_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;
    RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS enforce_shipment_address_contact_customer_trg ON public.shipments;
CREATE TRIGGER enforce_shipment_address_contact_customer_trg
    BEFORE INSERT OR UPDATE OF shipping_address_id, customer_id, customer_carrier_account_id
    ON public.shipments FOR EACH ROW
    EXECUTE FUNCTION public.enforce_shipment_address_contact_customer();

-- ---------------------------------------------------------------------------
-- 4. Freeze the REDACTED freight block onto the shipment.
--
--    Document Snapshot Standard: the packing slip must still say what it said a
--    year from now, even if the account is edited or archived. It stores the
--    last 4 only — never the full number — because the slip leaves the building.
--    Accounts of 4 characters or fewer reveal nothing at all: showing 3 of 4 is
--    not redaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.snapshot_shipment_party()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
        IF NEW.customer_id IS NOT NULL THEN
            NEW.customer_name := (SELECT name FROM public.customers WHERE id = NEW.customer_id);
            NEW.bill_to_address := public.address_block_snapshot(
                (SELECT a.id FROM public.customer_addresses a
                  WHERE a.customer_id = NEW.customer_id AND a.default_billing
                  LIMIT 1));
        END IF;
    END IF;

    IF TG_OP = 'INSERT' OR NEW.shipping_address_id IS DISTINCT FROM OLD.shipping_address_id THEN
        IF NEW.shipping_address_id IS NOT NULL THEN
            NEW.ship_to_address := public.address_block_snapshot(NEW.shipping_address_id);
        END IF;
    END IF;

    IF TG_OP = 'INSERT'
       OR NEW.customer_carrier_account_id IS DISTINCT FROM OLD.customer_carrier_account_id THEN
        IF NEW.customer_carrier_account_id IS NOT NULL THEN
            SELECT jsonb_build_object(
                     'carrier',       a.carrier,
                     'bill_to_party', a.bill_to_party,
                     -- Whether an account exists at all is safe to state, and the
                     -- slip needs it: "billed to their account" vs "billed on the
                     -- bill of lading" are different instructions to a dock.
                     'has_account',   (a.account_number IS NOT NULL
                                       AND length(btrim(a.account_number)) > 0),
                     'account_last4', CASE
                         WHEN a.account_number IS NULL THEN NULL
                         WHEN length(btrim(a.account_number)) <= 4 THEN NULL
                         ELSE right(btrim(a.account_number), 4)
                     END)
              INTO NEW.freight_account_snapshot
              FROM public.customer_carrier_accounts a
             WHERE a.id = NEW.customer_carrier_account_id;
        ELSE
            NEW.freight_account_snapshot := NULL;
        END IF;
    END IF;

    RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_snapshot_shipment_party ON public.shipments;
CREATE TRIGGER trg_snapshot_shipment_party
    BEFORE INSERT OR UPDATE OF customer_id, shipping_address_id, customer_carrier_account_id
    ON public.shipments FOR EACH ROW
    EXECUTE FUNCTION public.snapshot_shipment_party();

-- ---------------------------------------------------------------------------
-- 5. Carry freight through the shipment-creation RPC.
--
--    TWO WAYS THIS GOES WRONG, both of which apply cleanly and break production:
--
--    (a) THE DROP SIGNATURE. The live function is
--        (uuid, uuid, uuid, jsonb, date, text, text, jsonb, text) — note
--        p_line_items jsonb comes BEFORE p_notes text. `DROP FUNCTION IF EXISTS`
--        against any other signature SUCCEEDS AND DOES NOTHING, leaving the old
--        SECURITY DEFINER function alive as an overload with its grants intact,
--        which PostgREST can still resolve. The guard at the end of this section
--        is what turns that silent miss into a failed migration.
--
--    (b) THE DEFAULTS. utils/shipmentsAccess.ts passes exactly EIGHT named
--        arguments and omits p_notes entirely, relying on its DEFAULT. PostgREST
--        resolves an RPC by the set of names supplied, so a function whose
--        non-defaulted parameters are not all present is not a match: drop
--        p_notes' default and every shipment creation returns PGRST202 the
--        moment this lands. Frontend and migration deploy together, so there is
--        no working intermediate state. All defaulted parameters stay trailing.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_shipment_with_line_items(
    uuid, uuid, uuid, jsonb, date, text, text, jsonb, text);

CREATE OR REPLACE FUNCTION public.create_shipment_with_line_items(
    p_company_id uuid,
    p_customer_id uuid,
    p_shipping_address_id uuid,
    p_one_time_address jsonb,
    p_ship_date date,
    p_carrier text,
    p_shipping_method text,
    p_line_items jsonb,
    p_notes text DEFAULT NULL::text,
    p_freight_terms text DEFAULT NULL::text,
    p_customer_carrier_account_id uuid DEFAULT NULL::uuid
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

    -- 5. Insert shipment + line items. Triggers cascade fulfillment_status, and
    --    snapshot_shipment_party freezes the redacted freight block.
    INSERT INTO public.shipments (
        company_id, customer_id, shipping_address_id, one_time_address,
        packing_slip_number, ship_date, job_id, carrier, shipping_method,
        freight_terms, customer_carrier_account_id,
        created_by
    ) VALUES (
        p_company_id, p_customer_id, p_shipping_address_id, p_one_time_address,
        v_packing_slip, COALESCE(p_ship_date, current_date), v_job_id, p_carrier, p_shipping_method,
        p_freight_terms, p_customer_carrier_account_id,
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

-- The guard the DROP above cannot provide for itself. If the drop signature ever
-- drifts from the live one, this migration fails loudly here instead of leaving
-- two callable functions and letting PostgREST pick.
DO $$
DECLARE v_count integer;
BEGIN
    SELECT count(*) INTO v_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'create_shipment_with_line_items';
    IF v_count <> 1 THEN
        RAISE EXCEPTION
            'create_shipment_with_line_items has % overloads (expected 1) — the DROP signature did not match the live function',
            v_count;
    END IF;
END $$;
