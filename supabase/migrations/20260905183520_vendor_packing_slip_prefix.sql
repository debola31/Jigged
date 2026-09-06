-- ============================================================================
-- VENDOR PACKING SLIP: THE PREFIX, ACTUALLY APPLIED
-- ============================================================================
-- 20260903203741 was edited IN PLACE to mint `VPS-` instead of `OSP-`. That
-- works on a database seeing it for the first time and is a NO-OP everywhere it
-- had already run: the version is in `supabase_migrations.schema_migrations`, so
-- the file is never replayed and the old function body survives.
--
-- It was caught on the PR's own Supabase preview branch, which had applied the
-- original and went on minting `OSP-0057-1` from a tree that says `VPS-`
-- everywhere. Production had not applied it, so nothing shipped wrong — but the
-- next environment to be a version ahead would have been prod.
--
-- THE RULE, and it is the whole reason this file exists: once a migration has
-- been applied ANYWHERE, change it with a new migration. Editing it changes what
-- a fresh database gets and nothing else, and the two diverge silently.
--
-- Existing `OSP-` rows are LEFT ALONE. A slip number is printed on a document
-- that left the building, and renumbering one is the same failure as reissuing a
-- voided number to a different box -- the vendor is holding the paper. New sends
-- mint `VPS-`; the handful of `OSP-` slips stay what they were issued as.
-- ============================================================================

-- Rebuilt from its newest definition (20260903203741, as edited). CREATE OR
-- REPLACE keeps the existing ACL and COMMENT, so the REVOKE/GRANT block from
-- that migration still stands and is not repeated here.

CREATE OR REPLACE FUNCTION public.create_outside_shipment(
    p_job_operation_id  uuid,
    p_quantity          numeric,
    p_vendor_address_id uuid        DEFAULT NULL,
    p_vendor_contact_id uuid        DEFAULT NULL,
    p_shipped_at        timestamptz DEFAULT NULL,
    p_due_back_on       date        DEFAULT NULL,
    p_carrier           text        DEFAULT NULL,
    p_notes             text        DEFAULT NULL
)
RETURNS TABLE(shipment_id uuid, slip_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid; v_job_id uuid; v_job_part_id uuid;
    v_vendor_service_id uuid; v_job_number text; v_base text; v_seq integer;
    v_vendor_id uuid; v_vendor_name text; v_service_name text;
    v_address_id uuid; v_contact_id uuid;
    v_slip text; v_id uuid; v_user uuid := auth.uid();
BEGIN
    -- p_company_id IS DELIBERATELY NOT A PARAMETER. It is derived from the
    -- operation, so a caller cannot name a tenant it does not own and the whole
    -- class of cross-tenant argument bug does not exist. Same instinct as
    -- create_shipment_with_line_items deriving its job from the line items.
    SELECT jp.company_id, o.job_id, o.job_part_id, o.vendor_service_id, j.job_number
      INTO v_company_id, v_job_id, v_job_part_id, v_vendor_service_id, v_job_number
      FROM public.job_operations o
      JOIN public.job_parts jp ON jp.id = o.job_part_id
      JOIN public.jobs j       ON j.id  = o.job_id
     WHERE o.id = p_job_operation_id;

    IF v_company_id IS NULL THEN
        RAISE EXCEPTION 'Operation not found';
    END IF;

    -- SECURITY DEFINER bypasses RLS, so this is the only thing standing between
    -- a caller and another company's data.
    IF NOT (v_company_id IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'You do not have access to this company'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- THE BILLING GATE, BY HAND. company_can_write is enforced through a
    -- RESTRICTIVE RLS policy, and SECURITY DEFINER bypasses RLS -- so without
    -- this line a lapsed shop could still write, and
    -- test_no_tenant_table_left_ungated would not catch it because the TABLE is
    -- gated. The bypass is the hole, not the table.
    --
    -- THE LITERAL STRING `company_can_write` IN THIS BODY IS LOAD-BEARING FOR
    -- CI: definer_writers_missing_write_gate() matches on the text of the
    -- function definition, not on behaviour. Hoisting this into a helper turns
    -- that guard red for a reason nobody will find from the error message.
    IF NOT public.company_can_write(v_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_insert)'
            USING ERRCODE = '42501';
    END IF;

    -- One column, no join: vendor_service_id IS the discriminator. Mirrors the
    -- guard in start_operation_interval and createOperationCompletion.
    IF v_vendor_service_id IS NULL THEN
        RAISE EXCEPTION 'This is an in-house operation - there is nothing to ship out.';
    END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'Ship a quantity greater than zero.'
            USING ERRCODE = 'check_violation';
    END IF;
    -- Validated here rather than as a CHECK: timestamptz::date is STABLE, not
    -- IMMUTABLE, so Postgres refuses that constraint on the table.
    IF p_due_back_on IS NOT NULL
       AND p_due_back_on < (COALESCE(p_shipped_at, now()))::date THEN
        RAISE EXCEPTION 'The due-back date cannot be before the ship date.'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT v.id, v.name, vs.name INTO v_vendor_id, v_vendor_name, v_service_name
      FROM public.vendor_services vs
      JOIN public.vendors v ON v.id = vs.vendor_id
     WHERE vs.id = v_vendor_service_id;

    -- vendor_addresses gets its first consumer, and vendor_contacts.role =
    -- 'shipping_receiving' gets its first meaning.
    v_address_id := COALESCE(p_vendor_address_id, (
        SELECT a.id FROM public.vendor_addresses a
         WHERE a.vendor_id = v_vendor_id AND a.is_default LIMIT 1));
    v_contact_id := COALESCE(p_vendor_contact_id, (
        SELECT c.id FROM public.vendor_contacts c
         WHERE c.vendor_id = v_vendor_id AND c.role = 'shipping_receiving'
         ORDER BY c.is_primary DESC, c.created_at LIMIT 1));

    -- Belongs-to checks, inline. One writer means these do not need to be a
    -- trigger the way enforce_shipment_address_contact_customer does.
    IF v_address_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.vendor_addresses
         WHERE id = v_address_id AND vendor_id = v_vendor_id) THEN
        RAISE EXCEPTION 'That address does not belong to %', v_vendor_name
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_contact_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.vendor_contacts
         WHERE id = v_contact_id AND vendor_id = v_vendor_id) THEN
        RAISE EXCEPTION 'That contact does not belong to %', v_vendor_name
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- ---- MINT THE SLIP NUMBER --------------------------------------------
    -- A DISTINCT LOCK NAMESPACE from create_shipment_with_line_items, which
    -- takes hashtext('job:'||job_id). The two counters read different tables and
    -- must not serialize against each other -- sharing the key would let a slow
    -- outside send block the customer shipping desk on the same job.
    PERFORM pg_advisory_xact_lock(hashtext('outside_shipment:' || v_job_id::text));

    -- jobBase strips the alpha prefix (J-0141 -> 0141), the SAME expression
    -- 20260621161856 uses, so VPS- and PS- numbers on one job read as siblings.
    v_base := regexp_replace(v_job_number, '^[A-Za-z]+-?', '');
    -- count(*) OVER ALL ROWS INCLUDING VOIDED. This matters more here than for
    -- packing slips: the plater is holding a piece of paper reading VPS-0141-2,
    -- and reissuing that number to a different box is how two shipments become
    -- one in a phone call.
    SELECT count(*) + 1 INTO v_seq
      FROM public.outside_shipments WHERE job_id = v_job_id;
    v_slip := 'VPS-' || v_base || '-' || v_seq::text;

    INSERT INTO public.outside_shipments (
        company_id, job_id, job_part_id, job_operation_id,
        vendor_id, vendor_address_id, vendor_contact_id,
        vendor_name, service_name, ship_to_address, ship_to_contact,
        slip_number, quantity, shipped_at, due_back_on, carrier, notes, created_by
    ) VALUES (
        v_company_id, v_job_id, v_job_part_id, p_job_operation_id,
        v_vendor_id, v_address_id, v_contact_id,
        v_vendor_name, v_service_name,
        public.vendor_address_block_snapshot(v_address_id),
        public.vendor_contact_block_snapshot(v_contact_id),
        v_slip, p_quantity, COALESCE(p_shipped_at, now()), p_due_back_on,
        p_carrier, NULLIF(btrim(COALESCE(p_notes, '')), ''), v_user
    ) RETURNING id INTO v_id;
    -- The AFTER INSERT trigger derives status = 'sent' and mirrors sent_at/by.

    RETURN QUERY SELECT v_id, v_slip;
END $function$;


COMMENT ON COLUMN public.outside_shipments.slip_number IS
  'VPS-{jobBase}-{n} -- Vendor Packing Slip. BOTH documents print the title "PACKING SLIP", because that is what each one is to the person opening the box, so the NUMBER is the only thing that says which is which and it has to carry that alone. Naming the counterparty rather than decorating the number is the industry convention: Epicor Kinetic pairs "Subcontractor Shipment Entry" with "Customer Shipment Entry" and prints a Subcontract Packing Slip; Infor SyteLine calls this direction a Vendor Packing Slip. We say vendor because the rest of the product does. The PREFIX itself has no industry precedent -- it is ours, and it exists because a number read off paper still has to say which document it belongs to.';

COMMENT ON TABLE public.outside_shipments IS
  'One send of a quantity of parts to an outside vendor for ONE job_operations row. An operation may have many: send 50 now, 50 next week. THIS TABLE IS THE SEND -- there is no separate "mark sent out" write, and job_operations.sent_at/sent_by are a trigger-maintained mirror of the first live row here, never a source. Voided, never archived (no deleted_at). Slip numbers are VPS-{jobBase}-{n}, minted in create_outside_shipment under an advisory lock; rows issued before 20260905183520 carry the retired OSP- prefix and are deliberately not renumbered.';

-- Prove it took. A future edit-in-place of either file fails here rather than in
-- a vendor's hands.
DO $check$
BEGIN
    IF (SELECT pg_get_functiondef(p.oid) NOT LIKE '%''VPS-''%'
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'create_outside_shipment') THEN
        RAISE EXCEPTION 'create_outside_shipment does not mint VPS- after this migration';
    END IF;
END $check$;
