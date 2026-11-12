-- ============================================================================
-- PURCHASING (4 of 5): RFQs, and the one explicit way a vendor price becomes a part cost
-- ============================================================================
-- Same preamble as migration 3 in every writer: derive the company (only create_vendor_rfq
-- takes p_company_id), assert_office_member, the literal company_can_write, lock the RFQ
-- header FOR UPDATE, scope every id in an array or jsonb to THIS RFQ, raise every CHECK as a
-- sentence. Unknown jsonb keys are XX000.
--
-- SOURCING IS EXPLICIT. A PO price is a frozen term of a document, never a cost record:
-- nothing in purchasing writes part_pricing_tiers except apply_part_cost_from_vendor, which
-- the user reaches only through "Use as part cost" after previewing exactly what changes.
-- ============================================================================


-- ============================================================================
-- 1. Internal helpers
-- ============================================================================

-- One RFQ line, inserted (no "id") or patched (an "id" of THIS RFQ). A part (live, with a
-- unit that means one amount of it) or ad-hoc text; one to four distinct quantities. Once
-- quoted, the part and unit are fixed and a quoted quantity cannot be dropped; once
-- awarded, the line is frozen.
CREATE OR REPLACE FUNCTION public.vendor_rfq_upsert_line(p_vendor_rfq_id uuid, p_line jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company     uuid;
    v_old         public.vendor_rfq_lines%ROWTYPE;
    v_new         boolean;
    v_label       text;
    v_part_id     uuid;
    v_part        record;
    v_part_name   text;
    v_desc        text;
    v_unit        text;
    v_qtys        numeric[];
    v_job_id      uuid;
    v_job         record;
    v_job_number  text;
    v_cert        boolean;
    v_notes       text;
    v_quoted      boolean := false;
    v_dropped     numeric;
    v_id          uuid;
    v_number      integer;
BEGIN
    PERFORM public.purchasing_assert_keys(p_line,
        ARRAY['id', 'part_id', 'description', 'unit', 'quantities', 'job_id', 'cert_required', 'notes'],
        'an RFQ line');
    SELECT r.company_id INTO v_company FROM public.vendor_rfqs r WHERE r.id = p_vendor_rfq_id;
    v_new := NOT (p_line ? 'id');

    IF v_new THEN
        v_label := 'The new line';
        v_cert  := false;
    ELSE
        SELECT * INTO v_old FROM public.vendor_rfq_lines
         WHERE id = NULLIF(p_line->>'id', '')::uuid AND vendor_rfq_id = p_vendor_rfq_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        v_label      := 'Line ' || v_old.line_number;
        v_part_id    := v_old.part_id;
        v_part_name  := v_old.part_name;
        v_desc       := v_old.description;
        v_unit       := v_old.unit;
        v_qtys       := v_old.quantities;
        v_job_id     := v_old.job_id;
        v_job_number := v_old.job_number;
        v_cert       := v_old.cert_required;
        v_notes      := v_old.notes;
        v_quoted     := EXISTS (SELECT 1 FROM public.vendor_rfq_responses x WHERE x.vendor_rfq_line_id = v_old.id);
        IF EXISTS (SELECT 1 FROM public.vendor_rfq_responses x
                    WHERE x.vendor_rfq_line_id = v_old.id AND x.awarded_at IS NOT NULL)
           AND EXISTS (SELECT 1 FROM jsonb_object_keys(p_line) k WHERE k <> 'id') THEN
            RAISE EXCEPTION '% has been awarded, so it can''t change.', v_label USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF p_line ? 'part_id'       THEN v_part_id := NULLIF(p_line->>'part_id', '')::uuid; END IF;
    IF p_line ? 'description'   THEN v_desc    := NULLIF(btrim(p_line->>'description'), ''); END IF;
    IF p_line ? 'unit'          THEN v_unit    := NULLIF(btrim(p_line->>'unit'), ''); END IF;
    IF p_line ? 'job_id'        THEN v_job_id  := NULLIF(p_line->>'job_id', '')::uuid; END IF;
    IF p_line ? 'cert_required' THEN v_cert    := COALESCE((p_line->>'cert_required')::boolean, false); END IF;
    IF p_line ? 'notes'         THEN v_notes   := NULLIF(btrim(p_line->>'notes'), ''); END IF;
    IF p_line ? 'quantities' THEN
        IF jsonb_typeof(p_line->'quantities') <> 'array' THEN
            RAISE EXCEPTION 'quantities must be a JSON array of numbers' USING ERRCODE = 'XX000';
        END IF;
        v_qtys := ARRAY(SELECT e::numeric FROM jsonb_array_elements_text(p_line->'quantities') e);
    END IF;

    IF v_qtys IS NULL OR cardinality(v_qtys) NOT BETWEEN 1 AND 4 THEN
        RAISE EXCEPTION '% needs one to four quantities to price.', v_label USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_qtys) q WHERE q IS NULL OR q <= 0) THEN
        RAISE EXCEPTION 'Quantities must be greater than zero.' USING ERRCODE = 'P0001';
    END IF;
    IF (SELECT count(DISTINCT q) FROM unnest(v_qtys) q) <> cardinality(v_qtys) THEN
        RAISE EXCEPTION 'Each quantity can be asked for once on a line.' USING ERRCODE = 'P0001';
    END IF;

    IF v_part_id IS NOT NULL THEN
        SELECT p.id, p.company_id, p.part_name, p.description, p.primary_unit, p.deleted_at INTO v_part
          FROM public.parts p WHERE p.id = v_part_id;
        IF NOT FOUND OR v_part.company_id <> v_company THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        IF v_new OR v_part_id IS DISTINCT FROM v_old.part_id THEN
            IF v_quoted THEN
                RAISE EXCEPTION '% has quotes, so its part can''t change.', v_label USING ERRCODE = 'P0001';
            END IF;
            IF v_part.deleted_at IS NOT NULL THEN
                RAISE EXCEPTION '% is archived.', v_part.part_name USING ERRCODE = 'P0001';
            END IF;
            IF NOT (p_line ? 'description') OR v_desc IS NULL THEN
                v_desc := COALESCE(NULLIF(btrim(v_part.description), ''), v_part.part_name);
            END IF;
            IF NOT (p_line ? 'unit') THEN
                v_unit := NULL;
            END IF;
        END IF;
        IF v_new OR p_line ? 'part_id' THEN
            v_part_name := v_part.part_name;
        END IF;
        IF v_unit IS NULL THEN
            v_unit := v_part.primary_unit;
        END IF;
        -- An award turns this into a PO line, which needs one factor for the unit.
        PERFORM public.part_unit_factor(v_part_id, v_unit);
    ELSE
        v_part_name := NULL;
        IF v_desc IS NULL THEN
            RAISE EXCEPTION '% needs a part or a description.', v_label USING ERRCODE = 'P0001';
        END IF;
        IF v_unit IS NULL THEN
            v_unit := 'each';
        END IF;
    END IF;

    IF NOT v_new AND v_quoted THEN
        IF v_part_id IS DISTINCT FROM v_old.part_id THEN
            RAISE EXCEPTION '% has quotes, so its part can''t change.', v_label USING ERRCODE = 'P0001';
        END IF;
        IF public.unit_name_key(v_unit) IS DISTINCT FROM public.unit_name_key(v_old.unit) THEN
            RAISE EXCEPTION '% has quotes priced per %, so its unit can''t change.', v_label, v_old.unit
                USING ERRCODE = 'P0001';
        END IF;
        SELECT min(x.quantity) INTO v_dropped FROM public.vendor_rfq_responses x
         WHERE x.vendor_rfq_line_id = v_old.id AND NOT (x.quantity = ANY (v_qtys));
        IF v_dropped IS NOT NULL THEN
            RAISE EXCEPTION '% has quotes at %, so that quantity can''t be removed.', v_label, trim_scale(v_dropped)
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF v_job_id IS NOT NULL THEN
        SELECT j.company_id, j.job_number, j.deleted_at INTO v_job FROM public.jobs j WHERE j.id = v_job_id;
        IF NOT FOUND OR v_job.company_id <> v_company THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        IF v_job.deleted_at IS NOT NULL AND (v_new OR v_job_id IS DISTINCT FROM v_old.job_id) THEN
            RAISE EXCEPTION '% is archived.', v_job.job_number USING ERRCODE = 'P0001';
        END IF;
        IF v_new OR p_line ? 'job_id' OR v_job_number IS NULL THEN
            v_job_number := v_job.job_number;
        END IF;
    ELSE
        v_job_number := NULL;
    END IF;

    IF char_length(v_desc) > 2000 THEN
        RAISE EXCEPTION 'A line description can be at most 2,000 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_unit) > 40 THEN
        RAISE EXCEPTION 'A unit name can be at most 40 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_notes) > 2000 THEN
        RAISE EXCEPTION 'Line notes can be at most 2,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    IF v_new THEN
        SELECT COALESCE(max(l.line_number), 0) + 1 INTO v_number
          FROM public.vendor_rfq_lines l WHERE l.vendor_rfq_id = p_vendor_rfq_id;
        INSERT INTO public.vendor_rfq_lines (
            company_id, vendor_rfq_id, line_number, part_id, part_name, description, unit,
            quantities, job_id, job_number, cert_required, notes)
        VALUES (
            v_company, p_vendor_rfq_id, v_number, v_part_id, v_part_name, v_desc, v_unit,
            v_qtys, v_job_id, v_job_number, v_cert, v_notes)
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.vendor_rfq_lines SET
            part_id = v_part_id, part_name = v_part_name, description = v_desc, unit = v_unit,
            quantities = v_qtys, job_id = v_job_id, job_number = v_job_number,
            cert_required = v_cert, notes = v_notes
         WHERE id = v_old.id;
        v_id := v_old.id;
    END IF;
    RETURN v_id;
END
$fn$;

COMMENT ON FUNCTION public.vendor_rfq_upsert_line(uuid, jsonb) IS
  'Inserts (no "id") or patches (an "id" of this RFQ) one RFQ line: a live part with a unit that has one factor, or ad-hoc text; one to four distinct quantities > 0; an optional live job. Once quoted the part and unit are fixed and a quoted quantity cannot be removed; once awarded the line is frozen. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_rfq_upsert_line(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_rfq_upsert_line(uuid, jsonb) TO service_role;


-- Invites a vendor (once per RFQ), freezing its sales contact, else its primary contact.
CREATE OR REPLACE FUNCTION public.vendor_rfq_invite(p_vendor_rfq_id uuid, p_vendor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company uuid;
    v_vendor  record;
    v_contact uuid;
    v_id      uuid;
BEGIN
    SELECT r.company_id INTO v_company FROM public.vendor_rfqs r WHERE r.id = p_vendor_rfq_id;
    SELECT v.id, v.company_id, v.name, v.deleted_at INTO v_vendor FROM public.vendors v WHERE v.id = p_vendor_id;
    IF NOT FOUND OR v_vendor.company_id <> v_company THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;

    SELECT i.id INTO v_id FROM public.vendor_rfq_invitations i
     WHERE i.vendor_rfq_id = p_vendor_rfq_id AND i.vendor_id = p_vendor_id;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;
    IF v_vendor.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived, so it can''t be asked to quote.', v_vendor.name USING ERRCODE = 'P0001';
    END IF;

    SELECT c.id INTO v_contact FROM public.vendor_contacts c
     WHERE c.vendor_id = p_vendor_id AND (c.role = 'sales' OR c.is_primary)
     ORDER BY (c.role = 'sales') DESC, c.is_primary DESC, c.created_at
     LIMIT 1;

    INSERT INTO public.vendor_rfq_invitations (
        company_id, vendor_rfq_id, vendor_id, vendor_name, vendor_contact_id, vendor_contact)
    VALUES (
        v_company, p_vendor_rfq_id, p_vendor_id, v_vendor.name, v_contact,
        public.vendor_contact_block_snapshot(v_contact))
    RETURNING id INTO v_id;
    RETURN v_id;
END
$fn$;

COMMENT ON FUNCTION public.vendor_rfq_invite(uuid, uuid) IS
  'Adds a live vendor of the RFQ''s company to an RFQ (idempotent per vendor), freezing its sales contact, else its primary contact. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_rfq_invite(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_rfq_invite(uuid, uuid) TO service_role;


-- ============================================================================
-- 2. RFQ writers
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_vendor_rfq(
    p_company_id uuid,
    p_header     jsonb  DEFAULT '{}'::jsonb,
    p_lines      jsonb  DEFAULT '[]'::jsonb,
    p_vendor_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS TABLE(id uuid, rfq_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
#variable_conflict use_column
DECLARE
    v_header   jsonb := COALESCE(p_header, '{}'::jsonb);
    v_lines    jsonb := COALESCE(p_lines, '[]'::jsonb);
    v_id       uuid;
    v_number   text;
    v_terms    text;
    v_name     text;
    v_line     jsonb;
    v_vendor   uuid;
    v_title    text;
    v_notes    text;
    v_internal text;
BEGIN
    PERFORM public.assert_office_member(p_company_id);
    IF NOT public.company_can_write(p_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_insert)' USING ERRCODE = '42501';
    END IF;
    PERFORM public.purchasing_assert_keys(v_header,
        ARRAY['title', 'needed_by_on', 'respond_by_on', 'notes_to_vendors', 'internal_notes'],
        'the RFQ header');
    IF jsonb_typeof(v_lines) <> 'array' THEN
        RAISE EXCEPTION 'p_lines must be a JSON array' USING ERRCODE = 'XX000';
    END IF;

    v_title    := NULLIF(btrim(v_header->>'title'), '');
    v_notes    := NULLIF(btrim(v_header->>'notes_to_vendors'), '');
    v_internal := NULLIF(btrim(v_header->>'internal_notes'), '');
    IF char_length(v_title) > 200 THEN
        RAISE EXCEPTION 'A title can be at most 200 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_notes) > 10000 OR char_length(v_internal) > 10000 THEN
        RAISE EXCEPTION 'Notes can be at most 10,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    v_number := public.next_purchasing_document_number(p_company_id, 'vendor_rfq');
    SELECT s.terms_and_conditions INTO v_terms FROM public.purchasing_document_series s
     WHERE s.company_id = p_company_id AND s.document_kind = 'vendor_rfq';
    SELECT c.name INTO v_name FROM public.companies c WHERE c.id = p_company_id;

    INSERT INTO public.vendor_rfqs (
        company_id, rfq_number, title, needed_by_on, respond_by_on, notes_to_vendors,
        internal_notes, terms_and_conditions, ship_to_name, ship_to_address, created_by)
    VALUES (
        p_company_id, v_number, v_title, NULLIF(v_header->>'needed_by_on', '')::date,
        NULLIF(v_header->>'respond_by_on', '')::date, v_notes, v_internal, v_terms,
        v_name, public.company_address_block_snapshot(p_company_id), auth.uid())
    RETURNING id INTO v_id;

    FOR v_line IN SELECT e.value FROM jsonb_array_elements(v_lines) WITH ORDINALITY e ORDER BY e.ordinality LOOP
        IF v_line ? 'id' THEN
            RAISE EXCEPTION 'A new RFQ''s lines carry no id' USING ERRCODE = 'XX000';
        END IF;
        PERFORM public.vendor_rfq_upsert_line(v_id, v_line);
    END LOOP;

    FOREACH v_vendor IN ARRAY ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_vendor_ids, '{}'::uuid[])) x
                                     WHERE x IS NOT NULL) LOOP
        PERFORM public.vendor_rfq_invite(v_id, v_vendor);
    END LOOP;

    RETURN QUERY SELECT v_id, v_number;
END
$fn$;

COMMENT ON FUNCTION public.create_vendor_rfq(uuid, jsonb, jsonb, uuid[]) IS
  'Creates a draft RFQ (fixed RFQ- series) with lines and invited vendors. p_header keys: title, needed_by_on, respond_by_on, notes_to_vendors, internal_notes. p_lines: [{part_id | description, unit, quantities (1-4), job_id, cert_required, notes}]. Each invitation freezes the vendor''s sales (else primary) contact. Terms & conditions come from the RFQ series; the ship-to is our shop. Office users only. Returns (id, rfq_number).';

REVOKE EXECUTE ON FUNCTION public.create_vendor_rfq(uuid, jsonb, jsonb, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_vendor_rfq(uuid, jsonb, jsonb, uuid[]) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.save_vendor_rfq(
    p_id                     uuid,
    p_changes                jsonb  DEFAULT '{}'::jsonb,
    p_lines                  jsonb  DEFAULT '[]'::jsonb,
    p_removed_line_ids       uuid[] DEFAULT '{}'::uuid[],
    p_add_vendor_ids         uuid[] DEFAULT '{}'::uuid[],
    p_removed_invitation_ids uuid[] DEFAULT '{}'::uuid[],
    p_expected_updated_at    text   DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company    uuid;
    v_rfq        public.vendor_rfqs%ROWTYPE;
    v_changes    jsonb  := COALESCE(p_changes, '{}'::jsonb);
    v_lines      jsonb  := COALESCE(p_lines, '[]'::jsonb);
    v_rm_lines   uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_removed_line_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
    v_add        uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_add_vendor_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
    v_rm_invites uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_removed_invitation_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
    v_restricted boolean;
    v_line       jsonb;
    v_ids        jsonb := '[]'::jsonb;
    v_invites    jsonb := '[]'::jsonb;
    v_vendor     uuid;
    v_text       text;
BEGIN
    SELECT r.company_id INTO v_company FROM public.vendor_rfqs r WHERE r.id = p_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_rfq FROM public.vendor_rfqs WHERE id = p_id FOR UPDATE;

    PERFORM public.purchasing_assert_keys(v_changes,
        ARRAY['title', 'needed_by_on', 'respond_by_on', 'notes_to_vendors', 'internal_notes',
              'terms_and_conditions'],
        'the RFQ changes');
    IF jsonb_typeof(v_lines) <> 'array' THEN
        RAISE EXCEPTION 'p_lines must be a JSON array' USING ERRCODE = 'XX000';
    END IF;

    v_restricted := EXISTS (SELECT 1 FROM jsonb_object_keys(v_changes) k WHERE k <> 'internal_notes')
        OR jsonb_array_length(v_lines) > 0 OR cardinality(v_rm_lines) > 0
        OR cardinality(v_add) > 0 OR cardinality(v_rm_invites) > 0;

    IF v_rfq.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived, so it can''t change.', v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;
    IF v_restricted AND v_rfq.closed_at IS NOT NULL THEN
        RAISE EXCEPTION '% is closed. Reopen it to change it.', v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;
    IF v_restricted AND p_expected_updated_at IS NOT NULL
       AND p_expected_updated_at::timestamptz IS DISTINCT FROM v_rfq.updated_at THEN
        RAISE EXCEPTION '% was changed by someone else since you opened it. Reload it and make your change again.',
            v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;

    v_text := NULLIF(btrim(v_changes->>'title'), '');
    IF char_length(v_text) > 200 THEN
        RAISE EXCEPTION 'A title can be at most 200 characters.' USING ERRCODE = 'P0001';
    END IF;
    IF char_length(NULLIF(btrim(v_changes->>'notes_to_vendors'), '')) > 10000
       OR char_length(NULLIF(btrim(v_changes->>'internal_notes'), '')) > 10000
       OR char_length(NULLIF(btrim(v_changes->>'terms_and_conditions'), '')) > 10000 THEN
        RAISE EXCEPTION 'Notes and terms can be at most 10,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.vendor_rfqs SET
        title = CASE WHEN v_changes ? 'title' THEN NULLIF(btrim(v_changes->>'title'), '') ELSE title END,
        needed_by_on = CASE WHEN v_changes ? 'needed_by_on' THEN NULLIF(v_changes->>'needed_by_on', '')::date ELSE needed_by_on END,
        respond_by_on = CASE WHEN v_changes ? 'respond_by_on' THEN NULLIF(v_changes->>'respond_by_on', '')::date ELSE respond_by_on END,
        notes_to_vendors = CASE WHEN v_changes ? 'notes_to_vendors'
                                THEN NULLIF(btrim(v_changes->>'notes_to_vendors'), '') ELSE notes_to_vendors END,
        internal_notes = CASE WHEN v_changes ? 'internal_notes'
                              THEN NULLIF(btrim(v_changes->>'internal_notes'), '') ELSE internal_notes END,
        terms_and_conditions = CASE WHEN v_changes ? 'terms_and_conditions'
                                    THEN NULLIF(btrim(v_changes->>'terms_and_conditions'), '')
                                    ELSE terms_and_conditions END,
        updated_at = now()
     WHERE id = p_id;

    -- Removed lines and invitations: only this RFQ's, and only ones nobody quoted.
    IF EXISTS (SELECT 1 FROM unnest(v_rm_lines) x(id)
                WHERE NOT EXISTS (SELECT 1 FROM public.vendor_rfq_lines l WHERE l.id = x.id AND l.vendor_rfq_id = p_id))
       OR EXISTS (SELECT 1 FROM unnest(v_rm_invites) x(id)
                   WHERE NOT EXISTS (SELECT 1 FROM public.vendor_rfq_invitations i
                                      WHERE i.id = x.id AND i.vendor_rfq_id = p_id)) THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;
    SELECT 'Line ' || l.line_number INTO v_text FROM public.vendor_rfq_lines l
     WHERE l.id = ANY (v_rm_lines)
       AND EXISTS (SELECT 1 FROM public.vendor_rfq_responses x WHERE x.vendor_rfq_line_id = l.id)
     ORDER BY l.line_number LIMIT 1;
    IF v_text IS NOT NULL THEN
        RAISE EXCEPTION '% has quotes, so it can''t be removed.', v_text USING ERRCODE = 'P0001';
    END IF;
    SELECT i.vendor_name INTO v_text FROM public.vendor_rfq_invitations i
     WHERE i.id = ANY (v_rm_invites)
       AND EXISTS (SELECT 1 FROM public.vendor_rfq_responses x WHERE x.vendor_rfq_invitation_id = i.id)
     LIMIT 1;
    IF v_text IS NOT NULL THEN
        RAISE EXCEPTION '% has quoted, so it can''t be taken off the RFQ.', v_text USING ERRCODE = 'P0001';
    END IF;
    DELETE FROM public.vendor_rfq_lines WHERE id = ANY (v_rm_lines) AND vendor_rfq_id = p_id;
    DELETE FROM public.vendor_rfq_invitations WHERE id = ANY (v_rm_invites) AND vendor_rfq_id = p_id;

    FOR v_line IN SELECT e.value FROM jsonb_array_elements(v_lines) WITH ORDINALITY e ORDER BY e.ordinality LOOP
        v_ids := v_ids || jsonb_build_array(public.vendor_rfq_upsert_line(p_id, v_line));
    END LOOP;

    FOREACH v_vendor IN ARRAY v_add LOOP
        v_invites := v_invites || jsonb_build_array(public.vendor_rfq_invite(p_id, v_vendor));
    END LOOP;

    RETURN jsonb_build_object(
        'id', p_id,
        'rfq_number', v_rfq.rfq_number,
        'status', (SELECT s.status FROM public.vendor_rfq_status s WHERE s.id = p_id),
        'line_ids', v_ids,
        'invitation_ids', v_invites,
        'updated_at', (SELECT r.updated_at FROM public.vendor_rfqs r WHERE r.id = p_id));
END
$fn$;

COMMENT ON FUNCTION public.save_vendor_rfq(uuid, jsonb, jsonb, uuid[], uuid[], uuid[], text) IS
  'Patch-saves an RFQ: p_changes (title, needed_by_on, respond_by_on, notes_to_vendors, internal_notes, terms_and_conditions), p_lines (new without "id", existing with their "id" and changed keys), removed lines and invitations (this RFQ''s, unquoted only), and vendors to invite. A closed RFQ takes only internal notes; an archived one nothing. p_expected_updated_at is the updated_at string as read. Office users only.';

REVOKE EXECUTE ON FUNCTION public.save_vendor_rfq(uuid, jsonb, jsonb, uuid[], uuid[], uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.save_vendor_rfq(uuid, jsonb, jsonb, uuid[], uuid[], uuid[], text) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.set_vendor_rfq_state(
    p_id     uuid,
    p_action text,
    p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company uuid;
    v_rfq     public.vendor_rfqs%ROWTYPE;
    v_reason  text := NULLIF(btrim(p_reason), '');
BEGIN
    SELECT r.company_id INTO v_company FROM public.vendor_rfqs r WHERE r.id = p_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_rfq FROM public.vendor_rfqs WHERE id = p_id FOR UPDATE;

    IF p_action IS NULL OR p_action NOT IN ('close', 'reopen', 'archive') THEN
        RAISE EXCEPTION 'Unknown RFQ action %', p_action USING ERRCODE = 'XX000';
    END IF;
    IF char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION 'A reason can be at most 1,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    IF p_action = 'close' THEN
        IF v_rfq.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived.', v_rfq.rfq_number USING ERRCODE = 'P0001';
        END IF;
        IF v_rfq.closed_at IS NOT NULL THEN
            RAISE EXCEPTION '% is already closed.', v_rfq.rfq_number USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.vendor_rfqs SET closed_at = now(), closed_by = auth.uid(), closed_reason = v_reason
         WHERE id = p_id;
    ELSIF p_action = 'reopen' THEN
        IF v_rfq.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '% is archived.', v_rfq.rfq_number USING ERRCODE = 'P0001';
        END IF;
        IF v_rfq.closed_at IS NULL THEN
            RAISE EXCEPTION '% isn''t closed.', v_rfq.rfq_number USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.vendor_rfqs SET closed_at = NULL, closed_by = NULL, closed_reason = NULL WHERE id = p_id;
    ELSIF v_rfq.deleted_at IS NULL THEN
        UPDATE public.vendor_rfqs SET deleted_at = now() WHERE id = p_id;
    END IF;

    RETURN jsonb_build_object(
        'id', p_id,
        'rfq_number', v_rfq.rfq_number,
        'action', p_action,
        'status', (SELECT s.status FROM public.vendor_rfq_status s WHERE s.id = p_id),
        'deleted_at', (SELECT r.deleted_at FROM public.vendor_rfqs r WHERE r.id = p_id));
END
$fn$;

COMMENT ON FUNCTION public.set_vendor_rfq_state(uuid, text, text) IS
  'p_action close, reopen or archive (never blocked; idempotent) for an RFQ. Office users only.';

REVOKE EXECUTE ON FUNCTION public.set_vendor_rfq_state(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_vendor_rfq_state(uuid, text, text) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.set_vendor_rfq_invitation_state(
    p_id     uuid,
    p_action text,
    p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company uuid;
    v_rfq_id  uuid;
    v_rfq     public.vendor_rfqs%ROWTYPE;
    v_inv     public.vendor_rfq_invitations%ROWTYPE;
    v_reason  text := NULLIF(btrim(p_reason), '');
BEGIN
    SELECT i.company_id, i.vendor_rfq_id INTO v_company, v_rfq_id
      FROM public.vendor_rfq_invitations i WHERE i.id = p_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_rfq FROM public.vendor_rfqs WHERE id = v_rfq_id FOR UPDATE;
    SELECT * INTO v_inv FROM public.vendor_rfq_invitations WHERE id = p_id FOR UPDATE;

    IF p_action IS NULL OR p_action NOT IN ('mark_sent', 'decline', 'undo_decline') THEN
        RAISE EXCEPTION 'Unknown RFQ invitation action %', p_action USING ERRCODE = 'XX000';
    END IF;
    IF v_rfq.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived.', v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;
    IF v_rfq.closed_at IS NOT NULL THEN
        RAISE EXCEPTION '% is closed. Reopen it first.', v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;
    IF char_length(v_reason) > 1000 THEN
        RAISE EXCEPTION 'A reason can be at most 1,000 characters.' USING ERRCODE = 'P0001';
    END IF;

    IF p_action = 'mark_sent' THEN
        UPDATE public.vendor_rfq_invitations SET sent_at = now(), sent_by = auth.uid() WHERE id = p_id;
    ELSIF p_action = 'decline' THEN
        IF v_inv.declined_at IS NOT NULL THEN
            RAISE EXCEPTION '% has already declined.', v_inv.vendor_name USING ERRCODE = 'P0001';
        END IF;
        IF EXISTS (SELECT 1 FROM public.vendor_rfq_responses x
                    WHERE x.vendor_rfq_invitation_id = p_id AND x.awarded_at IS NOT NULL) THEN
            RAISE EXCEPTION '% has been awarded part of this RFQ, so it can''t be marked declined.', v_inv.vendor_name
                USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.vendor_rfq_invitations
           SET declined_at = now(), declined_by = auth.uid(), declined_reason = v_reason
         WHERE id = p_id;
    ELSE
        IF v_inv.declined_at IS NULL THEN
            RAISE EXCEPTION '% hasn''t declined.', v_inv.vendor_name USING ERRCODE = 'P0001';
        END IF;
        UPDATE public.vendor_rfq_invitations
           SET declined_at = NULL, declined_by = NULL, declined_reason = NULL
         WHERE id = p_id;
    END IF;

    RETURN jsonb_build_object(
        'id', p_id,
        'vendor_rfq_id', v_rfq_id,
        'action', p_action,
        'status', (SELECT s.status FROM public.vendor_rfq_status s WHERE s.id = v_rfq_id));
END
$fn$;

COMMENT ON FUNCTION public.set_vendor_rfq_invitation_state(uuid, text, text) IS
  'For one RFQ invitation: mark_sent (stamps sent_at; the PDF goes by mailto), decline (refuses that vendor''s responses until undone; not once awarded) or undo_decline. Office users only.';

REVOKE EXECUTE ON FUNCTION public.set_vendor_rfq_invitation_state(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_vendor_rfq_invitation_state(uuid, text, text) TO authenticated, service_role;


-- One vendor's quote, per line and quantity. Upserted on (invitation, line, quantity) so ids
-- stay put; responses the payload leaves out are removed unless awarded. Awarded responses
-- are frozen.
CREATE OR REPLACE FUNCTION public.save_vendor_rfq_responses(
    p_invitation_id          uuid,
    p_responses              jsonb DEFAULT '[]'::jsonb,
    p_vendor_quote_reference text  DEFAULT NULL,
    p_quoted_on              date  DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company   uuid;
    v_rfq_id    uuid;
    v_rfq       public.vendor_rfqs%ROWTYPE;
    v_inv       public.vendor_rfq_invitations%ROWTYPE;
    v_responses jsonb := COALESCE(p_responses, '[]'::jsonb);
    v_r         jsonb;
    v_line      public.vendor_rfq_lines%ROWTYPE;
    v_qty       numeric;
    v_price     numeric;
    v_no_bid    boolean;
    v_lead      numeric;
    v_moq       numeric;
    v_vpn       text;
    v_notes     text;
    v_valid     date;
    v_awarded   public.vendor_rfq_responses%ROWTYPE;
    v_keep      uuid[] := '{}';
    v_id        uuid;
    v_ref       text;
BEGIN
    SELECT i.company_id, i.vendor_rfq_id INTO v_company, v_rfq_id
      FROM public.vendor_rfq_invitations i WHERE i.id = p_invitation_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_rfq FROM public.vendor_rfqs WHERE id = v_rfq_id FOR UPDATE;
    SELECT * INTO v_inv FROM public.vendor_rfq_invitations WHERE id = p_invitation_id FOR UPDATE;

    IF v_rfq.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived.', v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;
    IF v_rfq.closed_at IS NOT NULL THEN
        RAISE EXCEPTION '% is closed. Reopen it first.', v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;
    IF v_inv.declined_at IS NOT NULL THEN
        RAISE EXCEPTION '% declined this RFQ. Undo the decline to record their quote.', v_inv.vendor_name
            USING ERRCODE = 'P0001';
    END IF;
    IF jsonb_typeof(v_responses) <> 'array' THEN
        RAISE EXCEPTION 'p_responses must be a JSON array' USING ERRCODE = 'XX000';
    END IF;

    v_ref := CASE WHEN p_vendor_quote_reference IS NULL THEN v_inv.vendor_quote_reference
                  ELSE NULLIF(btrim(p_vendor_quote_reference), '') END;
    IF char_length(v_ref) > 64 THEN
        RAISE EXCEPTION 'A quote reference can be at most 64 characters.' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.vendor_rfq_invitations
       SET vendor_quote_reference = v_ref, quoted_on = COALESCE(p_quoted_on, quoted_on)
     WHERE id = p_invitation_id;

    -- One answer per (line, quantity) in the payload.
    IF (SELECT count(*) FROM jsonb_array_elements(v_responses))
       <> (SELECT count(DISTINCT (e.value->>'line_id', (e.value->>'quantity')::numeric))
             FROM jsonb_array_elements(v_responses) e) THEN
        RAISE EXCEPTION 'Each line and quantity can be quoted once.' USING ERRCODE = 'P0001';
    END IF;

    FOR v_r IN SELECT e.value FROM jsonb_array_elements(v_responses) WITH ORDINALITY e ORDER BY e.ordinality LOOP
        PERFORM public.purchasing_assert_keys(v_r,
            ARRAY['line_id', 'quantity', 'unit_price', 'no_bid', 'lead_time_days', 'minimum_order_quantity',
                  'valid_until', 'vendor_part_number', 'notes'],
            'an RFQ response');
        SELECT * INTO v_line FROM public.vendor_rfq_lines l
         WHERE l.id = NULLIF(v_r->>'line_id', '')::uuid AND l.vendor_rfq_id = v_rfq_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
        END IF;
        v_qty    := NULLIF(v_r->>'quantity', '')::numeric;
        v_no_bid := COALESCE((v_r->>'no_bid')::boolean, false);
        v_price  := NULLIF(v_r->>'unit_price', '')::numeric;
        v_lead   := NULLIF(v_r->>'lead_time_days', '')::numeric;
        v_moq    := NULLIF(v_r->>'minimum_order_quantity', '')::numeric;
        v_valid  := NULLIF(v_r->>'valid_until', '')::date;
        v_vpn    := NULLIF(btrim(v_r->>'vendor_part_number'), '');
        v_notes  := NULLIF(btrim(v_r->>'notes'), '');

        IF v_qty IS NULL OR NOT (v_qty = ANY (v_line.quantities)) THEN
            RAISE EXCEPTION 'Line % asks for %; a quote has to be for one of those quantities.',
                v_line.line_number, array_to_string(v_line.quantities, ', ') USING ERRCODE = 'P0001';
        END IF;
        IF v_no_bid AND v_price IS NOT NULL THEN
            RAISE EXCEPTION 'A no-bid has no price (line %).', v_line.line_number USING ERRCODE = 'P0001';
        END IF;
        IF NOT v_no_bid AND v_price IS NULL THEN
            RAISE EXCEPTION 'Give a price, or mark it no bid (line %, quantity %).', v_line.line_number, trim_scale(v_qty)
                USING ERRCODE = 'P0001';
        END IF;
        IF v_price IS NOT NULL AND (v_price < 0 OR v_price >= 100000000000) THEN
            RAISE EXCEPTION 'A price can''t be negative or that large.' USING ERRCODE = 'P0001';
        END IF;
        IF v_lead IS NOT NULL AND (v_lead <> trunc(v_lead) OR v_lead < 0 OR v_lead > 730) THEN
            RAISE EXCEPTION 'Lead time must be a whole number of days from 0 to 730.' USING ERRCODE = 'P0001';
        END IF;
        IF v_moq IS NOT NULL AND v_moq <= 0 THEN
            RAISE EXCEPTION 'A minimum order must be more than zero.' USING ERRCODE = 'P0001';
        END IF;
        IF char_length(v_vpn) > 64 THEN
            RAISE EXCEPTION 'A vendor part number can be at most 64 characters.' USING ERRCODE = 'P0001';
        END IF;
        IF char_length(v_notes) > 2000 THEN
            RAISE EXCEPTION 'Notes can be at most 2,000 characters.' USING ERRCODE = 'P0001';
        END IF;

        -- An awarded answer is frozen: the same values pass, anything else is refused.
        SELECT * INTO v_awarded FROM public.vendor_rfq_responses x
         WHERE x.vendor_rfq_invitation_id = p_invitation_id AND x.vendor_rfq_line_id = v_line.id
           AND x.quantity = v_qty AND x.awarded_at IS NOT NULL;
        IF FOUND THEN
            IF v_awarded.unit_price IS DISTINCT FROM v_price OR v_awarded.no_bid IS DISTINCT FROM v_no_bid
               OR v_awarded.lead_time_days IS DISTINCT FROM v_lead::integer
               OR v_awarded.minimum_order_quantity IS DISTINCT FROM v_moq
               OR v_awarded.valid_until IS DISTINCT FROM v_valid
               OR v_awarded.vendor_part_number IS DISTINCT FROM v_vpn
               OR v_awarded.notes IS DISTINCT FROM v_notes THEN
                RAISE EXCEPTION 'The quote for line % at % was awarded, so it can''t change.',
                    v_line.line_number, trim_scale(v_qty) USING ERRCODE = 'P0001';
            END IF;
            v_keep := v_keep || v_awarded.id;
            CONTINUE;
        END IF;

        INSERT INTO public.vendor_rfq_responses (
            company_id, vendor_rfq_id, vendor_rfq_invitation_id, vendor_rfq_line_id, quantity,
            unit_price, no_bid, lead_time_days, minimum_order_quantity, valid_until,
            vendor_part_number, notes)
        VALUES (
            v_company, v_rfq_id, p_invitation_id, v_line.id, v_qty,
            v_price, v_no_bid, v_lead::integer, v_moq, v_valid, v_vpn, v_notes)
        ON CONFLICT (vendor_rfq_invitation_id, vendor_rfq_line_id, quantity) DO UPDATE SET
            unit_price = EXCLUDED.unit_price, no_bid = EXCLUDED.no_bid,
            lead_time_days = EXCLUDED.lead_time_days,
            minimum_order_quantity = EXCLUDED.minimum_order_quantity,
            valid_until = EXCLUDED.valid_until, vendor_part_number = EXCLUDED.vendor_part_number,
            notes = EXCLUDED.notes
        RETURNING id INTO v_id;
        v_keep := v_keep || v_id;
    END LOOP;

    -- Whatever this vendor said before and the payload no longer says goes, unless awarded.
    DELETE FROM public.vendor_rfq_responses x
     WHERE x.vendor_rfq_invitation_id = p_invitation_id
       AND x.awarded_at IS NULL
       AND NOT (x.id = ANY (v_keep));

    RETURN jsonb_build_object(
        'invitation_id', p_invitation_id,
        'vendor_rfq_id', v_rfq_id,
        'response_ids', to_jsonb(v_keep),
        'status', (SELECT s.status FROM public.vendor_rfq_status s WHERE s.id = v_rfq_id));
END
$fn$;

COMMENT ON FUNCTION public.save_vendor_rfq_responses(uuid, jsonb, text, date) IS
  'Records one invited vendor''s quote: p_responses [{line_id, quantity (one of the line''s), unit_price per the line''s unit | no_bid, lead_time_days, minimum_order_quantity, valid_until, vendor_part_number, notes}] replaces that vendor''s unawarded answers (upserted on line and quantity so ids stay put). Awarded answers are frozen. A declined vendor is refused. p_vendor_quote_reference / p_quoted_on update the invitation when given (an empty reference clears it). Office users only.';

REVOKE EXECUTE ON FUNCTION public.save_vendor_rfq_responses(uuid, jsonb, text, date) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.save_vendor_rfq_responses(uuid, jsonb, text, date) TO authenticated, service_role;


-- ============================================================================
-- 3. award_vendor_rfq -- one draft PO per vendor, atomically
-- ============================================================================
CREATE OR REPLACE FUNCTION public.award_vendor_rfq(
    p_rfq_id                uuid,
    p_response_ids          uuid[],
    p_save_to_price_sheets  boolean DEFAULT false,
    p_today                 date    DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company  uuid;
    v_rfq      public.vendor_rfqs%ROWTYPE;
    v_ids      uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_response_ids, '{}'::uuid[])) x WHERE x IS NOT NULL);
    v_bad      record;
    v_vendor   record;
    v_po_id    uuid;
    v_lines    jsonb;
    v_written  jsonb;
    v_pos      jsonb := '[]'::jsonb;
    v_sheets   jsonb := '[]'::jsonb;
    v_a        record;
    v_header   jsonb;
    v_changes  jsonb;
    v_breaks   jsonb;
    v_saved    jsonb;
    v_i        integer;
BEGIN
    SELECT r.company_id INTO v_company FROM public.vendor_rfqs r WHERE r.id = p_rfq_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_insert)' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_rfq FROM public.vendor_rfqs WHERE id = p_rfq_id FOR UPDATE;

    IF p_today IS NULL THEN
        RAISE EXCEPTION 'p_today is required: pass the caller''s local date.' USING ERRCODE = 'XX000';
    END IF;
    IF v_rfq.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived.', v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;
    IF v_rfq.closed_at IS NOT NULL THEN
        RAISE EXCEPTION '% is closed. Reopen it first.', v_rfq.rfq_number USING ERRCODE = 'P0001';
    END IF;
    IF cardinality(v_ids) = 0 THEN
        RAISE EXCEPTION 'Choose a quote for at least one line.' USING ERRCODE = 'P0001';
    END IF;
    -- Every response must be one of THIS RFQ's.
    IF EXISTS (SELECT 1 FROM unnest(v_ids) x(id)
                WHERE NOT EXISTS (SELECT 1 FROM public.vendor_rfq_responses r
                                   WHERE r.id = x.id AND r.vendor_rfq_id = p_rfq_id)) THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;

    SELECT l.line_number INTO v_bad
      FROM public.vendor_rfq_responses r JOIN public.vendor_rfq_lines l ON l.id = r.vendor_rfq_line_id
     WHERE r.id = ANY (v_ids) GROUP BY l.line_number HAVING count(*) > 1 LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Award one quote per line (line % has two).', v_bad.line_number USING ERRCODE = 'P0001';
    END IF;
    SELECT l.line_number INTO v_bad
      FROM public.vendor_rfq_responses r JOIN public.vendor_rfq_lines l ON l.id = r.vendor_rfq_line_id
     WHERE r.id = ANY (v_ids)
       AND EXISTS (SELECT 1 FROM public.vendor_rfq_responses o
                    WHERE o.vendor_rfq_line_id = r.vendor_rfq_line_id AND o.awarded_at IS NOT NULL)
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Line % is already awarded.', v_bad.line_number USING ERRCODE = 'P0001';
    END IF;
    SELECT l.line_number, i.vendor_name INTO v_bad
      FROM public.vendor_rfq_responses r
      JOIN public.vendor_rfq_lines l ON l.id = r.vendor_rfq_line_id
      JOIN public.vendor_rfq_invitations i ON i.id = r.vendor_rfq_invitation_id
     WHERE r.id = ANY (v_ids) AND r.no_bid LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION '% said no bid on line %.', v_bad.vendor_name, v_bad.line_number USING ERRCODE = 'P0001';
    END IF;
    SELECT i.vendor_name INTO v_bad
      FROM public.vendor_rfq_responses r JOIN public.vendor_rfq_invitations i ON i.id = r.vendor_rfq_invitation_id
     WHERE r.id = ANY (v_ids) AND i.declined_at IS NOT NULL LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION '% declined this RFQ.', v_bad.vendor_name USING ERRCODE = 'P0001';
    END IF;

    -- One draft PO per vendor, in name order so numbering is predictable.
    FOR v_vendor IN
        SELECT DISTINCT i.vendor_id, i.vendor_name, i.vendor_contact_id
          FROM public.vendor_rfq_responses r
          JOIN public.vendor_rfq_invitations i ON i.id = r.vendor_rfq_invitation_id
         WHERE r.id = ANY (v_ids)
         ORDER BY i.vendor_name, i.vendor_id
    LOOP
        v_header := jsonb_build_object('need_by_on', v_rfq.needed_by_on);
        IF v_vendor.vendor_contact_id IS NOT NULL THEN
            v_header := v_header || jsonb_build_object('vendor_contact_id', v_vendor.vendor_contact_id);
        END IF;
        v_po_id := public.vendor_purchase_order_insert(v_company, v_vendor.vendor_id, p_today, v_header, p_rfq_id);
        PERFORM 1 FROM public.vendor_purchase_orders h WHERE h.id = v_po_id FOR UPDATE;

        -- A part line stays a part line; ad-hoc text becomes an "other" line.
        SELECT COALESCE(jsonb_agg(
                 CASE WHEN l.part_id IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
                          'line_kind', 'part', 'part_id', l.part_id, 'description', l.description,
                          'quantity', r.quantity, 'unit', l.unit, 'unit_price', r.unit_price,
                          'price_source', 'rfq', 'vendor_part_number', r.vendor_part_number,
                          'need_by_on', v_rfq.needed_by_on, 'cert_required', l.cert_required,
                          'job_id', l.job_id))
                      ELSE jsonb_strip_nulls(jsonb_build_object(
                          'line_kind', 'other', 'description', l.description,
                          'quantity', r.quantity, 'unit', l.unit, 'unit_price', r.unit_price,
                          'price_source', 'rfq', 'vendor_part_number', r.vendor_part_number,
                          'need_by_on', v_rfq.needed_by_on, 'cert_required', l.cert_required,
                          'job_id', l.job_id))
                 END ORDER BY l.line_number), '[]'::jsonb)
          INTO v_lines
          FROM public.vendor_rfq_responses r
          JOIN public.vendor_rfq_lines l ON l.id = r.vendor_rfq_line_id
          JOIN public.vendor_rfq_invitations i ON i.id = r.vendor_rfq_invitation_id
         WHERE r.id = ANY (v_ids) AND i.vendor_id = v_vendor.vendor_id;

        v_written := public.vendor_purchase_order_write_lines(v_po_id, v_lines);
        -- Records the new PO's first content_hash, as create_vendor_purchase_order does.
        PERFORM public.vendor_purchase_order_settle_versions(v_po_id, false);

        -- Stamp each award with the PO line it became (same order as v_lines).
        v_i := 0;
        FOR v_a IN
            SELECT r.id FROM public.vendor_rfq_responses r
              JOIN public.vendor_rfq_lines l ON l.id = r.vendor_rfq_line_id
              JOIN public.vendor_rfq_invitations i ON i.id = r.vendor_rfq_invitation_id
             WHERE r.id = ANY (v_ids) AND i.vendor_id = v_vendor.vendor_id
             ORDER BY l.line_number
        LOOP
            UPDATE public.vendor_rfq_responses
               SET awarded_at = now(), awarded_by = auth.uid(),
                   vendor_purchase_order_line_id = (v_written->'line_ids'->>v_i)::uuid
             WHERE id = v_a.id;
            v_i := v_i + 1;
        END LOOP;

        v_pos := v_pos || jsonb_build_array(jsonb_build_object(
            'id', v_po_id,
            'po_number', (SELECT h.po_number FROM public.vendor_purchase_orders h WHERE h.id = v_po_id),
            'vendor_id', v_vendor.vendor_id,
            'vendor_name', v_vendor.vendor_name,
            'line_ids', v_written->'line_ids'));
    END LOOP;

    -- Only when asked: each awarded part line's quotes from that vendor become its price
    -- sheet (in the RFQ line's unit), creating the approved-vendor row as approved when
    -- missing and reviving it when archived.
    IF COALESCE(p_save_to_price_sheets, false) THEN
        FOR v_a IN
            SELECT r.id AS response_id, r.vendor_rfq_invitation_id, r.vendor_rfq_line_id, r.lead_time_days,
                   r.minimum_order_quantity, r.vendor_part_number, l.part_id, l.unit,
                   i.vendor_id, i.quoted_on
              FROM public.vendor_rfq_responses r
              JOIN public.vendor_rfq_lines l ON l.id = r.vendor_rfq_line_id
              JOIN public.vendor_rfq_invitations i ON i.id = r.vendor_rfq_invitation_id
             WHERE r.id = ANY (v_ids) AND l.part_id IS NOT NULL
             ORDER BY l.line_number
        LOOP
            SELECT jsonb_agg(jsonb_build_object(
                       'min_quantity', x.quantity, 'unit_price', x.unit_price,
                       'source', 'rfq', 'vendor_rfq_response_id', x.id) ORDER BY x.quantity)
              INTO v_breaks
              FROM public.vendor_rfq_responses x
             WHERE x.vendor_rfq_invitation_id = v_a.vendor_rfq_invitation_id
               AND x.vendor_rfq_line_id = v_a.vendor_rfq_line_id
               AND NOT x.no_bid AND x.unit_price > 0;
            v_changes := jsonb_strip_nulls(jsonb_build_object(
                'purchase_unit', v_a.unit,
                'quoted_on', v_a.quoted_on,
                'valid_until', (SELECT min(x.valid_until) FROM public.vendor_rfq_responses x
                                 WHERE x.vendor_rfq_invitation_id = v_a.vendor_rfq_invitation_id
                                   AND x.vendor_rfq_line_id = v_a.vendor_rfq_line_id AND NOT x.no_bid),
                'lead_time_days', v_a.lead_time_days,
                'minimum_order_quantity', v_a.minimum_order_quantity,
                'vendor_part_number', v_a.vendor_part_number));
            v_saved := public.part_vendor_write(v_a.part_id, v_a.vendor_id, v_changes, v_breaks,
                ARRAY['min_quantity', 'unit_price', 'source', 'vendor_rfq_response_id']);
            v_sheets := v_sheets || jsonb_build_array(v_saved->'part_vendor_id');
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'vendor_rfq_id', p_rfq_id,
        'purchase_orders', v_pos,
        'awarded_response_ids', to_jsonb(v_ids),
        'saved_part_vendor_ids', v_sheets,
        'status', (SELECT s.status FROM public.vendor_rfq_status s WHERE s.id = p_rfq_id));
END
$fn$;

COMMENT ON FUNCTION public.award_vendor_rfq(uuid, uuid[], boolean, date) IS
  'Awards RFQ responses (by id; one per line, none already awarded, none no-bid, no declined vendor), atomically: one DRAFT purchase order per vendor (vendor_rfq_id set, ordered on p_today, need-by the RFQ''s), part lines as part lines and ad-hoc lines as other lines, priced per the RFQ line unit with price_source rfq; stamps each response awarded with its PO line. p_save_to_price_sheets (off by default) also writes that vendor''s quotes for each awarded part line as its price sheet, creating the approved-vendor row as approved when missing. Anything failing leaves nothing. Office users only.';

REVOKE EXECUTE ON FUNCTION public.award_vendor_rfq(uuid, uuid[], boolean, date) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.award_vendor_rfq(uuid, uuid[], boolean, date) TO authenticated, service_role;


-- ============================================================================
-- 4. "Use as part cost" -- preview, then apply exactly what was previewed
-- ============================================================================
-- INVOKER and read-only: as the browser it sees only what RLS shows. Each existing cost tier
-- (quantity in stock units) takes the vendor's break for that many purchase units (the
-- highest at or below, else the lowest, flagged below_vendor_minimum), converted to a price
-- per stock unit. A part with no tiers gets one proposed tier per break, at markup 0 (the
-- starter-tier convention). Made parts are refused: their cost is their routing and BOM.
CREATE OR REPLACE FUNCTION public.preview_part_cost_from_vendor(p_part_vendor_id uuid, p_today date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_pv          record;
    v_factor      numeric;
    v_tiers       jsonb;
    v_inserts     jsonb := '[]'::jsonb;
    v_open_quotes integer;
    v_parents     integer;
    v_warnings    jsonb := '[]'::jsonb;
BEGIN
    IF p_today IS NULL THEN
        RAISE EXCEPTION 'p_today is required: pass the caller''s local date.' USING ERRCODE = 'XX000';
    END IF;

    SELECT pv.id, pv.company_id, pv.part_id, pv.vendor_id, pv.purchase_unit, pv.quoted_on,
           pv.valid_until, pv.deleted_at, p.part_name, p.source, p.primary_unit,
           p.deleted_at AS part_deleted_at, v.name AS vendor_name, v.deleted_at AS vendor_deleted_at
      INTO v_pv
      FROM public.part_vendors pv
      JOIN public.parts p   ON p.id = pv.part_id
      JOIN public.vendors v ON v.id = pv.vendor_id
     WHERE pv.id = p_part_vendor_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;
    IF v_pv.source <> 'bought' THEN
        RAISE EXCEPTION '% is made in-house, so its cost comes from its routing and materials, not a vendor''s price.',
            v_pv.part_name USING ERRCODE = 'P0001';
    END IF;
    IF v_pv.part_deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% is archived.', v_pv.part_name USING ERRCODE = 'P0001';
    END IF;
    IF v_pv.deleted_at IS NOT NULL OR v_pv.vendor_deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '% isn''t on %''s vendor list any more.', v_pv.vendor_name, v_pv.part_name
            USING ERRCODE = 'P0001';
    END IF;
    IF v_pv.valid_until IS NOT NULL AND v_pv.valid_until < p_today THEN
        RAISE EXCEPTION '%''s price sheet for % expired on %.', v_pv.vendor_name, v_pv.part_name, v_pv.valid_until
            USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.part_vendor_price_breaks b WHERE b.part_vendor_id = v_pv.id) THEN
        RAISE EXCEPTION '%''s price sheet for % has no prices yet.', v_pv.vendor_name, v_pv.part_name
            USING ERRCODE = 'P0001';
    END IF;

    v_factor := public.part_unit_factor(v_pv.part_id, v_pv.purchase_unit);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'tier_id',              t.id,
               'quantity',             t.quantity,
               'markup_percent',       t.markup_percent,
               'current_cost',         t.cost_per_unit,
               'proposed_cost',        round(COALESCE(hi.unit_price, lo.unit_price) / v_factor, 6),
               'current_price',        CASE WHEN t.markup_percent IS NULL OR t.cost_per_unit IS NULL THEN NULL
                                            ELSE round(t.cost_per_unit * (1 + t.markup_percent / 100.0), 2) END,
               'proposed_price',       CASE WHEN t.markup_percent IS NULL THEN NULL
                                            ELSE round(round(COALESCE(hi.unit_price, lo.unit_price) / v_factor, 6)
                                                       * (1 + t.markup_percent / 100.0), 2) END,
               'vendor_min_quantity',  COALESCE(hi.min_quantity, lo.min_quantity),
               'vendor_unit_price',    COALESCE(hi.unit_price, lo.unit_price),
               'below_vendor_minimum', hi.min_quantity IS NULL
           ) ORDER BY t.quantity), '[]'::jsonb)
      INTO v_tiers
      FROM public.part_pricing_tiers t
      LEFT JOIN LATERAL (
          SELECT b.min_quantity, b.unit_price FROM public.part_vendor_price_breaks b
           WHERE b.part_vendor_id = v_pv.id AND b.min_quantity <= t.quantity / v_factor
           ORDER BY b.min_quantity DESC LIMIT 1) hi ON true
      LEFT JOIN LATERAL (
          SELECT b.min_quantity, b.unit_price FROM public.part_vendor_price_breaks b
           WHERE b.part_vendor_id = v_pv.id
           ORDER BY b.min_quantity ASC LIMIT 1) lo ON true
     WHERE t.part_id = v_pv.part_id;

    IF jsonb_array_length(v_tiers) = 0 THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'quantity',            trim_scale(b.min_quantity * v_factor),
                   'proposed_cost',       round(b.unit_price / v_factor, 6),
                   'markup_percent',      0,
                   'vendor_min_quantity', b.min_quantity,
                   'vendor_unit_price',   b.unit_price
               ) ORDER BY b.min_quantity), '[]'::jsonb)
          INTO v_inserts
          FROM public.part_vendor_price_breaks b
         WHERE b.part_vendor_id = v_pv.id;
        v_warnings := v_warnings || '["starter_tiers_inserted"]'::jsonb;
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_tiers) e WHERE (e.value->>'below_vendor_minimum')::boolean) THEN
        v_warnings := v_warnings || '["below_vendor_minimum"]'::jsonb;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_tiers || v_inserts) e
                WHERE (e.value->>'proposed_cost')::numeric <= 0) THEN
        RAISE EXCEPTION 'That price is too small to store as a cost per %.', v_pv.primary_unit USING ERRCODE = 'P0001';
    END IF;

    -- What "Pricing changed" will touch: open quotes with this part on them, directly or
    -- through any assembly above it; and the parts above it that re-cost.
    WITH RECURSIVE ancestors(part_id) AS (
        SELECT v_pv.part_id
        UNION
        SELECT b.parent_part_id FROM public.parts_bom b JOIN ancestors a ON b.child_part_id = a.part_id
    )
    SELECT count(DISTINCT q.id) INTO v_open_quotes
      FROM public.quotes q
      JOIN public.quote_line_items qli ON qli.quote_id = q.id
     WHERE qli.part_id IN (SELECT a.part_id FROM ancestors a)
       AND q.deleted_at IS NULL
       AND public.is_quote_open(q.status, q.converted_at, q.expiration_date, p_today);

    WITH RECURSIVE ancestors(part_id) AS (
        SELECT v_pv.part_id
        UNION
        SELECT b.parent_part_id FROM public.parts_bom b JOIN ancestors a ON b.child_part_id = a.part_id
    )
    SELECT count(*) INTO v_parents
      FROM ancestors a JOIN public.parts p ON p.id = a.part_id
     WHERE a.part_id <> v_pv.part_id AND p.deleted_at IS NULL;

    RETURN jsonb_build_object(
        'part_vendor_id', v_pv.id,
        'part_id', v_pv.part_id,
        'part_name', v_pv.part_name,
        'vendor_id', v_pv.vendor_id,
        'vendor_name', v_pv.vendor_name,
        'purchase_unit', v_pv.purchase_unit,
        'stock_unit', v_pv.primary_unit,
        'stock_factor', v_factor,
        'quoted_on', v_pv.quoted_on,
        'valid_until', v_pv.valid_until,
        'tiers', v_tiers,
        'inserts', v_inserts,
        'open_quote_count', v_open_quotes,
        'bom_parent_part_count', v_parents,
        'warnings', v_warnings);
END
$fn$;

COMMENT ON FUNCTION public.preview_part_cost_from_vendor(uuid, date) IS
  'What "Use as part cost" would do, written nowhere: per existing cost tier its current and proposed cost per stock unit (from the vendor''s break for that many purchase units, the highest at or below, else the lowest, flagged below_vendor_minimum), markup unchanged, current and proposed price; when the part has no tiers, the tiers that would be inserted at markup 0; open_quote_count (open quotes with the part, directly or through an assembly) and bom_parent_part_count. Refuses made parts, archived rows and expired or empty sheets. SECURITY INVOKER: the browser sees only its own companies.';

REVOKE EXECUTE ON FUNCTION public.preview_part_cost_from_vendor(uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.preview_part_cost_from_vendor(uuid, date) TO authenticated, service_role;


-- THE ONLY PURCHASING WRITER OF part_pricing_tiers. In place: tier ids and quantities stay,
-- so quote drift detection flags exactly the lines whose price moved and nothing else; new
-- tiers only when the part had none. Refused if anything moved since the preview.
CREATE OR REPLACE FUNCTION public.apply_part_cost_from_vendor(
    p_part_vendor_id uuid,
    p_today          date,
    p_expected       jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_company  uuid;
    v_part     uuid;
    v_now      jsonb;
    v_updated  uuid[] := '{}';
    v_inserted uuid[] := '{}';
    v_e        record;
    v_seq      integer;
    v_id       uuid;
BEGIN
    SELECT pv.company_id, pv.part_id INTO v_company, v_part
      FROM public.part_vendors pv WHERE pv.id = p_part_vendor_id;
    PERFORM public.assert_office_member(v_company);
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)' USING ERRCODE = '42501';
    END IF;
    -- The part's ladder and the sheet hold still while this runs.
    PERFORM 1 FROM public.parts p WHERE p.id = v_part FOR NO KEY UPDATE;
    PERFORM 1 FROM public.part_vendors pv WHERE pv.id = p_part_vendor_id FOR UPDATE;
    PERFORM 1 FROM public.part_pricing_tiers t WHERE t.part_id = v_part FOR UPDATE;

    IF p_today IS NULL THEN
        RAISE EXCEPTION 'p_today is required: pass the caller''s local date.' USING ERRCODE = 'XX000';
    END IF;
    IF p_expected IS NULL OR jsonb_typeof(p_expected) <> 'object' THEN
        RAISE EXCEPTION 'p_expected must be the preview being confirmed' USING ERRCODE = 'XX000';
    END IF;

    v_now := public.preview_part_cost_from_vendor(p_part_vendor_id, p_today);

    -- Compared on what decides the write, so a client that round-trips the preview through
    -- its own types (dropping display-only keys) is not refused for that.
    IF (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'tier_id', e->'tier_id', 'quantity', e->'quantity',
                 'current_cost', e->'current_cost', 'proposed_cost', e->'proposed_cost') ORDER BY o), '[]'::jsonb)
          FROM jsonb_array_elements(v_now->'tiers') WITH ORDINALITY x(e, o))
       IS DISTINCT FROM
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'tier_id', e->'tier_id', 'quantity', e->'quantity',
                 'current_cost', e->'current_cost', 'proposed_cost', e->'proposed_cost') ORDER BY o), '[]'::jsonb)
          FROM jsonb_array_elements(COALESCE(p_expected->'tiers', '[]'::jsonb)) WITH ORDINALITY x(e, o))
       OR
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'quantity', e->'quantity', 'proposed_cost', e->'proposed_cost') ORDER BY o), '[]'::jsonb)
          FROM jsonb_array_elements(v_now->'inserts') WITH ORDINALITY x(e, o))
       IS DISTINCT FROM
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'quantity', e->'quantity', 'proposed_cost', e->'proposed_cost') ORDER BY o), '[]'::jsonb)
          FROM jsonb_array_elements(COALESCE(p_expected->'inserts', '[]'::jsonb)) WITH ORDINALITY x(e, o))
    THEN
        RAISE EXCEPTION 'This part''s pricing or the price sheet changed since you previewed. Preview it again.'
            USING ERRCODE = 'P0001';
    END IF;

    FOR v_e IN SELECT e.value AS t FROM jsonb_array_elements(v_now->'tiers') e LOOP
        UPDATE public.part_pricing_tiers
           SET cost_per_unit = (v_e.t->>'proposed_cost')::numeric
         WHERE id = (v_e.t->>'tier_id')::uuid AND part_id = v_part
        RETURNING id INTO v_id;
        v_updated := v_updated || v_id;
    END LOOP;

    v_seq := 0;
    FOR v_e IN SELECT e.value AS t FROM jsonb_array_elements(v_now->'inserts') WITH ORDINALITY e ORDER BY e.ordinality LOOP
        v_seq := v_seq + 10;
        INSERT INTO public.part_pricing_tiers (part_id, company_id, sequence, quantity, cost_per_unit, markup_percent)
        VALUES (v_part, v_company, v_seq, (v_e.t->>'quantity')::numeric, (v_e.t->>'proposed_cost')::numeric, 0)
        RETURNING id INTO v_id;
        v_inserted := v_inserted || v_id;
    END LOOP;

    RETURN jsonb_build_object(
        'part_id', v_part,
        'part_vendor_id', p_part_vendor_id,
        'updated_tier_ids', to_jsonb(v_updated),
        'inserted_tier_ids', to_jsonb(v_inserted));
END
$fn$;

COMMENT ON FUNCTION public.apply_part_cost_from_vendor(uuid, date, jsonb) IS
  'Applies "Use as part cost": recomputes preview_part_cost_from_vendor and refuses ("changed since you previewed") unless its tiers and inserts match p_expected; then sets cost_per_unit IN PLACE on each existing tier (same ids and quantities, markup untouched) or, for a part with no tiers, inserts them at markup 0. The only purchasing function that writes part_pricing_tiers. Bought parts only. Office users only.';

REVOKE EXECUTE ON FUNCTION public.apply_part_cost_from_vendor(uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_part_cost_from_vendor(uuid, date, jsonb) TO authenticated, service_role;
