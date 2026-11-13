-- ============================================================================
-- PURCHASING (3 of 5): the write doors for approved vendors and POs
-- ============================================================================
-- The browser has SELECT only on every purchasing table, so these SECURITY DEFINER RPCs are
-- the only writers. EVERY ONE follows the same preamble, in this order, written out in its
-- own body:
--   1. derive the company from the row (or the vendor / part)
--   2. PERFORM assert_office_member(company): P0001 "That record is not available." for
--      not-found and non-members alike, 42501 for an operator
--   3. the literal company_can_write check -> 42501 (definer_writers_missing_write_gate()
--      text-matches that literal, so it lives in each body, never in a helper)
--   4. lock the header row FOR UPDATE
--   5. scope EVERY id inside an array or jsonb to THIS document
--   6. pre-validate every CHECK and raise it as a sentence (P0001)
--   7. p_today, where a date matters, comes from the caller and is never CURRENT_DATE
-- A jsonb key the RPC does not recognise is XX000 (our bug, not the user's).
--
-- LOCK ORDER, everywhere: the PO header FOR UPDATE, then the per-job outside-shipment
-- advisory locks (sorted by key) for every job an outside line touches, then lines.
-- create_outside_shipment takes the same job lock and no PO lock, so it cannot deadlock
-- against these, and a slip and a line insert for one job serialise. The relink RPC locks
-- both POs (in id order) before the job lock; a receipt on a linked slip locks its PO from a
-- trigger, holding no job lock (section 5b).
--
-- EVERY WRITER ENDS WITH vendor_purchase_order_settle_versions, header still locked: it bumps
-- the revision (when allowed) and the QuickBooks content_version (when the pushed projection
-- no longer hashes to content_hash).
-- ============================================================================


-- ============================================================================
-- 1. Internal helpers (no browser EXECUTE; called by the RPCs below as their owner)
-- ============================================================================

-- The per-job advisory locks create_outside_shipment takes, for every job an outside line
-- of this PO touches (existing, plus the steps named in an incoming p_lines). Sorted by the
-- lock KEY, not the job id: two jobs whose keys collide would otherwise be taken in
-- different orders by different transactions.
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_lock_jobs(
    p_vendor_purchase_order_id uuid,
    p_lines jsonb DEFAULT '[]'::jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company uuid;
    v_key     integer;
BEGIN
    SELECT h.company_id INTO v_company
      FROM public.vendor_purchase_orders h WHERE h.id = p_vendor_purchase_order_id;

    FOR v_key IN
        SELECT DISTINCT hashtext('outside_shipment:' || j.job_id::text)
          FROM (
            SELECT l.job_id
              FROM public.vendor_purchase_order_lines l
             WHERE l.vendor_purchase_order_id = p_vendor_purchase_order_id
               AND l.line_kind = 'outside_service'
               AND l.job_id IS NOT NULL
            UNION
            SELECT o.job_id
              FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(p_lines) = 'array' THEN p_lines ELSE '[]'::jsonb END) e
              JOIN public.job_operations o
                ON o.id = CASE WHEN jsonb_typeof(e.value) = 'object'
                                AND (e.value->>'job_operation_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                               THEN (e.value->>'job_operation_id')::uuid END
              JOIN public.job_parts jp ON jp.id = o.job_part_id AND jp.company_id = v_company
          ) j
         ORDER BY 1
    LOOP
        PERFORM pg_advisory_xact_lock(v_key);
    END LOOP;
END
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_lock_jobs(uuid, jsonb) IS
  'Takes create_outside_shipment''s per-job advisory lock for every job an outside-service line of this PO touches (existing lines plus the steps named in p_lines), in sorted key order. PO writers call it after locking the header and before touching a line, so "one open outside line per operation and vendor" and slip auto-linking cannot race. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_lock_jobs(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_lock_jobs(uuid, jsonb) TO service_role;


-- Ship-to: our shop (the default), another vendor (drop-ship to the plater) or a customer.
-- Ids on the side the kind does not name are refused, not ignored.
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_resolve_ship_to(p_company_id uuid, p_ship_to jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_kind      text := 'shop';
    v_vendor    record;
    v_customer  record;
    v_address   uuid;
    v_name      text;
BEGIN
    IF p_ship_to IS NOT NULL AND p_ship_to <> 'null'::jsonb THEN
        PERFORM public.purchasing_assert_keys(p_ship_to,
            ARRAY['kind', 'vendor_id', 'vendor_address_id', 'customer_id', 'customer_address_id'],
            'the ship-to');
        v_kind := COALESCE(p_ship_to->>'kind', 'shop');
    END IF;

    IF v_kind = 'shop' THEN
        IF COALESCE(p_ship_to->>'vendor_id', p_ship_to->>'vendor_address_id',
                    p_ship_to->>'customer_id', p_ship_to->>'customer_address_id') IS NOT NULL THEN
            RAISE EXCEPTION 'Shipping to our shop names no vendor or customer.' USING ERRCODE = 'P0001';
        END IF;
        SELECT c.name INTO v_name FROM public.companies c WHERE c.id = p_company_id;
        RETURN jsonb_build_object(
            'kind', 'shop', 'vendor_id', NULL, 'vendor_address_id', NULL,
            'customer_id', NULL, 'customer_address_id', NULL,
            'name', v_name, 'address', public.company_address_block_snapshot(p_company_id));
    END IF;

    IF v_kind = 'vendor' THEN
        IF COALESCE(p_ship_to->>'customer_id', p_ship_to->>'customer_address_id') IS NOT NULL THEN
            RAISE EXCEPTION 'A ship-to vendor can''t also name a customer.' USING ERRCODE = 'P0001';
        END IF;
        IF NULLIF(p_ship_to->>'vendor_id', '') IS NULL THEN
            RAISE EXCEPTION 'Choose the vendor to ship to.' USING ERRCODE = 'P0001';
        END IF;
        SELECT v.id, v.company_id, v.name, v.deleted_at INTO v_vendor
          FROM public.vendors v WHERE v.id = (p_ship_to->>'vendor_id')::uuid;
        IF NOT FOUND OR v_vendor.company_id <> p_company_id THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        IF v_vendor.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived, so it can''t be shipped to.', v_vendor.name USING ERRCODE = 'P0001';
        END IF;
        IF NULLIF(p_ship_to->>'vendor_address_id', '') IS NOT NULL THEN
            v_address := (p_ship_to->>'vendor_address_id')::uuid;
            IF NOT EXISTS (SELECT 1 FROM public.vendor_addresses a
                            WHERE a.id = v_address AND a.vendor_id = v_vendor.id) THEN
                RAISE EXCEPTION 'That address isn''t one of %''s.', v_vendor.name USING ERRCODE = 'P0001';
            END IF;
        ELSE
            SELECT a.id INTO v_address FROM public.vendor_addresses a
             WHERE a.vendor_id = v_vendor.id AND a.is_default LIMIT 1;
        END IF;
        RETURN jsonb_build_object(
            'kind', 'vendor', 'vendor_id', v_vendor.id, 'vendor_address_id', v_address,
            'customer_id', NULL, 'customer_address_id', NULL,
            'name', v_vendor.name, 'address', public.vendor_address_block_snapshot(v_address));
    END IF;

    IF v_kind = 'customer' THEN
        IF COALESCE(p_ship_to->>'vendor_id', p_ship_to->>'vendor_address_id') IS NOT NULL THEN
            RAISE EXCEPTION 'A ship-to customer can''t also name a vendor.' USING ERRCODE = 'P0001';
        END IF;
        IF NULLIF(p_ship_to->>'customer_id', '') IS NULL THEN
            RAISE EXCEPTION 'Choose the customer to ship to.' USING ERRCODE = 'P0001';
        END IF;
        SELECT c.id, c.company_id, c.name, c.deleted_at INTO v_customer
          FROM public.customers c WHERE c.id = (p_ship_to->>'customer_id')::uuid;
        IF NOT FOUND OR v_customer.company_id <> p_company_id THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        IF v_customer.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived, so it can''t be shipped to.', v_customer.name USING ERRCODE = 'P0001';
        END IF;
        IF NULLIF(p_ship_to->>'customer_address_id', '') IS NOT NULL THEN
            v_address := (p_ship_to->>'customer_address_id')::uuid;
            IF NOT EXISTS (SELECT 1 FROM public.customer_addresses a
                            WHERE a.id = v_address AND a.customer_id = v_customer.id) THEN
                RAISE EXCEPTION 'That address isn''t one of %''s.', v_customer.name USING ERRCODE = 'P0001';
            END IF;
        ELSE
            SELECT a.id INTO v_address FROM public.customer_addresses a
             WHERE a.customer_id = v_customer.id
             ORDER BY a.default_shipping DESC, a.default_billing DESC, a.created_at
             LIMIT 1;
        END IF;
        RETURN jsonb_build_object(
            'kind', 'customer', 'vendor_id', NULL, 'vendor_address_id', NULL,
            'customer_id', v_customer.id, 'customer_address_id', v_address,
            'name', v_customer.name, 'address', public.address_block_snapshot(v_address));
    END IF;

    RAISE EXCEPTION 'Unknown ship-to kind %', v_kind USING ERRCODE = 'XX000';
END
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_resolve_ship_to(uuid, jsonb) IS
  'Resolves {kind: shop|vendor|customer, vendor_id, vendor_address_id, customer_id, customer_address_id} into the ids and the frozen name and AddressSnapshot a PO stores. Defaults: our shop; the vendor''s default address; the customer''s default shipping address. Refuses ids on the wrong side, other companies'' records and archived parties. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_resolve_ship_to(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_resolve_ship_to(uuid, jsonb) TO service_role;


-- The vendor's contact and address, defaulted and checked. The contact defaults to the
-- vendor's sales contact (the primary one first), then its primary contact; the address to
-- its default address.
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_vendor_party(p_vendor_id uuid, p_header jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_name    text;
    v_contact uuid;
    v_address uuid;
BEGIN
    SELECT v.name INTO v_name FROM public.vendors v WHERE v.id = p_vendor_id;

    IF p_header ? 'vendor_contact_id' THEN
        v_contact := NULLIF(p_header->>'vendor_contact_id', '')::uuid;
        IF v_contact IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.vendor_contacts c WHERE c.id = v_contact AND c.vendor_id = p_vendor_id) THEN
            RAISE EXCEPTION 'That contact isn''t one of %''s.', v_name USING ERRCODE = 'P0001';
        END IF;
    ELSE
        SELECT c.id INTO v_contact FROM public.vendor_contacts c
         WHERE c.vendor_id = p_vendor_id AND (c.role = 'sales' OR c.is_primary)
         ORDER BY (c.role = 'sales') DESC, c.is_primary DESC, c.created_at
         LIMIT 1;
    END IF;

    IF p_header ? 'vendor_address_id' THEN
        v_address := NULLIF(p_header->>'vendor_address_id', '')::uuid;
        IF v_address IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.vendor_addresses a WHERE a.id = v_address AND a.vendor_id = p_vendor_id) THEN
            RAISE EXCEPTION 'That address isn''t one of %''s.', v_name USING ERRCODE = 'P0001';
        END IF;
    ELSE
        SELECT a.id INTO v_address FROM public.vendor_addresses a
         WHERE a.vendor_id = p_vendor_id AND a.is_default LIMIT 1;
    END IF;

    RETURN jsonb_build_object(
        'vendor_contact_id', v_contact,
        'vendor_contact', public.vendor_contact_block_snapshot(v_contact),
        'vendor_address_id', v_address,
        'vendor_address', public.vendor_address_block_snapshot(v_address));
END
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_vendor_party(uuid, jsonb) IS
  'The vendor contact and address a PO freezes: the ones named in p_header (checked to belong to the vendor), else the vendor''s sales contact (primary first) or primary contact, and its default address. Returns ids and snapshots. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_vendor_party(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_vendor_party(uuid, jsonb) TO service_role;


-- Inserts a header (number minted, parties frozen, terms copied from the series). Shared by
-- create_vendor_purchase_order and award_vendor_rfq; both did the preamble first.
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_insert(
    p_company_id    uuid,
    p_vendor_id     uuid,
    p_ordered_on    date,
    p_header        jsonb,
    p_vendor_rfq_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_header   jsonb := COALESCE(p_header, '{}'::jsonb);
    v_vendor   record;
    v_party    jsonb;
    v_ship     jsonb;
    v_number   text;
    v_payment  text;
    v_ship_via text;
    v_notes    text;
    v_internal text;
    v_id       uuid;
BEGIN
    PERFORM public.purchasing_assert_keys(v_header,
        ARRAY['vendor_contact_id', 'vendor_address_id', 'ship_to', 'need_by_on',
              'payment_terms', 'ship_via', 'notes_to_vendor', 'internal_notes'],
        'the purchase order header');

    SELECT v.id, v.company_id, v.name, v.deleted_at, v.default_payment_terms INTO v_vendor
      FROM public.vendors v WHERE v.id = p_vendor_id;
    IF NOT FOUND OR v_vendor.company_id <> p_company_id THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;
    IF v_vendor.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived. Restore it before ordering from it.', v_vendor.name
            USING ERRCODE = 'P0001';
    END IF;
    IF p_ordered_on IS NULL THEN
        RAISE EXCEPTION 'Give the order date.' USING ERRCODE = 'P0001';
    END IF;

    v_party := public.vendor_purchase_order_vendor_party(p_vendor_id, v_header);
    v_ship  := public.vendor_purchase_order_resolve_ship_to(p_company_id, v_header->'ship_to');

    -- The vendor's standing terms fill a create that names none; an explicit null clears them.
    v_payment := CASE WHEN v_header ? 'payment_terms' THEN NULLIF(btrim(v_header->>'payment_terms'), '')
                      ELSE NULLIF(btrim(v_vendor.default_payment_terms), '') END;
    v_ship_via := NULLIF(btrim(v_header->>'ship_via'), '');
    v_notes    := NULLIF(btrim(v_header->>'notes_to_vendor'), '');
    v_internal := NULLIF(btrim(v_header->>'internal_notes'), '');

    IF char_length(v_payment) > 100 THEN
        RAISE EXCEPTION 'Payment terms can be at most 100 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_ship_via) > 100 THEN
        RAISE EXCEPTION 'Ship via can be at most 100 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_notes) > 10000 OR char_length(v_internal) > 10000 THEN
        RAISE EXCEPTION 'Notes can be at most 10,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    v_number := public.next_purchasing_document_number(p_company_id, 'vendor_purchase_order');

    INSERT INTO public.vendor_purchase_orders (
        company_id, po_number, vendor_id, vendor_name,
        vendor_address_id, vendor_address, vendor_contact_id, vendor_contact,
        ship_to_kind, ship_to_vendor_id, ship_to_vendor_address_id,
        ship_to_customer_id, ship_to_customer_address_id, ship_to_name, ship_to_address,
        ordered_on, need_by_on, payment_terms, ship_via,
        notes_to_vendor, internal_notes,
        vendor_rfq_id, created_by
    ) VALUES (
        p_company_id, v_number, v_vendor.id, v_vendor.name,
        (v_party->>'vendor_address_id')::uuid, NULLIF(v_party->'vendor_address', 'null'::jsonb),
        (v_party->>'vendor_contact_id')::uuid, NULLIF(v_party->'vendor_contact', 'null'::jsonb),
        v_ship->>'kind', (v_ship->>'vendor_id')::uuid, (v_ship->>'vendor_address_id')::uuid,
        (v_ship->>'customer_id')::uuid, (v_ship->>'customer_address_id')::uuid,
        v_ship->>'name', NULLIF(v_ship->'address', 'null'::jsonb),
        p_ordered_on, (v_header->>'need_by_on')::date, v_payment, v_ship_via,
        v_notes, v_internal,
        p_vendor_rfq_id, auth.uid()
    ) RETURNING id INTO v_id;

    RETURN v_id;
END
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_insert(uuid, uuid, date, jsonb, uuid) IS
  'Inserts a draft vendor PO header: number minted, vendor contact/address and ship-to frozen, payment terms from the vendor''s standing terms unless named. The caller has already asserted membership, role and billing. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_insert(uuid, uuid, date, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_insert(uuid, uuid, date, jsonb, uuid) TO service_role;


-- One line, inserted (no "id") or patched (an "id" of THIS PO). Every rule for every kind
-- lives here, once, for create, save and award:
--   part             a live part of this company, made or bought; the vendor must not be
--                    marked Do not use for it; the unit is the stock unit or has exactly
--                    one conversion, and its factor is frozen.
--   outside_service  an outside step of this company whose service this vendor performs, on
--                    a live job; one open line per (step, vendor); counted in the part's
--                    own unit; no promised date of its own. Inserting it links the live
--                    unlinked slips already sent for that step to that vendor.
--   other            free text, optionally on a work centre and/or a job; may expect no
--                    receipt (freight, a fee).
-- An existing line's kind and routing step never change, draft or sent: the kind decides
-- what the line prints and how it is received, the step which slips follow it. A different
-- kind or step is a different line, so the caller removes this one (or closes it) and adds
-- one; that is why neither is a key on the shared vendor-visible field list.
-- After a receipt: quantity cannot drop below it, and part, unit and factor are fixed. A
-- closed line takes only its promised date.
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_upsert_line(
    p_vendor_purchase_order_id uuid,
    p_line jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_po             public.vendor_purchase_orders%ROWTYPE;
    v_old            public.vendor_purchase_order_lines%ROWTYPE;
    v_new            boolean;
    v_label          text;
    v_kind           text;
    v_part_id        uuid;
    v_op_id          uuid;
    v_job_id         uuid;
    v_job_part_id    uuid;
    v_wc_id          uuid;
    v_desc           text;
    v_vpn            text;
    v_qty            numeric;
    v_unit           text;
    v_price          numeric;
    v_source         text;
    v_need_by        date;
    v_promised       date;
    v_cert           boolean;
    v_expects        boolean;
    v_part_name      text;
    v_stock_unit     text;
    v_factor         numeric;
    v_job_number     text;
    v_op_label       text;
    v_service_id     uuid;
    v_service_name   text;
    v_wc_name        text;
    v_part           record;
    v_op             record;
    v_job            record;
    v_wc             record;
    v_conflict       record;
    v_avl_status     text;
    v_avl_vpn        text;
    v_other_vendor   text;
    v_live_receipts  boolean := false;
    v_received_stock numeric := 0;
    v_received_qty   numeric := 0;
    v_slip_good      numeric := 0;
    v_part_changed   boolean := false;
    v_op_changed     boolean := false;
    v_unit_changed   boolean := false;
    v_line_id        uuid;
    v_line_number    integer;
    v_linked         uuid[] := '{}';
BEGIN
    PERFORM public.purchasing_assert_keys(p_line,
        ARRAY['id', 'line_kind', 'part_id', 'job_operation_id', 'job_id', 'job_part_id',
              'work_center_id', 'description', 'vendor_part_number', 'quantity', 'unit',
              'unit_price', 'price_source', 'need_by_on', 'promised_on', 'cert_required',
              'expects_receipt'],
        'a purchase order line');

    SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = p_vendor_purchase_order_id;
    v_new := NOT (p_line ? 'id');

    IF v_new THEN
        v_kind := p_line->>'line_kind';
        IF v_kind IS NULL OR v_kind NOT IN ('part', 'outside_service', 'other') THEN
            RAISE EXCEPTION 'A new purchase order line needs line_kind part, outside_service or other.'
                USING ERRCODE = 'XX000';
        END IF;
        v_label   := 'The new line';
        v_cert    := false;
        v_expects := true;
        v_need_by := v_po.need_by_on;   -- frozen onto the line: no read-time fallback
    ELSE
        SELECT * INTO v_old FROM public.vendor_purchase_order_lines
         WHERE id = NULLIF(p_line->>'id', '')::uuid
           AND vendor_purchase_order_id = p_vendor_purchase_order_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        v_line_id      := v_old.id;
        v_line_number  := v_old.line_number;
        v_label        := 'Line ' || v_old.line_number;
        v_kind         := COALESCE(p_line->>'line_kind', v_old.line_kind);
        IF v_kind NOT IN ('part', 'outside_service', 'other') THEN
            RAISE EXCEPTION 'Unknown line_kind %', v_kind USING ERRCODE = 'XX000';
        END IF;
        -- Kind and step are what the line IS (see the header). Repeating them is no change.
        IF v_kind <> v_old.line_kind
           OR (p_line ? 'job_operation_id'
               AND NULLIF(p_line->>'job_operation_id', '')::uuid IS DISTINCT FROM v_old.job_operation_id) THEN
            RAISE EXCEPTION '% can''t change its kind or its routing step. Add a new line instead, and remove or close this one.',
                v_label USING ERRCODE = 'P0001';
        END IF;
        v_part_id      := v_old.part_id;
        v_op_id        := v_old.job_operation_id;
        v_job_id       := v_old.job_id;
        v_job_part_id  := v_old.job_part_id;
        v_wc_id        := v_old.work_center_id;
        v_desc         := v_old.description;
        v_vpn          := v_old.vendor_part_number;
        v_qty          := v_old.quantity;
        v_unit         := v_old.unit;
        v_price        := v_old.unit_price;
        v_source       := v_old.price_source;
        v_need_by      := v_old.need_by_on;
        v_promised     := v_old.promised_on;
        v_cert         := v_old.cert_required;
        v_expects      := v_old.expects_receipt;
        v_part_name    := v_old.part_name;
        v_stock_unit   := v_old.stock_unit;
        v_factor       := v_old.stock_factor;
        v_job_number   := v_old.job_number;
        v_op_label     := v_old.operation_label;
        v_service_id   := v_old.vendor_service_id;
        v_service_name := v_old.service_name;
        v_wc_name      := v_old.work_center_name;

        -- A closed line takes only its promised date.
        IF v_old.closed_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_object_keys(p_line) k WHERE k NOT IN ('id', 'promised_on')) THEN
            RAISE EXCEPTION '% is closed. Reopen it to change it.', v_label USING ERRCODE = 'P0001';
        END IF;

        -- What has already happened on it.
        IF v_old.line_kind = 'outside_service' THEN
            SELECT COALESCE(sum(COALESCE(back.good, 0)), 0) INTO v_slip_good
              FROM public.outside_shipments s
              LEFT JOIN LATERAL (
                  SELECT sum(x.quantity_good) AS good FROM public.outside_shipment_receipts x
                   WHERE x.outside_shipment_id = s.id AND x.voided_at IS NULL) back ON true
             WHERE s.vendor_purchase_order_line_id = v_old.id AND s.voided_at IS NULL;
            v_live_receipts := v_slip_good > 0;
        ELSE
            SELECT count(*) > 0, COALESCE(sum(r.stock_quantity), 0), COALESCE(sum(r.quantity), 0)
              INTO v_live_receipts, v_received_stock, v_received_qty
              FROM public.vendor_purchase_order_receipts r
             WHERE r.vendor_purchase_order_line_id = v_old.id AND r.voided_at IS NULL;
        END IF;
    END IF;

    -- The payload, over the starting values.
    IF p_line ? 'part_id'            THEN v_part_id     := NULLIF(p_line->>'part_id', '')::uuid; END IF;
    IF p_line ? 'job_operation_id'   THEN v_op_id       := NULLIF(p_line->>'job_operation_id', '')::uuid; END IF;
    IF p_line ? 'job_id'             THEN v_job_id      := NULLIF(p_line->>'job_id', '')::uuid; END IF;
    IF p_line ? 'job_part_id'        THEN v_job_part_id := NULLIF(p_line->>'job_part_id', '')::uuid; END IF;
    IF p_line ? 'work_center_id'     THEN v_wc_id       := NULLIF(p_line->>'work_center_id', '')::uuid; END IF;
    IF p_line ? 'description'        THEN v_desc        := NULLIF(btrim(p_line->>'description'), ''); END IF;
    IF p_line ? 'vendor_part_number' THEN v_vpn         := NULLIF(btrim(p_line->>'vendor_part_number'), ''); END IF;
    IF p_line ? 'quantity'           THEN v_qty         := (p_line->>'quantity')::numeric; END IF;
    IF p_line ? 'unit'               THEN v_unit        := NULLIF(btrim(p_line->>'unit'), ''); END IF;
    IF p_line ? 'need_by_on'         THEN v_need_by     := NULLIF(p_line->>'need_by_on', '')::date; END IF;
    IF p_line ? 'promised_on'        THEN v_promised    := NULLIF(p_line->>'promised_on', '')::date; END IF;
    IF p_line ? 'cert_required'      THEN v_cert        := COALESCE((p_line->>'cert_required')::boolean, false); END IF;
    IF p_line ? 'expects_receipt'    THEN v_expects     := COALESCE((p_line->>'expects_receipt')::boolean, true); END IF;
    -- Clearing the job clears its job part too, unless the payload names one.
    IF p_line ? 'job_id' AND v_job_id IS NULL AND NOT (p_line ? 'job_part_id') THEN
        v_job_part_id := NULL;
    END IF;
    -- The six sources are the whole list, whatever else the line says.
    IF NULLIF(p_line->>'price_source', '') IS NOT NULL
       AND p_line->>'price_source' NOT IN ('price_sheet', 'last_po', 'estimate', 'vendor_service', 'rfq', 'manual') THEN
        RAISE EXCEPTION 'A price source is one of price_sheet, last_po, estimate, vendor_service, rfq or manual, not "%".',
            p_line->>'price_source' USING ERRCODE = 'P0001';
    END IF;
    IF p_line ? 'unit_price' THEN
        v_price  := NULLIF(p_line->>'unit_price', '')::numeric;
        v_source := COALESCE(NULLIF(p_line->>'price_source', ''), 'manual');
    ELSIF p_line ? 'price_source' THEN
        v_source := NULLIF(p_line->>'price_source', '');
    END IF;
    IF v_price IS NULL THEN
        v_source := NULL;                       -- "to be confirmed" has no source
    ELSIF v_source IS NULL THEN
        v_source := 'manual';
    END IF;

    v_part_changed := v_new OR v_part_id IS DISTINCT FROM v_old.part_id;
    v_op_changed   := v_new;   -- an existing line's step is fixed (refused above)

    -- ---- by kind --------------------------------------------------------------
    IF v_kind = 'part' THEN
        IF p_line ? 'job_operation_id' AND v_op_id IS NOT NULL THEN
            RAISE EXCEPTION 'Only an outside-service line pays for a routing step.' USING ERRCODE = 'P0001';
        END IF;
        IF p_line ? 'work_center_id' AND v_wc_id IS NOT NULL THEN
            RAISE EXCEPTION 'Only an Other line names a machine.' USING ERRCODE = 'P0001';
        END IF;
        IF p_line ? 'expects_receipt' AND NOT v_expects THEN
            RAISE EXCEPTION 'Only an Other line can skip receiving (freight, a fee).' USING ERRCODE = 'P0001';
        END IF;
        v_op_id := NULL; v_op_label := NULL; v_service_id := NULL; v_service_name := NULL;
        v_wc_id := NULL; v_wc_name := NULL; v_expects := true;

        IF v_part_id IS NULL THEN
            RAISE EXCEPTION '% needs a part.', v_label USING ERRCODE = 'P0001';
        END IF;
        SELECT p.id, p.company_id, p.part_name, p.description, p.primary_unit, p.deleted_at INTO v_part
          FROM public.parts p WHERE p.id = v_part_id;
        IF NOT FOUND OR v_part.company_id <> v_po.company_id THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;

        IF v_part_changed THEN
            IF NOT v_new AND v_live_receipts THEN
                RAISE EXCEPTION '% has receipts, so its part can''t change.', v_label USING ERRCODE = 'P0001';
            END IF;
            IF v_part.deleted_at IS NOT NULL THEN
                RAISE EXCEPTION '% is archived. Restore it before ordering it.', v_part.part_name
                    USING ERRCODE = 'P0001';
            END IF;
            SELECT pv.status, pv.vendor_part_number INTO v_avl_status, v_avl_vpn
              FROM public.part_vendors pv
             WHERE pv.part_id = v_part_id AND pv.vendor_id = v_po.vendor_id AND pv.deleted_at IS NULL;
            IF v_avl_status = 'disapproved' THEN
                RAISE EXCEPTION '% is marked Do not use for %.', v_po.vendor_name, v_part.part_name
                    USING ERRCODE = 'P0001';
            END IF;
            IF NOT (p_line ? 'vendor_part_number') THEN
                v_vpn := v_avl_vpn;
            END IF;
            IF NOT (p_line ? 'description') OR v_desc IS NULL THEN
                v_desc := COALESCE(NULLIF(btrim(v_part.description), ''), v_part.part_name);
            END IF;
            IF NOT (p_line ? 'unit') THEN
                v_unit := NULL;
            END IF;
        END IF;
        IF v_part_changed OR p_line ? 'part_id' THEN
            v_part_name := v_part.part_name;   -- an id in the payload is an explicit refresh
        END IF;
        IF v_unit IS NULL THEN
            v_unit := v_part.primary_unit;
        END IF;

        v_unit_changed := v_part_changed
            OR public.unit_name_key(v_unit) IS DISTINCT FROM public.unit_name_key(v_old.unit);
        IF v_unit_changed THEN
            IF NOT v_new AND v_live_receipts THEN
                RAISE EXCEPTION '% has receipts, so its unit can''t change.', v_label USING ERRCODE = 'P0001';
            END IF;
            v_factor     := public.part_unit_factor(v_part_id, v_unit);
            v_stock_unit := v_part.primary_unit;
        END IF;

    ELSIF v_kind = 'outside_service' THEN
        IF p_line ? 'work_center_id' AND v_wc_id IS NOT NULL THEN
            RAISE EXCEPTION 'Only an Other line names a machine.' USING ERRCODE = 'P0001';
        END IF;
        IF p_line ? 'promised_on' AND v_promised IS NOT NULL THEN
            RAISE EXCEPTION 'An outside line has no promised date of its own: its slips'' due-back dates are what you are waiting on.'
                USING ERRCODE = 'P0001';
        END IF;
        IF p_line ? 'expects_receipt' AND NOT v_expects THEN
            RAISE EXCEPTION 'Only an Other line can skip receiving (freight, a fee).' USING ERRCODE = 'P0001';
        END IF;
        v_wc_id := NULL; v_wc_name := NULL; v_promised := NULL; v_expects := true;
        v_stock_unit := NULL; v_factor := NULL;

        IF v_op_id IS NULL THEN
            RAISE EXCEPTION '% needs the routing step it pays for.', v_label USING ERRCODE = 'P0001';
        END IF;
        SELECT o.id, o.job_id, o.job_part_id, o.sequence, o.operation_name, o.vendor_service_id,
               jp.company_id, jp.part_id, jp.quantity AS job_part_quantity,
               j.job_number, j.deleted_at AS job_deleted_at,
               vs.vendor_id AS service_vendor_id, vs.name AS service_name,
               p.part_name, p.primary_unit
          INTO v_op
          FROM public.job_operations o
          JOIN public.job_parts jp ON jp.id = o.job_part_id
          JOIN public.jobs j       ON j.id  = o.job_id
          JOIN public.parts p      ON p.id  = jp.part_id
          LEFT JOIN public.vendor_services vs ON vs.id = o.vendor_service_id
         WHERE o.id = v_op_id;
        IF NOT FOUND OR v_op.company_id <> v_po.company_id THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;

        IF v_op_changed THEN
            IF v_op.vendor_service_id IS NULL THEN
                RAISE EXCEPTION 'Op % on % is done in-house, so it can''t be outside work on a purchase order.',
                    v_op.sequence, v_op.job_number USING ERRCODE = 'P0001';
            END IF;
            IF v_op.service_vendor_id IS DISTINCT FROM v_po.vendor_id THEN
                SELECT v.name INTO v_other_vendor FROM public.vendors v WHERE v.id = v_op.service_vendor_id;
                RAISE EXCEPTION 'Op % on % is done by %, not %.',
                    v_op.sequence, v_op.job_number, COALESCE(v_other_vendor, 'another vendor'), v_po.vendor_name
                    USING ERRCODE = 'P0001';
            END IF;
            IF v_op.job_deleted_at IS NOT NULL THEN
                RAISE EXCEPTION '% is archived.', v_op.job_number USING ERRCODE = 'P0001';
            END IF;
            v_op_label     := 'Op ' || v_op.sequence
                              || COALESCE(' ' || NULLIF(btrim(v_op.operation_name), ''), '');
            v_service_id   := v_op.vendor_service_id;
            v_service_name := v_op.service_name;
            v_part_name    := v_op.part_name;
            v_job_number   := v_op.job_number;
            IF NOT (p_line ? 'description') OR v_desc IS NULL THEN
                v_desc := format('%s — %s — Job %s, Op %s',
                                 v_op.service_name, v_op.part_name, v_op.job_number, v_op.sequence);
            END IF;
            IF NOT (p_line ? 'unit') THEN
                v_unit := NULL;
            END IF;
        END IF;

        -- The job, the job part and the part come from the step, always.
        IF (p_line ? 'job_id' AND v_job_id IS DISTINCT FROM v_op.job_id)
           OR (p_line ? 'job_part_id' AND v_job_part_id IS DISTINCT FROM v_op.job_part_id)
           OR (p_line ? 'part_id' AND v_part_id IS DISTINCT FROM v_op.part_id) THEN
            RAISE EXCEPTION 'An outside line takes its job and part from its routing step.' USING ERRCODE = 'P0001';
        END IF;
        v_job_id := v_op.job_id; v_job_part_id := v_op.job_part_id; v_part_id := v_op.part_id;

        IF v_unit IS NULL THEN
            v_unit := v_op.primary_unit;
        END IF;
        IF (v_op_changed OR p_line ? 'unit')
           AND public.unit_name_key(v_unit) IS DISTINCT FROM public.unit_name_key(v_op.primary_unit) THEN
            RAISE EXCEPTION 'Outside work is counted in % (the part''s own unit), not %.',
                v_op.primary_unit, v_unit USING ERRCODE = 'P0001';
        END IF;
        IF v_qty IS NULL THEN
            v_qty := v_op.job_part_quantity;
        END IF;

        -- At most one open outside line per (step, vendor), across every live, open PO.
        IF v_op_changed THEN
            SELECT h.po_number, l.line_number INTO v_conflict
              FROM public.vendor_purchase_order_lines l
              JOIN public.vendor_purchase_orders h ON h.id = l.vendor_purchase_order_id
             WHERE l.job_operation_id = v_op_id
               AND l.line_kind = 'outside_service'
               AND l.closed_at IS NULL
               AND h.vendor_id = v_po.vendor_id
               AND h.closed_at IS NULL
               AND h.deleted_at IS NULL
               AND l.id IS DISTINCT FROM v_line_id
             LIMIT 1;
            IF FOUND THEN
                RAISE EXCEPTION 'Op % on % is already on % line % to %. Change that line instead.',
                    v_op.sequence, v_op.job_number, v_conflict.po_number, v_conflict.line_number,
                    v_po.vendor_name USING ERRCODE = 'P0001';
            END IF;
        END IF;

    ELSE  -- other
        IF p_line ? 'part_id' AND v_part_id IS NOT NULL THEN
            RAISE EXCEPTION 'An Other line doesn''t name a part. Use a Part line to buy a part.' USING ERRCODE = 'P0001';
        END IF;
        IF p_line ? 'job_operation_id' AND v_op_id IS NOT NULL THEN
            RAISE EXCEPTION 'Only an outside-service line pays for a routing step.' USING ERRCODE = 'P0001';
        END IF;
        v_part_id := NULL; v_part_name := NULL; v_op_id := NULL; v_op_label := NULL;
        v_service_id := NULL; v_service_name := NULL; v_stock_unit := NULL; v_factor := NULL;

        IF v_desc IS NULL THEN
            RAISE EXCEPTION '% needs a description.', v_label USING ERRCODE = 'P0001';
        END IF;
        IF v_unit IS NULL THEN
            v_unit := 'each';
        END IF;
        IF NOT v_new AND NOT v_expects AND (v_received_qty > 0 OR v_live_receipts) THEN
            RAISE EXCEPTION '% has receipts, so it has to keep expecting them.', v_label USING ERRCODE = 'P0001';
        END IF;

        IF v_wc_id IS NULL THEN
            v_wc_name := NULL;
        ELSIF v_new OR p_line ? 'work_center_id' THEN
            SELECT w.company_id, w.name, w.deleted_at INTO v_wc
              FROM public.work_centers w WHERE w.id = v_wc_id;
            IF NOT FOUND OR v_wc.company_id <> v_po.company_id THEN
                RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
            END IF;
            IF v_wc.deleted_at IS NOT NULL AND (v_new OR v_wc_id IS DISTINCT FROM v_old.work_center_id) THEN
                RAISE EXCEPTION '% is archived.', v_wc.name USING ERRCODE = 'P0001';
            END IF;
            v_wc_name := v_wc.name;
        END IF;
    END IF;

    -- ---- job links on part and other lines --------------------------------------
    IF v_kind <> 'outside_service' THEN
        IF v_job_part_id IS NOT NULL THEN
            SELECT jp.job_id, jp.company_id INTO v_job
              FROM public.job_parts jp WHERE jp.id = v_job_part_id;
            IF NOT FOUND OR v_job.company_id <> v_po.company_id THEN
                RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
            END IF;
            IF p_line ? 'job_id' AND v_job_id IS NOT NULL AND v_job_id <> v_job.job_id THEN
                RAISE EXCEPTION 'That job part belongs to another job.' USING ERRCODE = 'P0001';
            END IF;
            v_job_id := v_job.job_id;
        END IF;
        IF v_job_id IS NOT NULL THEN
            SELECT j.company_id, j.job_number, j.deleted_at INTO v_job
              FROM public.jobs j WHERE j.id = v_job_id;
            IF NOT FOUND OR v_job.company_id <> v_po.company_id THEN
                RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
            END IF;
            IF v_job.deleted_at IS NOT NULL AND (v_new OR v_job_id IS DISTINCT FROM v_old.job_id) THEN
                RAISE EXCEPTION '% is archived.', v_job.job_number USING ERRCODE = 'P0001';
            END IF;
            IF v_new OR v_job_id IS DISTINCT FROM v_old.job_id OR p_line ? 'job_id' OR v_job_number IS NULL THEN
                v_job_number := v_job.job_number;
            END IF;
        ELSE
            v_job_number := NULL;
            v_job_part_id := NULL;
        END IF;
    END IF;

    -- ---- the CHECKs, as sentences ------------------------------------------------
    IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION '% needs a quantity greater than zero.', v_label USING ERRCODE = 'P0001';
    END IF;
    IF v_desc IS NULL THEN
        RAISE EXCEPTION '% needs a description.', v_label USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_desc) > 2000 THEN
        RAISE EXCEPTION 'A line description can be at most 2,000 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_vpn) > 64 THEN
        RAISE EXCEPTION 'A vendor part number can be at most 64 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_unit) > 40 THEN
        RAISE EXCEPTION 'A unit name can be at most 40 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF v_price IS NOT NULL AND v_price < 0 THEN
        RAISE EXCEPTION 'A price can''t be negative.' USING ERRCODE = 'P0001';
    END IF;
    IF v_price IS NOT NULL AND v_price >= 100000000000 THEN
        RAISE EXCEPTION 'That price is too large.' USING ERRCODE = 'P0001';
    END IF;

    -- Not below what has arrived. Part lines compare in stock units, exactly.
    IF NOT v_new THEN
        IF v_kind = 'part' AND v_qty * v_factor < v_received_stock THEN
            RAISE EXCEPTION '% has % % received, so its quantity can''t go below that.',
                v_label, trim_scale(v_received_stock / v_factor), v_unit USING ERRCODE = 'P0001';
        ELSIF v_kind = 'outside_service' AND v_qty < v_slip_good THEN
            RAISE EXCEPTION '% has % back from the vendor, so its quantity can''t go below that.',
                v_label, v_slip_good USING ERRCODE = 'P0001';
        ELSIF v_kind = 'other' AND v_qty < v_received_qty THEN
            RAISE EXCEPTION '% has % received, so its quantity can''t go below that.',
                v_label, v_received_qty USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- ---- write ------------------------------------------------------------------
    IF v_new THEN
        UPDATE public.vendor_purchase_orders
           SET last_line_number = last_line_number + 1
         WHERE id = v_po.id
        RETURNING last_line_number INTO v_line_number;

        INSERT INTO public.vendor_purchase_order_lines (
            company_id, vendor_purchase_order_id, line_number, line_kind,
            part_id, part_name, description, vendor_part_number,
            quantity, unit, stock_unit, stock_factor, unit_price, price_source,
            need_by_on, promised_on, cert_required, expects_receipt,
            job_id, job_number, job_part_id, job_operation_id, operation_label,
            vendor_service_id, service_name, work_center_id, work_center_name, created_by
        ) VALUES (
            v_po.company_id, v_po.id, v_line_number, v_kind,
            v_part_id, v_part_name, v_desc, v_vpn,
            v_qty, v_unit, v_stock_unit, v_factor, v_price, v_source,
            v_need_by, v_promised, v_cert, v_expects,
            v_job_id, v_job_number, v_job_part_id, v_op_id, v_op_label,
            v_service_id, v_service_name, v_wc_id, v_wc_name, auth.uid()
        ) RETURNING id INTO v_line_id;
    ELSE
        UPDATE public.vendor_purchase_order_lines SET
            line_kind          = v_kind,
            part_id            = v_part_id,
            part_name          = v_part_name,
            description        = v_desc,
            vendor_part_number = v_vpn,
            quantity           = v_qty,
            unit               = v_unit,
            stock_unit         = v_stock_unit,
            stock_factor       = v_factor,
            unit_price         = v_price,
            price_source       = v_source,
            need_by_on         = v_need_by,
            promised_on        = v_promised,
            cert_required      = v_cert,
            expects_receipt    = v_expects,
            job_id             = v_job_id,
            job_number         = v_job_number,
            job_part_id        = v_job_part_id,
            job_operation_id   = v_op_id,
            operation_label    = v_op_label,
            vendor_service_id  = v_service_id,
            service_name       = v_service_name,
            work_center_id     = v_wc_id,
            work_center_name   = v_wc_name
         WHERE id = v_line_id;
    END IF;

    -- A new outside line picks up the live, unlinked slips already sent for its step to this
    -- vendor. (An existing line's step never changes, so it never needs to.)
    IF v_kind = 'outside_service' AND v_op_changed THEN
        WITH linked AS (
            UPDATE public.outside_shipments s
               SET vendor_purchase_order_line_id = v_line_id
             WHERE s.company_id = v_po.company_id
               AND s.job_operation_id = v_op_id
               AND s.vendor_id = v_po.vendor_id
               AND s.voided_at IS NULL
               AND s.vendor_purchase_order_line_id IS NULL
            RETURNING s.id
        )
        SELECT COALESCE(array_agg(linked.id), '{}'::uuid[]) INTO v_linked FROM linked;
    END IF;

    RETURN jsonb_build_object(
        'line_id', v_line_id,
        'line_number', v_line_number,
        'linked_outside_shipment_ids', to_jsonb(v_linked));
END
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_upsert_line(uuid, jsonb) IS
  'Inserts (no "id") or patches (an "id" of this PO) one vendor PO line, enforcing every per-kind rule: part (live part, not Do not use, unit with exactly one factor, frozen), outside_service (an outside step this vendor performs on a live job, one open line per step and vendor, the part''s own unit, no promised date; links existing unlinked slips) and other (description, optional work centre/job, may expect no receipt). An existing line''s line_kind and job_operation_id never change (P0001: add a new line instead); after a receipt the quantity cannot drop below it and part, unit and factor are fixed; a closed line takes only promised_on. Snapshots freeze at insert or on an explicit id. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_upsert_line(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_upsert_line(uuid, jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.vendor_purchase_order_write_lines(
    p_vendor_purchase_order_id uuid,
    p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_line   jsonb;
    v_result jsonb;
    v_ids    jsonb := '[]'::jsonb;
    v_linked jsonb := '[]'::jsonb;
BEGIN
    IF p_lines IS NULL OR p_lines = 'null'::jsonb THEN
        RETURN jsonb_build_object('line_ids', v_ids, 'linked_outside_shipment_ids', v_linked);
    END IF;
    IF jsonb_typeof(p_lines) <> 'array' THEN
        RAISE EXCEPTION 'p_lines must be a JSON array' USING ERRCODE = 'XX000';
    END IF;
    FOR v_line IN
        SELECT e.value FROM jsonb_array_elements(p_lines) WITH ORDINALITY e ORDER BY e.ordinality
    LOOP
        v_result := public.vendor_purchase_order_upsert_line(p_vendor_purchase_order_id, v_line);
        v_ids    := v_ids || jsonb_build_array(v_result->'line_id');
        v_linked := v_linked || (v_result->'linked_outside_shipment_ids');
    END LOOP;
    RETURN jsonb_build_object('line_ids', v_ids, 'linked_outside_shipment_ids', v_linked);
END
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_write_lines(uuid, jsonb) IS
  'Applies a p_lines array to a PO in order through vendor_purchase_order_upsert_line. Returns {line_ids (one per element, in order), linked_outside_shipment_ids}. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_write_lines(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_write_lines(uuid, jsonb) TO service_role;


-- The revision and the QuickBooks content version, settled at the end of every writer --
-- with the PO header locked, which every caller has done first.
-- REVISION: only when allowed (vendor-visible saves), only once per send cycle -- the PO
-- was sent, the current revision IS the sent one, and the vendor-visible document no longer
-- hashes to what was sent. Drafts never bump.
-- CONTENT VERSION: whenever the pushed projection no longer hashes to content_hash, the md5
-- the current content_version was counted for. Compared with what is STORED, not with a
-- hash the caller took before its change, so a change is counted whoever made it: an RPC, or
-- the trigger behind a receipt on a linked vendor packing slip (a plain table write with no
-- RPC around it). The first settle of a new PO (content_hash NULL, inside the RPC that
-- created it) records the hash and counts nothing.
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_settle_versions(
    p_vendor_purchase_order_id uuid,
    p_may_bump_revision        boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_po        public.vendor_purchase_orders%ROWTYPE;
    v_sent_hash text;
    v_hash      text;
    v_bumped    boolean := false;
    v_changed   boolean := false;
BEGIN
    SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = p_vendor_purchase_order_id;

    IF p_may_bump_revision AND v_po.issued_at IS NOT NULL AND v_po.revision = v_po.sent_revision THEN
        SELECT r.document_hash INTO v_sent_hash
          FROM public.vendor_purchase_order_revisions r
         WHERE r.vendor_purchase_order_id = v_po.id AND r.revision = v_po.sent_revision;
        IF v_sent_hash IS DISTINCT FROM public.vendor_purchase_order_document_hash(v_po.id) THEN
            UPDATE public.vendor_purchase_orders SET revision = revision + 1 WHERE id = v_po.id;
            v_bumped := true;
        END IF;
    END IF;

    -- After the revision, which the projection carries.
    v_hash := md5(public.vendor_purchase_order_pushed_projection(v_po.id)::text);
    IF v_po.content_hash IS NULL THEN
        UPDATE public.vendor_purchase_orders SET content_hash = v_hash WHERE id = v_po.id;
    ELSIF v_po.content_hash IS DISTINCT FROM v_hash THEN
        UPDATE public.vendor_purchase_orders
           SET content_version = content_version + 1, content_hash = v_hash
         WHERE id = v_po.id;
        v_changed := true;
    END IF;

    SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = p_vendor_purchase_order_id;
    RETURN jsonb_build_object(
        'revision', v_po.revision,
        'sent_revision', v_po.sent_revision,
        'revision_bumped', v_bumped,
        'content_version', v_po.content_version,
        'content_changed', v_changed,
        'updated_at', v_po.updated_at);
END
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_settle_versions(uuid, boolean) IS
  'End of every PO writer, with the header already locked: bumps revision once per send cycle when allowed and the vendor-visible document no longer matches the sent revision''s hash; bumps content_version, and records the new content_hash, when the QuickBooks-pushed projection no longer hashes to the stored content_hash (the first settle of a new PO only records it). Returns {revision, sent_revision, revision_bumped, content_version, content_changed, updated_at}. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_settle_versions(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_settle_versions(uuid, boolean) TO service_role;


-- The result of a delivery, built from what is stored, so a replayed receipt_group_id
-- returns the first result again, identically, without writing anything. Balances are
-- current, not historical.
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_receipt_result(
    p_vendor_purchase_order_id uuid,
    p_receipt_group_id         uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT jsonb_build_object(
    'vendor_purchase_order_id', p_vendor_purchase_order_id,
    'receipt_group_id', p_receipt_group_id,
    'status', (SELECT s.status FROM public.vendor_purchase_order_status s
                WHERE s.id = p_vendor_purchase_order_id),
    'closed_line_ids', COALESCE((
        SELECT jsonb_agg(DISTINCT ls.id)
          FROM public.vendor_purchase_order_receipts r
          JOIN public.vendor_purchase_order_line_status ls ON ls.id = r.vendor_purchase_order_line_id
         WHERE r.receipt_group_id = p_receipt_group_id
           AND r.vendor_purchase_order_id = p_vendor_purchase_order_id
           AND ls.closed_at IS NOT NULL), '[]'::jsonb),
    'receipts', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'receipt_id',             r.id,
                 'entry_index',            r.entry_index,
                 'line_id',                r.vendor_purchase_order_line_id,
                 'line_number',            ls.line_number,
                 'line_kind',              r.line_kind,
                 'quantity',               r.quantity,
                 'unit',                   r.unit,
                 'stock_quantity',         r.stock_quantity,
                 'stock_unit',             r.stock_unit,
                 'part_id',                r.part_id,
                 'location_id',            r.location_id,
                 'location_name',          r.location_name,
                 'lot_id',                 r.lot_id,
                 'lot_code',               r.lot_code,
                 'heat_number',            r.heat_number,
                 'started_tracking',       r.started_tracking,
                 'transaction_id',         r.inventory_transaction_id,
                 'voided',                 r.voided_at IS NOT NULL,
                 'location_balance', CASE WHEN r.line_kind = 'part' THEN COALESCE((
                     SELECT pls.quantity FROM public.part_location_stock pls
                      WHERE pls.part_id = r.part_id AND pls.location_id = r.location_id
                        AND pls.lot_key = COALESCE(r.lot_id, '00000000-0000-0000-0000-000000000000'::uuid)), 0) END,
                 'part_quantity', (SELECT p.quantity FROM public.parts p WHERE p.id = r.part_id),
                 'line_status',            ls.status,
                 'over_received',          ls.over_received_quantity > 0,
                 'over_received_quantity', ls.over_received_quantity
               ) ORDER BY r.entry_index)
          FROM public.vendor_purchase_order_receipts r
          JOIN public.vendor_purchase_order_line_status ls ON ls.id = r.vendor_purchase_order_line_id
         WHERE r.receipt_group_id = p_receipt_group_id
           AND r.vendor_purchase_order_id = p_vendor_purchase_order_id), '[]'::jsonb));
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_receipt_result(uuid, uuid) IS
  'The jsonb receive_vendor_purchase_order returns, rebuilt from the stored receipts of one delivery (so a replay returns the first result again): status, closed_line_ids, and per receipt the typed quantity and unit, stock quantity, place, lot, heat, started_tracking, ledger transaction_id, current location balance and part quantity, the line''s status and over_received. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_receipt_result(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_receipt_result(uuid, uuid) TO service_role;


-- The approved-vendor row and its price sheet, upserted on (part, vendor): the unique key IS
-- identity, so saving an archived vendor again revives the same row. Shared by
-- save_part_vendor (manual sheets) and award_vendor_rfq (sheets saved from quotes).
CREATE OR REPLACE FUNCTION public.part_vendor_write(
    p_part_id      uuid,
    p_vendor_id    uuid,
    p_changes      jsonb,
    p_price_breaks jsonb,
    p_break_keys   text[])
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_changes  jsonb := COALESCE(p_changes, '{}'::jsonb);
    v_part     record;
    v_vendor   record;
    v_row      public.part_vendors%ROWTYPE;
    v_found    boolean;
    v_status   text;
    v_note     text;
    v_vpn      text;
    v_unit     text;
    v_lead     numeric;
    v_moq      numeric;
    v_quoted   date;
    v_valid    date;
    v_notes    text;
    v_break    jsonb;
    v_id       uuid;
    v_created  boolean := false;
    v_revived  boolean := false;
BEGIN
    PERFORM public.purchasing_assert_keys(v_changes,
        ARRAY['status', 'status_note', 'vendor_part_number', 'purchase_unit', 'lead_time_days',
              'minimum_order_quantity', 'quoted_on', 'valid_until', 'notes'],
        'the approved-vendor changes');

    SELECT p.id, p.company_id, p.part_name, p.primary_unit, p.deleted_at, p.preferred_vendor_id INTO v_part
      FROM public.parts p WHERE p.id = p_part_id;
    SELECT v.id, v.company_id, v.name, v.deleted_at INTO v_vendor
      FROM public.vendors v WHERE v.id = p_vendor_id;
    IF v_part.id IS NULL OR v_vendor.id IS NULL OR v_vendor.company_id <> v_part.company_id THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_row FROM public.part_vendors
     WHERE part_id = p_part_id AND vendor_id = p_vendor_id FOR UPDATE;
    v_found := FOUND;

    IF NOT v_found OR v_row.deleted_at IS NOT NULL THEN
        IF v_vendor.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived. Restore it before adding it to a part''s vendors.', v_vendor.name
                USING ERRCODE = 'P0001';
        END IF;
        IF v_part.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived.', v_part.part_name USING ERRCODE = 'P0001';
        END IF;
    END IF;

    v_status := COALESCE(v_row.status, 'approved');
    v_note   := v_row.status_note;
    v_vpn    := v_row.vendor_part_number;
    v_unit   := COALESCE(v_row.purchase_unit, v_part.primary_unit);
    v_lead   := v_row.lead_time_days;
    v_moq    := v_row.minimum_order_quantity;
    v_quoted := v_row.quoted_on;
    v_valid  := v_row.valid_until;
    v_notes  := v_row.notes;

    IF v_changes ? 'status'                 THEN v_status := v_changes->>'status'; END IF;
    IF v_changes ? 'status_note'            THEN v_note   := NULLIF(btrim(v_changes->>'status_note'), ''); END IF;
    IF v_changes ? 'vendor_part_number'     THEN v_vpn    := NULLIF(btrim(v_changes->>'vendor_part_number'), ''); END IF;
    IF v_changes ? 'purchase_unit'          THEN v_unit   := COALESCE(NULLIF(btrim(v_changes->>'purchase_unit'), ''), v_part.primary_unit); END IF;
    IF v_changes ? 'lead_time_days'         THEN v_lead   := NULLIF(v_changes->>'lead_time_days', '')::numeric; END IF;
    IF v_changes ? 'minimum_order_quantity' THEN v_moq    := NULLIF(v_changes->>'minimum_order_quantity', '')::numeric; END IF;
    IF v_changes ? 'quoted_on'              THEN v_quoted := NULLIF(v_changes->>'quoted_on', '')::date; END IF;
    IF v_changes ? 'valid_until'            THEN v_valid  := NULLIF(v_changes->>'valid_until', '')::date; END IF;
    IF v_changes ? 'notes'                  THEN v_notes  := NULLIF(btrim(v_changes->>'notes'), ''); END IF;

    IF v_status IS NULL OR v_status NOT IN ('approved', 'conditional', 'disapproved') THEN
        RAISE EXCEPTION 'A vendor''s status for a part is approved, conditional or disapproved (Do not use), not "%".',
            v_status USING ERRCODE = 'P0001';
    END IF;
    IF v_status = 'disapproved' AND v_part.preferred_vendor_id = p_vendor_id THEN
        RAISE EXCEPTION '% is the preferred vendor for %. Choose another preferred vendor before marking it Do not use.',
            v_vendor.name, v_part.part_name USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_note) > 1000 THEN
        RAISE EXCEPTION 'A status note can be at most 1,000 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_vpn) > 64 THEN
        RAISE EXCEPTION 'A vendor part number can be at most 64 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_unit) > 40 THEN
        RAISE EXCEPTION 'A unit name can be at most 40 characters.' USING ERRCODE = 'P0001';
    END IF;
    -- The sheet's unit must mean one amount of this part (the factor lives in
    -- parts_unit_conversions, never here). Raises the sentence when it does not.
    PERFORM public.part_unit_factor(p_part_id, v_unit);
    IF v_lead IS NOT NULL AND (v_lead <> trunc(v_lead) OR v_lead < 0 OR v_lead > 730) THEN
        RAISE EXCEPTION 'Lead time must be a whole number of days from 0 to 730.' USING ERRCODE = 'P0001';
    END IF;
    IF v_moq IS NOT NULL AND v_moq <= 0 THEN
        RAISE EXCEPTION 'A minimum order must be more than zero.' USING ERRCODE = 'P0001';
    END IF;
    IF v_quoted IS NOT NULL AND v_valid IS NOT NULL AND v_valid < v_quoted THEN
        RAISE EXCEPTION 'A price sheet can''t expire before the date it was quoted.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_notes) > 10000 THEN
        RAISE EXCEPTION 'Notes can be at most 10,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    IF v_found THEN
        v_revived := v_row.deleted_at IS NOT NULL;
        UPDATE public.part_vendors SET
            status = v_status, status_note = v_note, vendor_part_number = v_vpn,
            purchase_unit = v_unit, lead_time_days = v_lead::integer,
            minimum_order_quantity = v_moq, quoted_on = v_quoted, valid_until = v_valid,
            notes = v_notes, deleted_at = NULL
         WHERE id = v_row.id;
        v_id := v_row.id;
    ELSE
        INSERT INTO public.part_vendors (
            company_id, part_id, vendor_id, status, status_note, vendor_part_number,
            purchase_unit, lead_time_days, minimum_order_quantity, quoted_on, valid_until,
            notes, created_by
        ) VALUES (
            v_part.company_id, p_part_id, p_vendor_id, v_status, v_note, v_vpn,
            v_unit, v_lead::integer, v_moq, v_quoted, v_valid, v_notes, auth.uid()
        ) RETURNING id INTO v_id;
        v_created := true;
    END IF;

    -- A sheet, when given, replaces the whole sheet. Breaks are in the purchase unit.
    IF p_price_breaks IS NOT NULL AND p_price_breaks <> 'null'::jsonb THEN
        IF jsonb_typeof(p_price_breaks) <> 'array' THEN
            RAISE EXCEPTION 'p_price_breaks must be a JSON array' USING ERRCODE = 'XX000';
        END IF;
        FOR v_break IN SELECT e.value FROM jsonb_array_elements(p_price_breaks) e LOOP
            PERFORM public.purchasing_assert_keys(v_break, p_break_keys, 'a price break');
            IF NULLIF(v_break->>'min_quantity', '')::numeric IS NULL
               OR (v_break->>'min_quantity')::numeric <= 0 THEN
                RAISE EXCEPTION 'Each price break needs a quantity greater than zero.' USING ERRCODE = 'P0001';
            END IF;
            IF NULLIF(v_break->>'unit_price', '')::numeric IS NULL
               OR (v_break->>'unit_price')::numeric <= 0 THEN
                RAISE EXCEPTION 'Each price break needs a price greater than zero.' USING ERRCODE = 'P0001';
            END IF;
            IF (v_break->>'unit_price')::numeric >= 100000000000 THEN
                RAISE EXCEPTION 'That price is too large.' USING ERRCODE = 'P0001';
            END IF;
        END LOOP;
        IF (SELECT count(*) FROM jsonb_array_elements(p_price_breaks))
           <> (SELECT count(DISTINCT (e.value->>'min_quantity')::numeric) FROM jsonb_array_elements(p_price_breaks) e) THEN
            RAISE EXCEPTION 'Two price breaks can''t start at the same quantity.' USING ERRCODE = 'P0001';
        END IF;

        DELETE FROM public.part_vendor_price_breaks WHERE part_vendor_id = v_id;
        INSERT INTO public.part_vendor_price_breaks (
            company_id, part_vendor_id, min_quantity, unit_price, source, vendor_rfq_response_id)
        SELECT v_part.company_id, v_id, (e.value->>'min_quantity')::numeric, (e.value->>'unit_price')::numeric,
               COALESCE(NULLIF(e.value->>'source', ''), 'manual'),
               NULLIF(e.value->>'vendor_rfq_response_id', '')::uuid
          FROM jsonb_array_elements(p_price_breaks) e;
    END IF;

    RETURN jsonb_build_object('part_vendor_id', v_id, 'created', v_created, 'revived', v_revived);
END
$fn$;

COMMENT ON FUNCTION public.part_vendor_write(uuid, uuid, jsonb, jsonb, text[]) IS
  'Upserts (and revives) the approved-vendor row for (part, vendor) and, when p_price_breaks is non-null, replaces its whole price sheet. Validates status, unit (stock unit or exactly one conversion), lead time, minimum order, sheet dates and break quantities; refuses Do not use on the preferred vendor. Returns {part_vendor_id, created, revived}. Internal: save_part_vendor and award_vendor_rfq call it after their preamble.';

REVOKE EXECUTE ON FUNCTION public.part_vendor_write(uuid, uuid, jsonb, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.part_vendor_write(uuid, uuid, jsonb, jsonb, text[]) TO service_role;


-- ============================================================================
-- 2. The approved vendor list
-- ============================================================================
CREATE OR REPLACE FUNCTION public.save_part_vendor(
    p_part_id        uuid,
    p_vendor_id      uuid,
    p_changes        jsonb   DEFAULT '{}'::jsonb,
    p_price_breaks   jsonb   DEFAULT NULL,
    p_make_preferred boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company   uuid;
    v_result    jsonb;
    v_preferred uuid;
BEGIN
    SELECT p.company_id INTO v_company FROM public.parts p WHERE p.id = p_part_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    -- One writer per part at a time: the list and the preferred marker change together.
    PERFORM 1 FROM public.parts p WHERE p.id = p_part_id FOR NO KEY UPDATE;

    v_result := public.part_vendor_write(p_part_id, p_vendor_id, p_changes, p_price_breaks,
                                         ARRAY['min_quantity', 'unit_price']);

    IF COALESCE(p_make_preferred, false) THEN
        -- ensure_preferred_vendor_is_listed refuses a Do not use vendor.
        UPDATE public.parts SET preferred_vendor_id = p_vendor_id
         WHERE id = p_part_id AND preferred_vendor_id IS DISTINCT FROM p_vendor_id;
    END IF;

    SELECT p.preferred_vendor_id INTO v_preferred FROM public.parts p WHERE p.id = p_part_id;
    RETURN v_result || jsonb_build_object('preferred', v_preferred IS NOT DISTINCT FROM p_vendor_id);
END
$fn$;

COMMENT ON FUNCTION public.save_part_vendor(uuid, uuid, jsonb, jsonb, boolean) IS
  'Adds, edits or revives a part''s approved vendor (the (part, vendor) pair is identity) and, when p_price_breaks is non-null, replaces its whole price sheet ([{min_quantity, unit_price}] in the purchase unit). p_changes keys: status, status_note, vendor_part_number, purchase_unit, lead_time_days, minimum_order_quantity, quoted_on, valid_until, notes. p_make_preferred also sets parts.preferred_vendor_id. Office users only; returns {part_vendor_id, created, revived, preferred}.';

REVOKE EXECUTE ON FUNCTION public.save_part_vendor(uuid, uuid, jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.save_part_vendor(uuid, uuid, jsonb, jsonb, boolean) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.archive_part_vendor(p_part_vendor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company uuid;
    v_part    uuid;
    v_row     public.part_vendors%ROWTYPE;
    v_cleared integer := 0;
BEGIN
    SELECT pv.company_id, pv.part_id INTO v_company, v_part
      FROM public.part_vendors pv WHERE pv.id = p_part_vendor_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM public.parts p WHERE p.id = v_part FOR NO KEY UPDATE;
    SELECT * INTO v_row FROM public.part_vendors WHERE id = p_part_vendor_id FOR UPDATE;

    IF v_row.deleted_at IS NOT NULL THEN
        RETURN jsonb_build_object('part_vendor_id', v_row.id, 'archived', false, 'cleared_preferred', false);
    END IF;

    UPDATE public.part_vendors SET deleted_at = now() WHERE id = v_row.id;
    -- Archiving the preferred row clears the preference, so the invariant holds at rest.
    UPDATE public.parts SET preferred_vendor_id = NULL
     WHERE id = v_row.part_id AND preferred_vendor_id = v_row.vendor_id;
    GET DIAGNOSTICS v_cleared = ROW_COUNT;

    RETURN jsonb_build_object('part_vendor_id', v_row.id, 'archived', true, 'cleared_preferred', v_cleared > 0);
END
$fn$;

COMMENT ON FUNCTION public.archive_part_vendor(uuid) IS
  'Archives an approved-vendor row (deleted_at; the sheet is kept, and saving the vendor again revives the same row). Clears parts.preferred_vendor_id when it was this vendor. Idempotent: a second call returns archived false. Office users only.';

REVOKE EXECUTE ON FUNCTION public.archive_part_vendor(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.archive_part_vendor(uuid) TO authenticated, service_role;


-- ============================================================================
-- 3. Purchase orders: create, save, state, line state
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_vendor_purchase_order(
    p_vendor_id  uuid,
    p_ordered_on date,
    p_today      date,
    p_header     jsonb DEFAULT '{}'::jsonb,
    p_lines      jsonb DEFAULT '[]'::jsonb)
RETURNS TABLE(id uuid, po_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
#variable_conflict use_column
DECLARE
    v_company uuid;
    v_id      uuid;
    v_number  text;
BEGIN
    SELECT v.company_id INTO v_company FROM public.vendors v WHERE v.id = p_vendor_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_insert)' USING ERRCODE = '42501';
    END IF;
    IF p_today IS NULL THEN
        RAISE EXCEPTION 'p_today is required: pass the caller''s local date.' USING ERRCODE = 'XX000';
    END IF;
    IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN
        RAISE EXCEPTION 'p_lines must be a JSON array' USING ERRCODE = 'XX000';
    END IF;

    v_id := public.vendor_purchase_order_insert(v_company, p_vendor_id, p_ordered_on,
                                                COALESCE(p_header, '{}'::jsonb), NULL);
    PERFORM 1 FROM public.vendor_purchase_orders h WHERE h.id = v_id FOR UPDATE;
    PERFORM public.vendor_purchase_order_lock_jobs(v_id, COALESCE(p_lines, '[]'::jsonb));
    PERFORM public.vendor_purchase_order_write_lines(v_id, COALESCE(p_lines, '[]'::jsonb));
    -- Records the first content_hash; a new PO starts at content_version 0.
    PERFORM public.vendor_purchase_order_settle_versions(v_id, false);

    SELECT h.po_number INTO v_number FROM public.vendor_purchase_orders h WHERE h.id = v_id;
    RETURN QUERY SELECT v_id, v_number;
END
$fn$;

COMMENT ON FUNCTION public.create_vendor_purchase_order(uuid, date, date, jsonb, jsonb) IS
  'Creates a DRAFT purchase order to a vendor. The company is derived from the live vendor. p_ordered_on is the caller''s local date; p_today is required. p_header keys: vendor_contact_id (default: the sales contact, else the primary), vendor_address_id (default: the default address), ship_to {kind shop|vendor|customer, vendor_id, vendor_address_id, customer_id, customer_address_id}, need_by_on, payment_terms (default: the vendor''s standing terms), ship_via, notes_to_vendor, internal_notes. p_lines: line objects without "id" (see save_vendor_purchase_order). The number is minted here and terms & conditions copied from the series. Returns (id, po_number).';

REVOKE EXECUTE ON FUNCTION public.create_vendor_purchase_order(uuid, date, date, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_vendor_purchase_order(uuid, date, date, jsonb, jsonb) TO authenticated, service_role;


-- PATCH semantics: a key that is absent does not change. New lines carry no "id"; existing
-- lines carry their id and only the keys that change.
CREATE OR REPLACE FUNCTION public.save_vendor_purchase_order(
    p_id                  uuid,
    p_changes             jsonb  DEFAULT '{}'::jsonb,
    p_lines               jsonb  DEFAULT '[]'::jsonb,
    p_removed_line_ids    uuid[] DEFAULT '{}'::uuid[],
    p_expected_updated_at text   DEFAULT NULL,
    p_today               date   DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company    uuid;
    v_po         public.vendor_purchase_orders%ROWTYPE;
    v_changes    jsonb  := COALESCE(p_changes, '{}'::jsonb);
    v_lines      jsonb  := COALESCE(p_lines, '[]'::jsonb);
    v_removed    uuid[] := ARRAY(SELECT DISTINCT r FROM unnest(COALESCE(p_removed_line_ids, '{}'::uuid[])) r
                                  WHERE r IS NOT NULL);
    v_restricted boolean;
    v_visible    boolean;
    v_vendor     record;
    v_party      jsonb;
    v_ship       jsonb;
    v_rm         record;
    v_unlinked   uuid[] := '{}';
    v_more       uuid[];
    v_written    jsonb;
    v_versions   jsonb;
    v_text       text;
BEGIN
    SELECT h.company_id INTO v_company FROM public.vendor_purchase_orders h WHERE h.id = p_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = p_id FOR UPDATE;

    IF p_today IS NULL THEN
        RAISE EXCEPTION 'p_today is required: pass the caller''s local date.' USING ERRCODE = 'XX000';
    END IF;
    PERFORM public.purchasing_assert_keys(v_changes,
        ARRAY['vendor_id', 'vendor_contact_id', 'vendor_address_id', 'ship_to', 'ordered_on',
              'need_by_on', 'payment_terms', 'ship_via', 'notes_to_vendor', 'internal_notes'],
        'the purchase order changes');
    IF jsonb_typeof(v_lines) <> 'array' THEN
        RAISE EXCEPTION 'p_lines must be a JSON array' USING ERRCODE = 'XX000';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) e WHERE jsonb_typeof(e.value) <> 'object') THEN
        RAISE EXCEPTION 'Every element of p_lines must be a JSON object' USING ERRCODE = 'XX000';
    END IF;

    -- What kind of save is this? Internal notes and promised dates are allowed on a closed or
    -- archived PO and never meet the staleness check; everything else is "restricted", and
    -- what the vendor would see is "visible".
    v_restricted := EXISTS (SELECT 1 FROM jsonb_object_keys(v_changes) k WHERE k <> 'internal_notes')
        OR cardinality(v_removed) > 0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) e
                    WHERE NOT (e.value ? 'id')
                       OR EXISTS (SELECT 1 FROM jsonb_object_keys(e.value) k
                                   WHERE k NOT IN ('id', 'promised_on')));
    v_visible := EXISTS (SELECT 1 FROM jsonb_object_keys(v_changes) k WHERE k <> 'internal_notes')
        OR cardinality(v_removed) > 0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) e
                    WHERE NOT (e.value ? 'id')
                       OR EXISTS (SELECT 1 FROM jsonb_object_keys(e.value) k
                                   WHERE k NOT IN ('id', 'promised_on', 'price_source', 'expects_receipt')));

    IF v_restricted AND v_po.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived, so only its internal notes and promised dates can change.', v_po.po_number
            USING ERRCODE = 'P0001';
    END IF;
    IF v_restricted AND v_po.closed_at IS NOT NULL THEN
        RAISE EXCEPTION '% is closed. Reopen it to change what the vendor sees; internal notes and promised dates can still change.',
            v_po.po_number USING ERRCODE = 'P0001';
    END IF;
    IF v_visible AND p_expected_updated_at IS NOT NULL
       AND p_expected_updated_at::timestamptz IS DISTINCT FROM v_po.updated_at THEN
        RAISE EXCEPTION '% was changed by someone else since you opened it. Reload it and make your change again.',
            v_po.po_number USING ERRCODE = 'P0001';
    END IF;

    PERFORM public.vendor_purchase_order_lock_jobs(p_id, v_lines);

    -- ---- the vendor (decides what the contact, address and part lines are checked against)
    IF v_changes ? 'vendor_id' AND NULLIF(v_changes->>'vendor_id', '')::uuid IS DISTINCT FROM v_po.vendor_id THEN
        IF v_po.issued_at IS NOT NULL THEN
            RAISE EXCEPTION '% has been sent to %, so its vendor is fixed. Close it and duplicate it to order from another vendor.',
                v_po.po_number, v_po.vendor_name USING ERRCODE = 'P0001';
        END IF;
        IF EXISTS (SELECT 1 FROM public.vendor_purchase_order_lines l
                    WHERE l.vendor_purchase_order_id = p_id AND l.line_kind = 'outside_service') THEN
            RAISE EXCEPTION 'Remove the outside-service lines first: they are steps % does.', v_po.vendor_name
                USING ERRCODE = 'P0001';
        END IF;
        SELECT v.id, v.company_id, v.name, v.deleted_at INTO v_vendor
          FROM public.vendors v WHERE v.id = NULLIF(v_changes->>'vendor_id', '')::uuid;
        IF NOT FOUND OR v_vendor.company_id <> v_company THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        IF v_vendor.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived. Restore it before ordering from it.', v_vendor.name USING ERRCODE = 'P0001';
        END IF;
        SELECT p.part_name INTO v_text
          FROM public.vendor_purchase_order_lines l
          JOIN public.part_vendors pv ON pv.part_id = l.part_id AND pv.vendor_id = v_vendor.id
                                     AND pv.deleted_at IS NULL AND pv.status = 'disapproved'
          JOIN public.parts p ON p.id = l.part_id
         WHERE l.vendor_purchase_order_id = p_id AND l.line_kind = 'part'
         LIMIT 1;
        IF v_text IS NOT NULL THEN
            RAISE EXCEPTION '% is marked Do not use for %.', v_vendor.name, v_text USING ERRCODE = 'P0001';
        END IF;
        -- A new vendor brings its own default contact and address unless this save names them.
        v_party := public.vendor_purchase_order_vendor_party(v_vendor.id, v_changes);
        UPDATE public.vendor_purchase_orders SET
            vendor_id = v_vendor.id, vendor_name = v_vendor.name,
            vendor_contact_id = (v_party->>'vendor_contact_id')::uuid,
            vendor_contact = NULLIF(v_party->'vendor_contact', 'null'::jsonb),
            vendor_address_id = (v_party->>'vendor_address_id')::uuid,
            vendor_address = NULLIF(v_party->'vendor_address', 'null'::jsonb)
         WHERE id = p_id;
        SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = p_id;
    ELSIF v_changes ? 'vendor_contact_id' OR v_changes ? 'vendor_address_id' THEN
        -- An id in the payload is an explicit refresh of that snapshot.
        v_party := public.vendor_purchase_order_vendor_party(
            v_po.vendor_id, v_changes - 'vendor_id');
        UPDATE public.vendor_purchase_orders SET
            vendor_contact_id = CASE WHEN v_changes ? 'vendor_contact_id'
                                     THEN (v_party->>'vendor_contact_id')::uuid ELSE vendor_contact_id END,
            vendor_contact    = CASE WHEN v_changes ? 'vendor_contact_id'
                                     THEN NULLIF(v_party->'vendor_contact', 'null'::jsonb) ELSE vendor_contact END,
            vendor_address_id = CASE WHEN v_changes ? 'vendor_address_id'
                                     THEN (v_party->>'vendor_address_id')::uuid ELSE vendor_address_id END,
            vendor_address    = CASE WHEN v_changes ? 'vendor_address_id'
                                     THEN NULLIF(v_party->'vendor_address', 'null'::jsonb) ELSE vendor_address END
         WHERE id = p_id;
    END IF;

    IF v_changes ? 'ship_to' THEN
        v_ship := public.vendor_purchase_order_resolve_ship_to(v_company, v_changes->'ship_to');
        UPDATE public.vendor_purchase_orders SET
            ship_to_kind = v_ship->>'kind',
            ship_to_vendor_id = (v_ship->>'vendor_id')::uuid,
            ship_to_vendor_address_id = (v_ship->>'vendor_address_id')::uuid,
            ship_to_customer_id = (v_ship->>'customer_id')::uuid,
            ship_to_customer_address_id = (v_ship->>'customer_address_id')::uuid,
            ship_to_name = v_ship->>'name',
            ship_to_address = NULLIF(v_ship->'address', 'null'::jsonb)
         WHERE id = p_id;
    END IF;

    IF v_changes ? 'ordered_on' THEN
        IF NULLIF(v_changes->>'ordered_on', '') IS NULL THEN
            RAISE EXCEPTION 'Give the order date.' USING ERRCODE = 'P0001';
        END IF;
        IF v_po.issued_at IS NOT NULL AND (v_changes->>'ordered_on')::date IS DISTINCT FROM v_po.ordered_on THEN
            RAISE EXCEPTION 'The order date is fixed once % has been sent.', v_po.po_number USING ERRCODE = 'P0001';
        END IF;
    END IF;
    IF char_length(NULLIF(btrim(v_changes->>'payment_terms'), '')) > 100 THEN
        RAISE EXCEPTION 'Payment terms can be at most 100 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(NULLIF(btrim(v_changes->>'ship_via'), '')) > 100 THEN
        RAISE EXCEPTION 'Ship via can be at most 100 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(NULLIF(btrim(v_changes->>'notes_to_vendor'), '')) > 10000
       OR char_length(NULLIF(btrim(v_changes->>'internal_notes'), '')) > 10000 THEN
        RAISE EXCEPTION 'Notes can be at most 10,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    IF v_changes ?| ARRAY['ordered_on', 'need_by_on', 'payment_terms', 'ship_via', 'notes_to_vendor',
                          'internal_notes'] THEN
        UPDATE public.vendor_purchase_orders SET
            ordered_on = CASE WHEN v_changes ? 'ordered_on' THEN (v_changes->>'ordered_on')::date ELSE ordered_on END,
            need_by_on = CASE WHEN v_changes ? 'need_by_on' THEN NULLIF(v_changes->>'need_by_on', '')::date ELSE need_by_on END,
            payment_terms = CASE WHEN v_changes ? 'payment_terms'
                                 THEN NULLIF(btrim(v_changes->>'payment_terms'), '') ELSE payment_terms END,
            ship_via = CASE WHEN v_changes ? 'ship_via' THEN NULLIF(btrim(v_changes->>'ship_via'), '') ELSE ship_via END,
            notes_to_vendor = CASE WHEN v_changes ? 'notes_to_vendor'
                                   THEN NULLIF(btrim(v_changes->>'notes_to_vendor'), '') ELSE notes_to_vendor END,
            internal_notes = CASE WHEN v_changes ? 'internal_notes'
                                  THEN NULLIF(btrim(v_changes->>'internal_notes'), '') ELSE internal_notes END
         WHERE id = p_id;
    END IF;

    -- ---- removed lines: only lines of THIS PO, and only lines nothing arrived on
    IF EXISTS (SELECT 1 FROM unnest(v_removed) r(id)
                WHERE NOT EXISTS (SELECT 1 FROM public.vendor_purchase_order_lines l
                                   WHERE l.id = r.id AND l.vendor_purchase_order_id = p_id)) THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;
    FOR v_rm IN
        SELECT l.id, l.line_number, l.line_kind FROM public.vendor_purchase_order_lines l
         WHERE l.vendor_purchase_order_id = p_id AND l.id = ANY (v_removed)
         ORDER BY l.line_number
    LOOP
        IF EXISTS (SELECT 1 FROM public.vendor_purchase_order_receipts r
                    WHERE r.vendor_purchase_order_line_id = v_rm.id) THEN
            RAISE EXCEPTION 'Line % has receipts, so it can''t be removed. Close it short instead.', v_rm.line_number
                USING ERRCODE = 'P0001';
        END IF;
        IF EXISTS (SELECT 1 FROM public.outside_shipment_receipts x
                     JOIN public.outside_shipments s ON s.id = x.outside_shipment_id
                    WHERE s.vendor_purchase_order_line_id = v_rm.id
                      AND s.voided_at IS NULL AND x.voided_at IS NULL) THEN
            RAISE EXCEPTION 'Line % has parts back from the vendor, so it can''t be removed. Close it instead.', v_rm.line_number
                USING ERRCODE = 'P0001';
        END IF;
        WITH u AS (
            UPDATE public.outside_shipments s SET vendor_purchase_order_line_id = NULL
             WHERE s.vendor_purchase_order_line_id = v_rm.id
            RETURNING s.id
        )
        SELECT COALESCE(array_agg(u.id), '{}'::uuid[]) INTO v_more FROM u;
        v_unlinked := v_unlinked || v_more;
        DELETE FROM public.vendor_purchase_order_lines WHERE id = v_rm.id;
    END LOOP;

    -- ---- added and changed lines
    v_written := public.vendor_purchase_order_write_lines(p_id, v_lines);

    -- Line-only edits still move the header's updated_at: it is the staleness token.
    IF v_visible THEN
        UPDATE public.vendor_purchase_orders SET updated_at = now() WHERE id = p_id;
    END IF;

    v_versions := public.vendor_purchase_order_settle_versions(p_id, true);

    RETURN jsonb_build_object(
        'id', p_id,
        'po_number', v_po.po_number,
        'status', (SELECT s.status FROM public.vendor_purchase_order_status s WHERE s.id = p_id),
        'line_ids', v_written->'line_ids',
        'linked_outside_shipment_ids', v_written->'linked_outside_shipment_ids',
        'unlinked_outside_shipment_ids', to_jsonb(v_unlinked)) || v_versions;
END
$fn$;

COMMENT ON FUNCTION public.save_vendor_purchase_order(uuid, jsonb, jsonb, uuid[], text, date) IS
  'Patch-saves a vendor PO. p_changes keys (absent = unchanged): vendor_id (drafts only, no outside lines), vendor_contact_id, vendor_address_id, ship_to, ordered_on (drafts only), need_by_on, payment_terms, ship_via, notes_to_vendor, internal_notes. p_lines: new lines without "id" (line_kind part|outside_service|other plus part_id, job_operation_id, job_id, job_part_id, work_center_id, description, vendor_part_number, quantity, unit, unit_price, price_source, need_by_on, promised_on, cert_required, expects_receipt) and existing lines with their "id" and only the changed keys (an existing line''s line_kind and job_operation_id are fixed: a change is refused, a repeat of the same value is not). p_removed_line_ids must be lines of this PO with no receipts. p_expected_updated_at (the updated_at string as read, passed through unchanged) is checked only when vendor-visible fields change. After a send, the first vendor-visible change bumps the revision once per send cycle; content_version moves when a QuickBooks-pushed field moves. A closed or archived PO takes only internal_notes and promised_on. Returns {id, po_number, status, revision, sent_revision, revision_bumped, content_version, content_changed, updated_at, line_ids, linked_outside_shipment_ids, unlinked_outside_shipment_ids}.';

REVOKE EXECUTE ON FUNCTION public.save_vendor_purchase_order(uuid, jsonb, jsonb, uuid[], text, date) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.save_vendor_purchase_order(uuid, jsonb, jsonb, uuid[], text, date) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.set_vendor_purchase_order_state(
    p_id     uuid,
    p_action text,
    p_reason text DEFAULT NULL,
    p_today  date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company    uuid;
    v_po         public.vendor_purchase_orders%ROWTYPE;
    v_reason     text := NULLIF(btrim(p_reason), '');
    v_doc        jsonb;
    v_conflict   record;
    v_unlinked   uuid[] := '{}';
    v_versions   jsonb;
BEGIN
    SELECT h.company_id INTO v_company FROM public.vendor_purchase_orders h WHERE h.id = p_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = p_id FOR UPDATE;

    IF p_action IS NULL OR p_action NOT IN ('mark_sent', 'close', 'reopen', 'archive') THEN
        RAISE EXCEPTION 'Unknown purchase order action %', p_action USING ERRCODE = 'XX000';
    END IF;
    IF char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION 'A reason can be at most 1,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    PERFORM public.vendor_purchase_order_lock_jobs(p_id, '[]'::jsonb);

    IF p_action = 'mark_sent' THEN
        IF v_po.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived, so it can''t be sent.', v_po.po_number USING ERRCODE = 'P0001';
        END IF;
        IF v_po.closed_at IS NOT NULL THEN
            RAISE EXCEPTION '% is closed. Reopen it before sending it again.', v_po.po_number USING ERRCODE = 'P0001';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.vendor_purchase_order_lines l WHERE l.vendor_purchase_order_id = p_id) THEN
            RAISE EXCEPTION 'Add at least one line before sending %.', v_po.po_number USING ERRCODE = 'P0001';
        END IF;
        v_doc := public.vendor_purchase_order_document(p_id);
        UPDATE public.vendor_purchase_orders SET
            issued_at     = COALESCE(issued_at, now()),
            issued_by     = CASE WHEN issued_at IS NULL THEN auth.uid() ELSE issued_by END,
            last_sent_at  = now(),
            sent_revision = revision
         WHERE id = p_id;
        -- Exactly what the vendor received at this revision. A re-send of the same revision
        -- keeps the first snapshot: nothing vendor-visible changed, or the revision would have.
        INSERT INTO public.vendor_purchase_order_revisions (
            company_id, vendor_purchase_order_id, revision, document, document_hash, sent_at, sent_by)
        VALUES (v_company, p_id, v_po.revision, v_doc, md5(v_doc::text), now(), auth.uid())
        ON CONFLICT (vendor_purchase_order_id, revision) DO NOTHING;

    ELSIF p_action = 'close' THEN
        IF v_po.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived.', v_po.po_number USING ERRCODE = 'P0001';
        END IF;
        IF v_po.issued_at IS NULL THEN
            RAISE EXCEPTION '% hasn''t been sent, so there is nothing to close. Archive it instead.', v_po.po_number
                USING ERRCODE = 'P0001';
        END IF;
        IF v_po.closed_at IS NOT NULL THEN
            RAISE EXCEPTION '% is already closed.', v_po.po_number USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.vendor_purchase_orders
           SET closed_at = now(), closed_by = auth.uid(), closed_reason = v_reason
         WHERE id = p_id;

    ELSIF p_action = 'reopen' THEN
        IF v_po.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived.', v_po.po_number USING ERRCODE = 'P0001';
        END IF;
        IF v_po.closed_at IS NULL THEN
            RAISE EXCEPTION '% isn''t closed.', v_po.po_number USING ERRCODE = 'P0001';
        END IF;
        -- Its open outside lines come back to life: still one open line per (step, vendor).
        SELECT mine.line_number AS my_line, oh.po_number, other.line_number, other.operation_label, other.job_number
          INTO v_conflict
          FROM public.vendor_purchase_order_lines mine
          JOIN public.vendor_purchase_order_lines other
            ON other.job_operation_id = mine.job_operation_id
           AND other.line_kind = 'outside_service' AND other.closed_at IS NULL AND other.id <> mine.id
          JOIN public.vendor_purchase_orders oh ON oh.id = other.vendor_purchase_order_id
         WHERE mine.vendor_purchase_order_id = p_id
           AND mine.line_kind = 'outside_service' AND mine.closed_at IS NULL
           AND oh.vendor_id = v_po.vendor_id AND oh.closed_at IS NULL AND oh.deleted_at IS NULL
           AND oh.id <> p_id
         LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION '% on % is open on % line % too. Close that line before reopening %.',
                v_conflict.operation_label, v_conflict.job_number, v_conflict.po_number,
                v_conflict.line_number, v_po.po_number USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.vendor_purchase_orders
           SET closed_at = NULL, closed_by = NULL, closed_reason = NULL
         WHERE id = p_id;

    ELSE  -- archive: never blocked; a second archive changes nothing
        IF v_po.deleted_at IS NULL THEN
            -- Its slips stop pointing at it: an archived PO drops out of lists, on-order and
            -- auto-linking, and a slip must not keep counting toward it.
            WITH u AS (
                UPDATE public.outside_shipments s SET vendor_purchase_order_line_id = NULL
                  FROM public.vendor_purchase_order_lines l
                 WHERE s.vendor_purchase_order_line_id = l.id AND l.vendor_purchase_order_id = p_id
                RETURNING s.id
            )
            SELECT COALESCE(array_agg(u.id), '{}'::uuid[]) INTO v_unlinked FROM u;
            UPDATE public.vendor_purchase_orders SET deleted_at = now() WHERE id = p_id;
        END IF;
    END IF;

    v_versions := public.vendor_purchase_order_settle_versions(p_id, false);

    RETURN jsonb_build_object(
        'id', p_id,
        'po_number', v_po.po_number,
        'action', p_action,
        'status', (SELECT s.status FROM public.vendor_purchase_order_status s WHERE s.id = p_id),
        'deleted_at', (SELECT h.deleted_at FROM public.vendor_purchase_orders h WHERE h.id = p_id),
        'unlinked_outside_shipment_ids', to_jsonb(v_unlinked)) || v_versions;
END
$fn$;

COMMENT ON FUNCTION public.set_vendor_purchase_order_state(uuid, text, text, date) IS
  'p_action mark_sent (needs a line; stamps issued_at once, last_sent_at and sent_revision = revision, and snapshots the vendor-visible document into vendor_purchase_order_revisions), close (a sent PO), reopen (a closed one; re-checks one open outside line per step and vendor) or archive (never blocked; unlinks its outside slips; idempotent). Office users only. Returns {id, po_number, action, status, deleted_at, unlinked_outside_shipment_ids, revision, sent_revision, content_version, ...}. p_today is accepted for a uniform call shape and unused.';

REVOKE EXECUTE ON FUNCTION public.set_vendor_purchase_order_state(uuid, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_vendor_purchase_order_state(uuid, text, text, date) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.set_vendor_purchase_order_line_state(
    p_id       uuid,
    p_line_ids uuid[],
    p_action   text,
    p_reason   text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company    uuid;
    v_po         public.vendor_purchase_orders%ROWTYPE;
    v_ids        uuid[] := ARRAY(SELECT DISTINCT i FROM unnest(COALESCE(p_line_ids, '{}'::uuid[])) i
                                  WHERE i IS NOT NULL);
    v_reason     text := NULLIF(btrim(p_reason), '');
    v_ls         record;
    v_conflict   record;
    v_versions   jsonb;
BEGIN
    SELECT h.company_id INTO v_company FROM public.vendor_purchase_orders h WHERE h.id = p_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = p_id FOR UPDATE;

    IF p_action IS NULL OR p_action NOT IN ('close', 'reopen') THEN
        RAISE EXCEPTION 'Unknown line action %', p_action USING ERRCODE = 'XX000';
    END IF;
    IF cardinality(v_ids) = 0 THEN
        RAISE EXCEPTION 'Choose the lines to %.', p_action USING ERRCODE = 'P0001';
    END IF;
    -- Every id must be a line of THIS PO.
    IF EXISTS (SELECT 1 FROM unnest(v_ids) i(id)
                WHERE NOT EXISTS (SELECT 1 FROM public.vendor_purchase_order_lines l
                                   WHERE l.id = i.id AND l.vendor_purchase_order_id = p_id)) THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;
    IF v_po.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived.', v_po.po_number USING ERRCODE = 'P0001';
    END IF;
    IF v_po.issued_at IS NULL THEN
        RAISE EXCEPTION '% hasn''t been sent yet. Remove a draft''s lines instead of closing them.', v_po.po_number
            USING ERRCODE = 'P0001';
    END IF;
    IF v_po.closed_at IS NOT NULL THEN
        RAISE EXCEPTION '% is closed. Reopen it first.', v_po.po_number USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION 'A reason can be at most 1,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    PERFORM public.vendor_purchase_order_lock_jobs(p_id, '[]'::jsonb);

    IF p_action = 'close' THEN
        FOR v_ls IN
            SELECT ls.line_number, ls.closed_at, ls.expects_receipt, ls.status
              FROM public.vendor_purchase_order_line_status ls
             WHERE ls.id = ANY (v_ids) ORDER BY ls.line_number
        LOOP
            IF v_ls.closed_at IS NOT NULL THEN
                RAISE EXCEPTION 'Line % is already closed.', v_ls.line_number USING ERRCODE = 'P0001';
            END IF;
            IF NOT v_ls.expects_receipt THEN
                RAISE EXCEPTION 'Line % doesn''t expect a delivery, so there is nothing to close on it. Close the PO when it is done.',
                    v_ls.line_number USING ERRCODE = 'P0001';
            END IF;
            IF v_ls.status NOT IN ('open', 'partially_received') THEN
                RAISE EXCEPTION 'Line % has nothing left to receive.', v_ls.line_number USING ERRCODE = 'P0001';
            END IF;
        END LOOP;
        UPDATE public.vendor_purchase_order_lines
           SET closed_at = now(), closed_by = auth.uid(), closed_reason = v_reason
         WHERE id = ANY (v_ids);
    ELSE
        FOR v_ls IN
            SELECT l.line_number, l.closed_at FROM public.vendor_purchase_order_lines l
             WHERE l.id = ANY (v_ids) ORDER BY l.line_number
        LOOP
            IF v_ls.closed_at IS NULL THEN
                RAISE EXCEPTION 'Line % isn''t closed.', v_ls.line_number USING ERRCODE = 'P0001';
            END IF;
        END LOOP;
        -- Reopening an outside line re-checks one open line per (step, vendor): against every
        -- other open line, and within this batch.
        SELECT mine.line_number AS my_line, oh.po_number, other.line_number, mine.operation_label, mine.job_number
          INTO v_conflict
          FROM public.vendor_purchase_order_lines mine
          JOIN public.vendor_purchase_order_lines other
            ON other.job_operation_id = mine.job_operation_id
           AND other.line_kind = 'outside_service' AND other.id <> mine.id
           AND (other.closed_at IS NULL OR other.id = ANY (v_ids))
          JOIN public.vendor_purchase_orders oh ON oh.id = other.vendor_purchase_order_id
         WHERE mine.id = ANY (v_ids)
           AND mine.line_kind = 'outside_service'
           AND oh.vendor_id = v_po.vendor_id AND oh.closed_at IS NULL AND oh.deleted_at IS NULL
         LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION '% on % is open on % line % too, so line % can''t reopen.',
                v_conflict.operation_label, v_conflict.job_number, v_conflict.po_number,
                v_conflict.line_number, v_conflict.my_line USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.vendor_purchase_order_lines
           SET closed_at = NULL, closed_by = NULL, closed_reason = NULL
         WHERE id = ANY (v_ids);
    END IF;

    v_versions := public.vendor_purchase_order_settle_versions(p_id, false);

    RETURN jsonb_build_object(
        'id', p_id,
        'po_number', v_po.po_number,
        'action', p_action,
        'line_ids', to_jsonb(v_ids),
        'status', (SELECT s.status FROM public.vendor_purchase_order_status s WHERE s.id = p_id)) || v_versions;
END
$fn$;

COMMENT ON FUNCTION public.set_vendor_purchase_order_line_state(uuid, uuid[], text, text) IS
  'Closes short, or reopens, a batch of lines of ONE sent, open, unarchived PO, atomically. Close needs something still to receive on each line (a no-receipt line closes with the PO); reopen re-checks one open outside line per step and vendor. Every id must be a line of p_id. Office users only. Bumps content_version (QuickBooks closes lines too); never the revision.';

REVOKE EXECUTE ON FUNCTION public.set_vendor_purchase_order_line_state(uuid, uuid[], text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_vendor_purchase_order_line_state(uuid, uuid[], text, text) TO authenticated, service_role;


-- ============================================================================
-- 4. Receiving, and its void
-- ============================================================================
-- ONE DELIVERY, ONE CALL, ATOMIC. p_receipt_group_id is minted by the caller (the dialog on
-- open; MCP from the PO, lines, quantities and UTC day); a replay returns the first result
-- and writes nothing.
--
-- HEATS FIRST, PER PART. On an untracked part, a heat entry turns tracking on and moves the
-- part's lot-less balances into a PRE-TRACKING lot. Processed after a no-heat entry of the
-- same delivery, that would strand the no-heat receipt with a NULL lot it no longer matches
-- (and a receipt that can never be voided). Processed first, the no-heat entry lands on a
-- now-tracked part and gets its own minted lot.
CREATE OR REPLACE FUNCTION public.receive_vendor_purchase_order(
    p_id                  uuid,
    p_receipt_group_id    uuid,
    p_receipts            jsonb,
    p_received_at         timestamptz DEFAULT NULL,
    p_vendor_packing_slip text        DEFAULT NULL,
    p_notes               text        DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company     uuid;
    v_po          public.vendor_purchase_orders%ROWTYPE;
    v_received_at timestamptz := COALESCE(p_received_at, now());
    v_slip        text := NULLIF(btrim(p_vendor_packing_slip), '');
    v_note        text := NULLIF(btrim(p_notes), '');
    v_e           record;
    v_line        public.vendor_purchase_order_lines%ROWTYPE;
    v_qty         numeric;
    v_qunit       text;
    v_unit        text;
    v_stock_qty   numeric;
    v_loc         uuid;
    v_heat        text;
    v_lot_in      uuid;
    v_entry_note  text;
    v_lots_before uuid[];
    v_result      jsonb;
    v_lot         uuid;
    v_lot_code    text;
    v_lot_heat    text;
    v_close_ids   uuid[] := '{}';
BEGIN
    SELECT h.company_id INTO v_company FROM public.vendor_purchase_orders h WHERE h.id = p_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_insert)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = p_id FOR UPDATE;

    IF p_receipt_group_id IS NULL THEN
        RAISE EXCEPTION 'p_receipt_group_id is required: mint one per delivery.' USING ERRCODE = 'XX000';
    END IF;

    -- A replay: the same delivery again (a lost response, a second tab, an assistant retry).
    IF EXISTS (SELECT 1 FROM public.vendor_purchase_order_receipts r WHERE r.receipt_group_id = p_receipt_group_id) THEN
        IF EXISTS (SELECT 1 FROM public.vendor_purchase_order_receipts r
                    WHERE r.receipt_group_id = p_receipt_group_id AND r.vendor_purchase_order_id <> p_id) THEN
            RAISE EXCEPTION 'That delivery id was already used on another purchase order.' USING ERRCODE = 'P0001';
        END IF;
        RETURN public.vendor_purchase_order_receipt_result(p_id, p_receipt_group_id);
    END IF;

    IF v_po.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived, so nothing can be received against it.', v_po.po_number USING ERRCODE = 'P0001';
    END IF;
    IF v_po.issued_at IS NULL THEN
        RAISE EXCEPTION '% is still a draft. Mark it sent first, then receive against it.', v_po.po_number
            USING ERRCODE = 'P0001';
    END IF;
    IF v_po.closed_at IS NOT NULL THEN
        RAISE EXCEPTION '% is closed. Reopen it to receive more.', v_po.po_number USING ERRCODE = 'P0001';
    END IF;
    IF p_received_at IS NOT NULL AND p_received_at > now() + interval '1 day' THEN
        RAISE EXCEPTION 'The receive date can''t be in the future.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_slip) > 64 THEN
        RAISE EXCEPTION 'A packing slip number can be at most 64 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_note) > 2000 THEN
        RAISE EXCEPTION 'A note can be at most 2,000 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF p_receipts IS NULL OR jsonb_typeof(p_receipts) <> 'array' THEN
        RAISE EXCEPTION 'p_receipts must be a JSON array' USING ERRCODE = 'XX000';
    END IF;
    IF jsonb_array_length(p_receipts) = 0 THEN
        RAISE EXCEPTION 'Nothing to receive: enter a quantity on at least one line.' USING ERRCODE = 'P0001';
    END IF;

    -- ---- pass 1: every entry is checked before anything moves --------------------
    FOR v_e IN
        SELECT e.value AS entry, (e.ordinality - 1)::integer AS idx
          FROM jsonb_array_elements(p_receipts) WITH ORDINALITY e
    LOOP
        PERFORM public.purchasing_assert_keys(v_e.entry,
            ARRAY['line_id', 'quantity', 'quantity_unit', 'location_id', 'heat_number', 'lot_id',
                  'notes', 'close_remaining'],
            'a receipt entry');
        SELECT * INTO v_line FROM public.vendor_purchase_order_lines l
         WHERE l.id = NULLIF(v_e.entry->>'line_id', '')::uuid AND l.vendor_purchase_order_id = p_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        IF v_line.line_kind = 'outside_service' THEN
            RAISE EXCEPTION 'Outside work is received on its vendor packing slip, not on the purchase order (line %).',
                v_line.line_number USING ERRCODE = 'P0001';
        END IF;
        IF v_line.closed_at IS NOT NULL THEN
            RAISE EXCEPTION 'Line % is closed. Reopen it to receive against it.', v_line.line_number USING ERRCODE = 'P0001';
        END IF;
        IF NOT v_line.expects_receipt THEN
            RAISE EXCEPTION 'Line % doesn''t expect a delivery.', v_line.line_number USING ERRCODE = 'P0001';
        END IF;
        v_qty := NULLIF(v_e.entry->>'quantity', '')::numeric;
        IF v_qty IS NULL OR v_qty <= 0 THEN
            RAISE EXCEPTION 'Receive a quantity greater than zero on line %.', v_line.line_number USING ERRCODE = 'P0001';
        END IF;
        v_qunit := COALESCE(NULLIF(v_e.entry->>'quantity_unit', ''), 'purchase');
        IF v_qunit NOT IN ('purchase', 'stock') THEN
            RAISE EXCEPTION 'Unknown quantity_unit %', v_qunit USING ERRCODE = 'XX000';
        END IF;
        IF char_length(NULLIF(btrim(v_e.entry->>'notes'), '')) > 2000 THEN
            RAISE EXCEPTION 'A note can be at most 2,000 characters.' USING ERRCODE = 'P0001';
        END IF;

        IF v_line.line_kind = 'part' THEN
            v_loc := NULLIF(v_e.entry->>'location_id', '')::uuid;
            IF v_loc IS NULL THEN
                RAISE EXCEPTION 'Choose where line % goes.', v_line.line_number USING ERRCODE = 'P0001';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM public.inventory_locations il
                            WHERE il.id = v_loc AND il.company_id = v_company) THEN
                RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
            END IF;
            IF EXISTS (SELECT 1 FROM public.inventory_locations c WHERE c.parent_id = v_loc) THEN
                RAISE EXCEPTION '% holds other places. Choose a shelf or bin inside it for line %.',
                    public.inv_location_path_label(v_loc), v_line.line_number USING ERRCODE = 'P0001';
            END IF;
            v_heat := NULLIF(btrim(v_e.entry->>'heat_number'), '');
            v_lot_in := NULLIF(v_e.entry->>'lot_id', '')::uuid;
            IF v_heat IS NOT NULL AND v_lot_in IS NOT NULL THEN
                RAISE EXCEPTION 'Give line % a heat number or a lot, not both.', v_line.line_number USING ERRCODE = 'P0001';
            END IF;
            IF char_length(v_heat) > 64 THEN
                RAISE EXCEPTION 'A heat number can be at most 64 characters.' USING ERRCODE = 'P0001';
            END IF;
            IF v_lot_in IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.material_lots ml WHERE ml.id = v_lot_in AND ml.part_id = v_line.part_id) THEN
                RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
            END IF;
        ELSE
            IF v_qunit = 'stock' THEN
                RAISE EXCEPTION 'Line % isn''t stock, so it is received in %.', v_line.line_number, v_line.unit
                    USING ERRCODE = 'P0001';
            END IF;
            IF NULLIF(v_e.entry->>'location_id', '') IS NOT NULL
               OR NULLIF(btrim(v_e.entry->>'heat_number'), '') IS NOT NULL
               OR NULLIF(v_e.entry->>'lot_id', '') IS NOT NULL THEN
                RAISE EXCEPTION 'Line % isn''t stock, so it takes no place, heat or lot.', v_line.line_number
                    USING ERRCODE = 'P0001';
            END IF;
        END IF;
    END LOOP;

    -- ---- pass 2: per part, heats first; otherwise in the order given --------------
    FOR v_e IN
        SELECT e.value AS entry, (e.ordinality - 1)::integer AS idx
          FROM jsonb_array_elements(p_receipts) WITH ORDINALITY e
          JOIN public.vendor_purchase_order_lines l
            ON l.id = (e.value->>'line_id')::uuid AND l.vendor_purchase_order_id = p_id
         ORDER BY l.part_id NULLS LAST,
                  (NULLIF(btrim(COALESCE(e.value->>'heat_number', '')), '') IS NOT NULL) DESC,
                  e.ordinality
    LOOP
        SELECT * INTO v_line FROM public.vendor_purchase_order_lines l WHERE l.id = (v_e.entry->>'line_id')::uuid;
        v_qty        := (v_e.entry->>'quantity')::numeric;
        v_qunit      := COALESCE(NULLIF(v_e.entry->>'quantity_unit', ''), 'purchase');
        v_entry_note := COALESCE(NULLIF(btrim(v_e.entry->>'notes'), ''), v_note);

        IF v_line.line_kind = 'part' THEN
            -- Exactly as typed, in either unit; the stock quantity is exact.
            IF v_qunit = 'stock' THEN
                v_unit := v_line.stock_unit;
                v_stock_qty := v_qty;
            ELSE
                v_unit := v_line.unit;
                v_stock_qty := v_qty * v_line.stock_factor;
            END IF;
            v_loc    := (v_e.entry->>'location_id')::uuid;
            v_heat   := NULLIF(btrim(v_e.entry->>'heat_number'), '');
            v_lot_in := NULLIF(v_e.entry->>'lot_id', '')::uuid;

            SELECT COALESCE(array_agg(ml.id), '{}'::uuid[]) INTO v_lots_before
              FROM public.material_lots ml WHERE ml.part_id = v_line.part_id;

            v_result := public.add_stock_at_location(
                v_line.part_id, v_loc, v_qty, v_unit, v_stock_qty,
                p_notes => concat_ws(' · ',
                    format('Received on %s line %s', v_po.po_number, v_line.line_number),
                    'packing slip ' || v_slip,
                    v_entry_note),
                p_heat_number => v_heat,
                p_lot_id => v_lot_in);

            -- A lot this receipt created is stamped with where and when it came from. An
            -- existing lot (a heat seen before, or one picked) is left exactly as it was.
            v_lot := NULLIF(v_result->>'lot_id', '')::uuid;
            IF v_lot IS NOT NULL AND NOT (v_lot = ANY (v_lots_before)) THEN
                UPDATE public.material_lots
                   SET vendor_id = v_po.vendor_id, received_at = v_received_at
                 WHERE id = v_lot AND vendor_id IS NULL;
            END IF;
            v_lot_code := NULL; v_lot_heat := NULL;
            SELECT ml.lot_code, ml.heat_number INTO v_lot_code, v_lot_heat
              FROM public.material_lots ml WHERE ml.id = v_lot;

            INSERT INTO public.vendor_purchase_order_receipts (
                company_id, vendor_purchase_order_id, vendor_purchase_order_line_id, line_kind,
                receipt_group_id, entry_index, quantity, unit, stock_quantity, stock_unit,
                part_id, location_id, location_name, lot_id, lot_code, heat_number, started_tracking,
                inventory_transaction_id, vendor_packing_slip, notes, received_at, received_by
            ) VALUES (
                v_company, p_id, v_line.id, 'part',
                p_receipt_group_id, v_e.idx, v_qty, v_unit, v_stock_qty, v_line.stock_unit,
                v_line.part_id, v_loc, public.inv_location_path_label(v_loc), v_lot, v_lot_code, v_lot_heat,
                COALESCE((v_result->>'started_tracking')::boolean, false),
                NULLIF(v_result->>'transaction_id', '')::uuid, v_slip, v_entry_note, v_received_at, auth.uid()
            );
        ELSE
            INSERT INTO public.vendor_purchase_order_receipts (
                company_id, vendor_purchase_order_id, vendor_purchase_order_line_id, line_kind,
                receipt_group_id, entry_index, quantity, unit,
                vendor_packing_slip, notes, received_at, received_by
            ) VALUES (
                v_company, p_id, v_line.id, 'other',
                p_receipt_group_id, v_e.idx, v_qty, v_line.unit,
                v_slip, v_entry_note, v_received_at, auth.uid()
            );
        END IF;

        IF COALESCE((v_e.entry->>'close_remaining')::boolean, false) THEN
            v_close_ids := v_close_ids || v_line.id;
        END IF;
    END LOOP;

    -- "That's everything -- close the remaining N": only lines still short close.
    IF cardinality(v_close_ids) > 0 THEN
        UPDATE public.vendor_purchase_order_lines l
           SET closed_at = now(), closed_by = auth.uid(), closed_reason = 'Nothing more expected'
         WHERE l.id = ANY (v_close_ids)
           AND l.closed_at IS NULL
           AND EXISTS (SELECT 1 FROM public.vendor_purchase_order_line_status ls
                        WHERE ls.id = l.id AND ls.status IN ('open', 'partially_received'));
    END IF;

    -- An ordinary delivery changes nothing QuickBooks holds. content_version moves only when
    -- this one closed lines ("close the remaining"), or moved the PO's derived status into
    -- closed: the last of what was outstanding arrived while another line was closed short,
    -- and the push will close the QuickBooks PO.
    PERFORM public.vendor_purchase_order_settle_versions(p_id, false);
    RETURN public.vendor_purchase_order_receipt_result(p_id, p_receipt_group_id);
END
$fn$;

COMMENT ON FUNCTION public.receive_vendor_purchase_order(uuid, uuid, jsonb, timestamptz, text, text) IS
  'Receives one delivery against a SENT vendor PO, atomically and idempotently (a replayed p_receipt_group_id returns the first result and writes nothing). p_receipts: [{line_id, quantity, quantity_unit purchase|stock, location_id (part lines, a leaf), heat_number | lot_id, notes, close_remaining}]. Part entries go through add_stock_at_location (heats first per part), store exactly what was typed plus the exact stock quantity, stamp a newly created lot with the vendor and receipt date, and link the ledger row. Other lines record quantity only. Outside-service lines are refused: they are received on their vendor packing slips. Over-receipt is allowed and flagged. A draft is refused with "mark it sent first". content_version moves only when the delivery closes lines (close_remaining) or moves the PO into its derived closed status (nothing outstanding while a line was closed short); an ordinary delivery never moves it. Office users only.';

REVOKE EXECUTE ON FUNCTION public.receive_vendor_purchase_order(uuid, uuid, jsonb, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.receive_vendor_purchase_order(uuid, uuid, jsonb, timestamptz, text, text) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.void_vendor_purchase_order_receipt(
    p_receipt_id uuid,
    p_reason     text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company  uuid;
    v_po_id    uuid;
    v_po       public.vendor_purchase_orders%ROWTYPE;
    v_r        public.vendor_purchase_order_receipts%ROWTYPE;
    v_reason   text := NULLIF(btrim(p_reason), '');
    v_part     record;
    v_have     numeric;
    v_result   jsonb;
    v_txn      uuid;
    v_line_no  integer;
BEGIN
    SELECT r.company_id, r.vendor_purchase_order_id INTO v_company, v_po_id
      FROM public.vendor_purchase_order_receipts r WHERE r.id = p_receipt_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    -- The header first, like every other PO writer, then the receipt.
    SELECT * INTO v_po FROM public.vendor_purchase_orders WHERE id = v_po_id FOR UPDATE;
    SELECT * INTO v_r FROM public.vendor_purchase_order_receipts WHERE id = p_receipt_id FOR UPDATE;

    IF v_r.voided_at IS NOT NULL THEN
        RETURN jsonb_build_object('voided', false, 'receipt_id', v_r.id);
    END IF;
    IF char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION 'A reason can be at most 1,000 characters.' USING ERRCODE = 'P0001';
    END IF;
    SELECT l.line_number INTO v_line_no FROM public.vendor_purchase_order_lines l
     WHERE l.id = v_r.vendor_purchase_order_line_id;

    IF v_r.line_kind = 'part' THEN
        SELECT p.part_name, p.primary_unit, p.lot_tracked INTO v_part FROM public.parts p WHERE p.id = v_r.part_id;
        IF v_r.location_id IS NULL THEN
            RAISE EXCEPTION 'The place this was received into no longer exists. Correct the stock with a count instead.'
                USING ERRCODE = 'P0001';
        END IF;
        IF v_r.lot_id IS NULL AND v_part.lot_tracked THEN
            RAISE EXCEPTION '% started heat tracking after this receipt, so it can''t be reversed automatically. Correct the stock with a count instead.',
                v_part.part_name USING ERRCODE = 'P0001';
        END IF;
        SELECT pls.quantity INTO v_have FROM public.part_location_stock pls
         WHERE pls.part_id = v_r.part_id AND pls.location_id = v_r.location_id
           AND pls.lot_key = COALESCE(v_r.lot_id, '00000000-0000-0000-0000-000000000000'::uuid)
           FOR UPDATE;
        IF COALESCE(v_have, 0) < v_r.stock_quantity THEN
            RAISE EXCEPTION 'Only % of the % % received are still at %, so this receipt can''t be reversed. Correct the stock with a count instead.',
                trim_scale(COALESCE(v_have, 0)), trim_scale(v_r.stock_quantity), v_r.stock_unit,
                COALESCE(v_r.location_name, public.inv_location_path_label(v_r.location_id))
                USING ERRCODE = 'P0001';
        END IF;
        -- Through the stock engine, from the receipt's own lot. Never turns tracking off.
        v_result := public.deplete_stock_at_location(
            v_r.part_id, v_r.location_id, v_r.quantity, v_r.unit, v_r.stock_quantity,
            p_graceful => false,
            p_notes => concat_ws(' · ', format('Receipt voided: %s line %s', v_po.po_number, v_line_no), v_reason),
            p_lot_id => v_r.lot_id);
        v_txn := NULLIF(v_result->>'transaction_id', '')::uuid;
    END IF;

    UPDATE public.vendor_purchase_order_receipts
       SET voided_at = now(), voided_by = auth.uid(), void_reason = v_reason, void_transaction_id = v_txn
     WHERE id = v_r.id;

    -- Like a receipt: content_version moves only when the void moves the derived status out
    -- of closed (the voided delivery was what left nothing outstanding beside a line closed
    -- short), so the push reopens the QuickBooks PO.
    PERFORM public.vendor_purchase_order_settle_versions(v_po_id, false);

    RETURN jsonb_build_object(
        'voided', true,
        'receipt_id', v_r.id,
        'void_transaction_id', v_txn,
        'location_balance', v_result->'location_balance',
        'part_quantity', v_result->'part_quantity',
        'status', (SELECT s.status FROM public.vendor_purchase_order_status s WHERE s.id = v_po_id));
END
$fn$;

COMMENT ON FUNCTION public.void_vendor_purchase_order_receipt(uuid, text) IS
  'Voids one vendor PO receipt. A part receipt is reversed through deplete_stock_at_location from its own place and lot, linking void_transaction_id; refused (nothing changes) when the place is gone, when the part started heat tracking after a lot-less receipt, or when less than the received stock is still there. Never switches tracking off. Bumps content_version only when the void moves the PO out of its derived closed status. Idempotent: a second void returns voided false. Office users only.';

REVOKE EXECUTE ON FUNCTION public.void_vendor_purchase_order_receipt(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.void_vendor_purchase_order_receipt(uuid, text) TO authenticated, service_role;


-- ============================================================================
-- 5. A slip's PO line, by hand
-- ============================================================================
-- The rare correction: relink a vendor packing slip to a line, or unlink it (NULL). Office
-- only. Moving a slip moves what came back on it from one line's received figure to the
-- other's, which can move either PO into or out of its derived closed status, so BOTH POs
-- are locked and settled. The lock order is every PO writer's: the PO headers first (the one
-- the slip leaves and the one it joins, in id order), then the slip's job lock -- the same
-- lock create_outside_shipment and the PO writers take -- then the slip, FOR NO KEY UPDATE:
-- a receipt being recorded on this slip holds KEY SHARE on it (its foreign key) while its
-- trigger waits for a PO lock, and FOR UPDATE would wait on that receipt in turn.
CREATE OR REPLACE FUNCTION public.set_outside_shipment_vendor_purchase_order_line(
    p_outside_shipment_id           uuid,
    p_vendor_purchase_order_line_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company uuid;
    v_job     uuid;
    v_slip    public.outside_shipments%ROWTYPE;
    v_line    record;
    v_pos     uuid[];
    v_po      uuid;
BEGIN
    SELECT s.company_id, s.job_id INTO v_company, v_job
      FROM public.outside_shipments s WHERE s.id = p_outside_shipment_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;

    -- The PO the slip leaves and the PO it joins (a line of another company names none).
    v_pos := ARRAY(
        SELECT DISTINCT l.vendor_purchase_order_id
          FROM public.vendor_purchase_order_lines l
         WHERE l.company_id = v_company
           AND l.id IN (SELECT s.vendor_purchase_order_line_id FROM public.outside_shipments s
                         WHERE s.id = p_outside_shipment_id
                        UNION ALL
                        SELECT p_vendor_purchase_order_line_id)
         ORDER BY 1);
    PERFORM 1 FROM public.vendor_purchase_orders h WHERE h.id = ANY (v_pos) ORDER BY h.id FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtext('outside_shipment:' || v_job::text));
    SELECT * INTO v_slip FROM public.outside_shipments WHERE id = p_outside_shipment_id FOR NO KEY UPDATE;

    -- Every writer of the link holds the PO lock of the line it moves the slip off, or the job
    -- lock, so the link is fixed from here on. It moved only if a writer got in between the
    -- read above and these locks, and then the PO it moved to is not locked here.
    IF v_slip.vendor_purchase_order_line_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.vendor_purchase_order_lines l
         WHERE l.id = v_slip.vendor_purchase_order_line_id AND l.vendor_purchase_order_id = ANY (v_pos)) THEN
        RAISE EXCEPTION '% was just linked to another purchase order line. Reload it and try again.',
            v_slip.slip_number USING ERRCODE = 'P0001';
    END IF;

    IF v_slip.voided_at IS NOT NULL THEN
        RAISE EXCEPTION '% is void.', v_slip.slip_number USING ERRCODE = 'P0001';
    END IF;

    IF p_vendor_purchase_order_line_id IS NOT NULL THEN
        SELECT l.id, l.line_number, l.line_kind, l.job_operation_id, l.closed_at,
               h.po_number, h.vendor_id, h.vendor_name, h.closed_at AS po_closed_at, h.deleted_at AS po_deleted_at
          INTO v_line
          FROM public.vendor_purchase_order_lines l
          JOIN public.vendor_purchase_orders h ON h.id = l.vendor_purchase_order_id
         WHERE l.id = p_vendor_purchase_order_line_id AND l.company_id = v_company;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        IF v_line.line_kind <> 'outside_service' THEN
            RAISE EXCEPTION '% line % isn''t an outside-service line.', v_line.po_number, v_line.line_number
                USING ERRCODE = 'P0001';
        END IF;
        IF v_line.job_operation_id IS DISTINCT FROM v_slip.job_operation_id THEN
            RAISE EXCEPTION '% line % is for a different step than %.', v_line.po_number, v_line.line_number,
                v_slip.slip_number USING ERRCODE = 'P0001';
        END IF;
        IF v_line.vendor_id IS DISTINCT FROM v_slip.vendor_id THEN
            RAISE EXCEPTION '% is to %, but % went to %.', v_line.po_number, v_line.vendor_name,
                v_slip.slip_number, v_slip.vendor_name USING ERRCODE = 'P0001';
        END IF;
        IF v_line.po_deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived.', v_line.po_number USING ERRCODE = 'P0001';
        END IF;
        IF v_line.closed_at IS NOT NULL OR v_line.po_closed_at IS NOT NULL THEN
            RAISE EXCEPTION '% line % is closed. Reopen it first.', v_line.po_number, v_line.line_number
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    UPDATE public.outside_shipments
       SET vendor_purchase_order_line_id = p_vendor_purchase_order_line_id
     WHERE id = p_outside_shipment_id;

    FOREACH v_po IN ARRAY v_pos LOOP
        PERFORM public.vendor_purchase_order_settle_versions(v_po, false);
    END LOOP;

    RETURN jsonb_build_object(
        'outside_shipment_id', p_outside_shipment_id,
        'slip_number', v_slip.slip_number,
        'vendor_purchase_order_line_id', p_vendor_purchase_order_line_id);
END
$fn$;

COMMENT ON FUNCTION public.set_outside_shipment_vendor_purchase_order_line(uuid, uuid) IS
  'Relinks a live vendor packing slip to an outside-service line of an open, unarchived PO for the same step and vendor, or unlinks it (NULL). Office users only (operators send and receive, and the slip auto-links at send). Changes no operation, part or job status. Locks and settles both POs: a slip with parts back can move either one into or out of its derived closed status, which bumps its content_version.';

REVOKE EXECUTE ON FUNCTION public.set_outside_shipment_vendor_purchase_order_line(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_outside_shipment_vendor_purchase_order_line(uuid, uuid) TO authenticated, service_role;


-- ============================================================================
-- 5b. A receipt on a linked vendor packing slip settles its PO
-- ============================================================================
-- Outside work comes back on its vendor packing slip, and recording that is the browser's
-- plain INSERT into outside_shipment_receipts -- operators included, from the phone -- while
-- an undo is its column-scoped UPDATE of voided_at, and void_outside_shipment voids a slip's
-- receipts the same way. No purchasing RPC runs, yet the receipt that brings back the last
-- pieces of a PO's last open line while another line was closed short CLOSES the PO for the
-- push (its derived status), and voiding that receipt reopens it. So this trigger settles the
-- linked PO the way every PO writer ends: lock its header, then
-- vendor_purchase_order_settle_versions, which bumps content_version only when the pushed
-- projection no longer hashes to content_hash. An ordinary receipt moves nothing.
--
-- WHY IT IS SAFE BESIDE THE OPERATION -> PART -> JOB CASCADE (docs/modules/
-- outside-processing.md, "The trigger-depth trap"):
--   * It is a SIBLING of trigger_recompute_op_status_on_outside_receipt_*, fired by the same
--     receipt write at the same depth, not a link in that chain. It writes only
--     vendor_purchase_orders.content_version / content_hash, and that table's one trigger is
--     the BEFORE updated_at stamp, which writes nothing. The cascade's depth is untouched.
--   * Still no trigger on a purchasing table writes another table: this one sits on outside
--     processing's receipts and writes only the PO header, as ensure_preferred_vendor_is_listed
--     sits on parts and writes only part_vendors.
--   * AFTER, so the row has passed RLS, the billing gate and its foreign key first: it locks
--     and settles only a PO of the company the receipt was written for.
--   * Named to fire BEFORE the cascade (triggers fire in name order), so it waits for the PO
--     lock before the cascade has locked an operation, part or job row; and a PO writer
--     holding that lock waits on nothing a receipt holds (it takes KEY SHARE on job rows and
--     NO KEY UPDATE on slips, both compatible with the receipt's locks). FOR NO KEY UPDATE on
--     the header, so a QuickBooks link row being inserted for the PO (KEY SHARE) is not held up.
--   * After the lock it reads the slip's link again: the writer it waited for may have relinked
--     the slip, and the PO the receipt now counts toward is locked and settled too.
--   * A receipt with no good pieces changes no received figure, so the WHEN clauses skip it.
--     DELETE is not watched: the app voids receipts and never deletes one, and the only
--     deletes (with the company, or a demo reset after the POs are gone) leave no PO to settle.
-- SECURITY DEFINER because the browser has no write on vendor_purchase_orders. No
-- company_can_write of its own: the receipt write that fired it was gated, the
-- definer_writers_missing_write_gate() reasoning for every trigger on its list.
CREATE OR REPLACE FUNCTION public.outside_receipt_settles_vendor_purchase_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_slips  uuid[] := ARRAY[NEW.outside_shipment_id];
    v_locked uuid[] := '{}';
    v_pos    uuid[];
    v_po     uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        v_slips := v_slips || OLD.outside_shipment_id;
    END IF;

    LOOP
        v_pos := ARRAY(
            SELECT DISTINCT l.vendor_purchase_order_id
              FROM public.outside_shipments s
              JOIN public.vendor_purchase_order_lines l ON l.id = s.vendor_purchase_order_line_id
             WHERE s.id = ANY (v_slips)
               AND NOT (l.vendor_purchase_order_id = ANY (v_locked))
             ORDER BY 1);
        EXIT WHEN cardinality(v_pos) = 0;
        PERFORM 1 FROM public.vendor_purchase_orders h
          WHERE h.id = ANY (v_pos) ORDER BY h.id FOR NO KEY UPDATE;
        v_locked := v_locked || v_pos;
    END LOOP;

    FOREACH v_po IN ARRAY v_locked LOOP
        PERFORM public.vendor_purchase_order_settle_versions(v_po, false);
    END LOOP;
    RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION public.outside_receipt_settles_vendor_purchase_order() IS
  'AFTER trigger on outside_shipment_receipts: a receipt (or its void) on a vendor packing slip linked to a PO line locks that PO''s header and settles it (vendor_purchase_order_settle_versions), so content_version moves when the receipt moved the PO into or out of its derived closed status -- the status the QuickBooks push closes and reopens from -- and never for an ordinary receipt. Re-reads the link after the lock and settles a PO it was relinked to. Writes only vendor_purchase_orders.content_version / content_hash: a sibling of the operation -> part -> job cascade at the same trigger depth, never part of it.';

REVOKE EXECUTE ON FUNCTION public.outside_receipt_settles_vendor_purchase_order() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER outside_shipment_receipts_settle_vendor_po_ins
    AFTER INSERT ON public.outside_shipment_receipts
    FOR EACH ROW
    WHEN (NEW.quantity_good <> 0 AND NEW.voided_at IS NULL)
    EXECUTE FUNCTION public.outside_receipt_settles_vendor_purchase_order();

CREATE TRIGGER outside_shipment_receipts_settle_vendor_po_upd
    AFTER UPDATE OF quantity_good, voided_at, outside_shipment_id ON public.outside_shipment_receipts
    FOR EACH ROW
    WHEN ((OLD.quantity_good <> 0 OR NEW.quantity_good <> 0)
          AND (OLD.quantity_good IS DISTINCT FROM NEW.quantity_good
               OR OLD.voided_at IS DISTINCT FROM NEW.voided_at
               OR OLD.outside_shipment_id IS DISTINCT FROM NEW.outside_shipment_id))
    EXECUTE FUNCTION public.outside_receipt_settles_vendor_purchase_order();


-- ============================================================================
-- 6. create_outside_shipment -- the send links its PO line
-- ============================================================================
-- Rebuilt from its newest definition (20260905183520) WORD FOR WORD, plus the lookup of the
-- single eligible line and the column in the INSERT. The SAME 8-argument signature, so the
-- ACL (authenticated + service_role, never anon) and every caller are untouched -- the
-- operator page, OperationsPanel, outsideShipmentsAccess and MCP's send_outside. NO office
-- assertion: operators send.
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
    v_po_line_id uuid; v_po_line_count integer;
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

    -- ---- THE PURCHASE ORDER LINE IT SHIPS AGAINST (20261110043800) -------
    -- The single eligible outside-service line for this operation and vendor: on a
    -- live PO that is not closed (a DRAFT counts, so a slip sent before Mark as sent
    -- still links), the line itself not closed. At most one can exist -- the PO
    -- writers refuse a second open line per (operation, vendor) under this same
    -- advisory lock -- so there is nothing to choose and no argument to add (a 9th
    -- defaulted argument would be a second overload and break every send). A plain
    -- read: this takes no lock on a purchase order, so it cannot deadlock against a
    -- PO writer, which takes this job lock AFTER its own header lock and BEFORE it
    -- touches a line. No office check here, deliberately: operators send, and the
    -- link is bookkeeping, not consent.
    SELECT count(*), min(l.id::text)::uuid INTO v_po_line_count, v_po_line_id
      FROM public.vendor_purchase_order_lines l
      JOIN public.vendor_purchase_orders h ON h.id = l.vendor_purchase_order_id
     WHERE l.job_operation_id = p_job_operation_id
       AND l.line_kind = 'outside_service'
       AND l.closed_at IS NULL
       AND h.company_id = v_company_id
       AND h.vendor_id = v_vendor_id
       AND h.closed_at IS NULL
       AND h.deleted_at IS NULL;
    IF v_po_line_count <> 1 THEN
        v_po_line_id := NULL;
    END IF;

    INSERT INTO public.outside_shipments (
        company_id, job_id, job_part_id, job_operation_id,
        vendor_id, vendor_address_id, vendor_contact_id,
        vendor_name, service_name, ship_to_address, ship_to_contact,
        slip_number, quantity, shipped_at, due_back_on, carrier, notes, created_by,
        vendor_purchase_order_line_id
    ) VALUES (
        v_company_id, v_job_id, v_job_part_id, p_job_operation_id,
        v_vendor_id, v_address_id, v_contact_id,
        v_vendor_name, v_service_name,
        public.vendor_address_block_snapshot(v_address_id),
        public.vendor_contact_block_snapshot(v_contact_id),
        v_slip, p_quantity, COALESCE(p_shipped_at, now()), p_due_back_on,
        p_carrier, NULLIF(btrim(COALESCE(p_notes, '')), ''), v_user,
        v_po_line_id
    ) RETURNING id INTO v_id;
    -- The AFTER INSERT trigger derives status = 'sent' and mirrors sent_at/by.

    RETURN QUERY SELECT v_id, v_slip;
END $function$;

COMMENT ON FUNCTION public.create_outside_shipment(uuid, numeric, uuid, uuid, timestamptz, date, text, text) IS
  'THE send. Mints VPS-{jobBase}-{n} under a per-job advisory lock, freezes the vendor address/contact blocks, links the single open outside-service line of a live, open vendor PO for this operation and vendor (draft or sent) when there is one, and inserts one outside_shipments row; the AFTER INSERT trigger derives the operation status. company_id is derived from the operation, never passed, so a caller cannot name a tenant it does not own. Browser-callable by design and by operators: this is the only way an outside operation can be sent.';

-- The guard 20260905183520 wrote, widened: one overload, the browser can send and anon
-- cannot, the body still mints VPS- and now carries the link column.
DO $check$
DECLARE
    v_count integer;
    v_oid   oid;
    v_def   text;
BEGIN
    SELECT count(*), min(p.oid) INTO v_count, v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'create_outside_shipment';
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'create_outside_shipment must have exactly one overload (has %)', v_count;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated lost EXECUTE on create_outside_shipment -- nobody could send outside work';
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'anon must not execute create_outside_shipment';
    END IF;
    v_def := pg_get_functiondef(v_oid);
    IF v_def NOT LIKE '%''VPS-''%' THEN
        RAISE EXCEPTION 'create_outside_shipment does not mint VPS- after this migration';
    END IF;
    IF v_def NOT LIKE '%vendor_purchase_order_line_id%' THEN
        RAISE EXCEPTION 'create_outside_shipment does not link its purchase order line after this migration';
    END IF;
    IF v_def LIKE '%assert_office_member%' THEN
        RAISE EXCEPTION 'create_outside_shipment must not assert an office role: operators send';
    END IF;
END
$check$;
