-- ============================================================================
-- PURCHASING (2 of 5): derived state, and the helpers every writer shares
-- ============================================================================
-- Status, progress, on-order and "late" are COMPUTED, never stored, and computed ONCE: the
-- UI, the MCP tools and the insights AI all read these views, so there is no second
-- definition to drift (the is_job_late / is_quote_open lesson). All views are
-- security_invoker, readable by authenticated, service_role and jigged_ai_readonly, and
-- carry no actor columns. They read only columns the AI role was granted in migration 1,
-- so SELECT * on every one of them works as that role.
--
-- Also here: the two stock RPCs, re-created WORD FOR WORD from their newest bodies plus the
-- ledger row id in what they return, so a purchase-order receipt can link the addition it
-- wrote. Same signatures, so the ACLs survive; the COMMENTs are re-issued and the
-- one-overload + grant guards repeated.
-- ============================================================================


-- ============================================================================
-- 1. Small shared helpers
-- ============================================================================

-- A jsonb key the RPC does not recognise is OUR bug (a caller sending a field that does
-- not exist), so it is XX000 -- never a refusal sentence a person is shown.
CREATE OR REPLACE FUNCTION public.purchasing_assert_keys(p_value jsonb, p_allowed text[], p_what text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_bad text;
BEGIN
    IF p_value IS NULL THEN
        RETURN;
    END IF;
    IF jsonb_typeof(p_value) <> 'object' THEN
        RAISE EXCEPTION '% must be a JSON object, not %', p_what, jsonb_typeof(p_value)
            USING ERRCODE = 'XX000';
    END IF;
    SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad
      FROM jsonb_object_keys(p_value) AS k
     WHERE NOT (k = ANY (p_allowed));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'Unknown key(s) in %: %', p_what, v_bad USING ERRCODE = 'XX000';
    END IF;
END
$fn$;

COMMENT ON FUNCTION public.purchasing_assert_keys(jsonb, text[], text) IS
  'Raises XX000 when a purchasing RPC''s jsonb argument is not an object or carries a key the RPC does not recognise. A caller bug, never a user-facing refusal. Internal.';

REVOKE EXECUTE ON FUNCTION public.purchasing_assert_keys(jsonb, text[], text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.purchasing_assert_keys(jsonb, text[], text) TO service_role;


-- The SQL mirror of lib/unitPresets.ts UNIT_ALIASES (ea -> each, in -> inches, ...), applied
-- before every "is this the same unit" comparison, then lower-cased. The access layer
-- normalises aliases before calling an RPC; this makes the database agree when it does not,
-- so an `ea` line on an `each` part gets factor 1 here exactly as it does in TypeScript.
--
-- unit_name_key and part_unit_factor are about a PART's units, not about purchasing, and
-- are browser-callable on purpose: both are SECURITY INVOKER reads (the second sees only what
-- RLS shows the caller), and preview_part_cost_from_vendor, which is INVOKER too, calls them
-- as the browser.
CREATE OR REPLACE FUNCTION public.unit_name_key(p_unit text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT lower(CASE btrim(p_unit)
      WHEN 'ea'    THEN 'each'
      WHEN 'pcs'   THEN 'pieces'
      WHEN 'pc'    THEN 'pieces'
      WHEN 'dz'    THEN 'dozen'
      WHEN 'lb'    THEN 'pounds'
      WHEN 'lbs'   THEN 'pounds'
      WHEN 'kg'    THEN 'kilograms'
      WHEN 'kgs'   THEN 'kilograms'
      WHEN 'oz'    THEN 'ounces'
      WHEN 'g'     THEN 'grams'
      WHEN 'in'    THEN 'inches'
      WHEN 'ft'    THEN 'feet'
      WHEN 'mm'    THEN 'millimeters'
      WHEN 'cm'    THEN 'centimeters'
      WHEN 'm'     THEN 'meters'
      WHEN 'gal'   THEN 'gallons'
      WHEN 'L'     THEN 'liters'
      WHEN 'qt'    THEN 'quarts'
      WHEN 'mL'    THEN 'milliliters'
      WHEN 'fl oz' THEN 'fluid ounces'
      WHEN 'sq in' THEN 'square inches'
      WHEN 'sq ft' THEN 'square feet'
      WHEN 'sq cm' THEN 'square centimeters'
      WHEN 'sq m'  THEN 'square meters'
      ELSE btrim(p_unit)
  END)
$fn$;

COMMENT ON FUNCTION public.unit_name_key(text) IS
  'The comparison key for a unit name: lib/unitPresets.ts UNIT_ALIASES applied (case-sensitive, as there), then lower-cased. Two unit names are the same unit exactly when their keys are equal. Pure; keep in step with UNIT_ALIASES.';

REVOKE EXECUTE ON FUNCTION public.unit_name_key(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unit_name_key(text) TO authenticated, service_role;


-- One factor per (part, unit). The stock unit is parts.primary_unit and is factor 1; any
-- other purchase unit must have a parts_unit_conversions row (the access layer writes a
-- preset or "Another unit..." as a row before calling the RPC). convertToBaseUnit is never
-- the answer: it silently returns the number unconverted.
CREATE OR REPLACE FUNCTION public.part_unit_factor(p_part_id uuid, p_unit text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_primary text;
    v_part    text;
    v_factors numeric[];
BEGIN
    SELECT primary_unit, part_name INTO v_primary, v_part FROM public.parts WHERE id = p_part_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'That record is not available.' USING ERRCODE = 'P0001';
    END IF;
    IF p_unit IS NULL OR btrim(p_unit) = '' THEN
        RAISE EXCEPTION 'Say what unit % is bought in.', v_part USING ERRCODE = 'P0001';
    END IF;

    IF public.unit_name_key(p_unit) = public.unit_name_key(v_primary) THEN
        RETURN 1;
    END IF;

    SELECT array_agg(DISTINCT c.to_primary_factor ORDER BY c.to_primary_factor) INTO v_factors
      FROM public.parts_unit_conversions c
     WHERE c.part_id = p_part_id
       AND public.unit_name_key(c.from_unit) = public.unit_name_key(p_unit);

    IF v_factors IS NULL THEN
        RAISE EXCEPTION '% has no conversion for "%". Say how many % are in one % first.',
            v_part, btrim(p_unit), v_primary, btrim(p_unit) USING ERRCODE = 'P0001';
    END IF;
    IF cardinality(v_factors) > 1 THEN
        RAISE EXCEPTION '% has two different conversions for "%". Fix them so one % means one amount.',
            v_part, btrim(p_unit), btrim(p_unit) USING ERRCODE = 'P0001';
    END IF;
    RETURN v_factors[1];
END
$fn$;

COMMENT ON FUNCTION public.part_unit_factor(uuid, text) IS
  'Stock units (parts.primary_unit) in one p_unit of this part: 1 for the stock unit, else the part''s single parts_unit_conversions factor for that unit (compared through unit_name_key). P0001 sentences when there is no conversion, or two that disagree. Frozen onto a PO line at insert; never re-read for an existing line.';

REVOKE EXECUTE ON FUNCTION public.part_unit_factor(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.part_unit_factor(uuid, text) TO authenticated, service_role;


-- ============================================================================
-- 2. The two shared predicates: late, and a line's amount
-- ============================================================================
-- IMMUTABLE and taking the caller's date, like is_job_late: the database is UTC and would
-- call a PO late hours early for a shop in the Americas. Mirrored in TypeScript and pinned
-- by __tests__/fixtures/vendorPoLateCases.json. Accepts the PO statuses (sent,
-- partially_received) and the line statuses (open, partially_received): a draft was never
-- promised, and received / closed / no_receipt owe nothing.
CREATE OR REPLACE FUNCTION public.is_vendor_purchase_order_late(
    p_status      text,
    p_expected_on date,
    p_today       date
) RETURNS boolean
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
AS $fn$
    SELECT COALESCE(p_status IN ('sent', 'open', 'partially_received'), false)
       AND p_expected_on IS NOT NULL
       AND p_today IS NOT NULL
       AND p_expected_on < p_today
$fn$;

COMMENT ON FUNCTION public.is_vendor_purchase_order_late(text, date, date) IS
  'The single definition of a late vendor purchase order (or line): still owed something (status sent, open or partially_received) and its expected date is before the CALLER''s local date. Expected = vendor_purchase_order_status.next_expected_on for a PO, vendor_purchase_order_line_status.expected_on for a line. p_today is never CURRENT_DATE. Mirrored in TypeScript (lib/purchasing/late.ts) and pinned by __tests__/fixtures/vendorPoLateCases.json. Called by the insights AI as public.is_vendor_purchase_order_late(status, next_expected_on, $2).';

REVOKE EXECUTE ON FUNCTION public.is_vendor_purchase_order_late(text, date, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_vendor_purchase_order_late(text, date, date)
    TO authenticated, service_role, jigged_ai_readonly;


-- Money: a line amount is round(qty x price, 2); a PO total is the sum of line amounts.
-- One SQL function, a TypeScript mirror (lib/purchasing/amount.ts) and the Python
-- QuickBooks builder, all pinned by __tests__/fixtures/vendorPoAmountCases.json.
CREATE OR REPLACE FUNCTION public.vendor_po_line_amount(p_quantity numeric, p_unit_price numeric)
RETURNS numeric
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
AS $fn$
    SELECT CASE WHEN p_quantity IS NULL OR p_unit_price IS NULL THEN NULL
                ELSE round(p_quantity * p_unit_price, 2) END
$fn$;

COMMENT ON FUNCTION public.vendor_po_line_amount(numeric, numeric) IS
  'A vendor PO line''s amount: round(quantity x unit_price, 2), NULL when the price is to be confirmed. A PO''s total is the SUM of these, never a rounding of the unrounded sum. Mirrored in lib/purchasing/amount.ts and the Python QuickBooks builder; pinned by __tests__/fixtures/vendorPoAmountCases.json.';

REVOKE EXECUTE ON FUNCTION public.vendor_po_line_amount(numeric, numeric) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.vendor_po_line_amount(numeric, numeric)
    TO authenticated, service_role, jigged_ai_readonly;


-- ============================================================================
-- 3. company_address_block_snapshot -- our shop, as a ship-to
-- ============================================================================
-- The AddressSnapshot shape vendor_address_block_snapshot and address_block_snapshot
-- produce (types/documentSnapshot.ts), from the company's own letterhead columns. NULL when
-- the company has no address on file, so the PDF prints "(No address on file)".
CREATE OR REPLACE FUNCTION public.company_address_block_snapshot(p_company_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE
           WHEN c.address_line1 IS NULL AND c.address_line2 IS NULL AND c.city IS NULL
            AND c.state IS NULL AND c.postal_code IS NULL THEN NULL
           ELSE jsonb_build_object(
             'address_line1', c.address_line1,
             'address_line2', c.address_line2,
             'city',          c.city,
             'state',         c.state,
             'postal_code',   c.postal_code,
             'country',       c.country,
             'attention_to',  NULL)
         END
    FROM public.companies c
   WHERE c.id = p_company_id;
$fn$;

COMMENT ON FUNCTION public.company_address_block_snapshot(uuid) IS
  'The company''s own address as an AddressSnapshot (types/documentSnapshot.ts), the ship-to of a purchase order or RFQ shipped to our shop. NULL when the company has no address. Internal: called from the purchasing SECURITY DEFINER RPCs.';

REVOKE EXECUTE ON FUNCTION public.company_address_block_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.company_address_block_snapshot(uuid) TO service_role;


-- ============================================================================
-- 4. next_purchasing_document_number -- the mint
-- ============================================================================
-- Called inside the create RPCs, in their transaction. The row lock is held to commit, so
-- concurrent creates serialise (the second blocks, then reads the advanced counter: no
-- 23505), and a rolled-back create consumes nothing. A number that already exists -- an
-- archived PO keeps its number -- is skipped, so a number is never reissued.
CREATE OR REPLACE FUNCTION public.next_purchasing_document_number(p_company_id uuid, p_document_kind text)
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
    v_prefix  text;
    v_next    bigint;
    v_digits  integer;
    v_number  text;
    v_guard   integer := 0;
BEGIN
    IF p_document_kind NOT IN ('vendor_purchase_order', 'vendor_rfq') THEN
        RAISE EXCEPTION 'Unknown purchasing document kind %', p_document_kind USING ERRCODE = 'XX000';
    END IF;

    INSERT INTO public.purchasing_document_series (company_id, document_kind, prefix)
    VALUES (p_company_id, p_document_kind,
            CASE p_document_kind WHEN 'vendor_purchase_order' THEN 'PO-' ELSE 'RFQ-' END)
    ON CONFLICT (company_id, document_kind) DO NOTHING;

    SELECT s.prefix, s.next_number, s.min_digits INTO v_prefix, v_next, v_digits
      FROM public.purchasing_document_series s
     WHERE s.company_id = p_company_id AND s.document_kind = p_document_kind
       FOR UPDATE;

    LOOP
        -- greatest(): plain lpad would TRUNCATE a number longer than min_digits.
        v_number := v_prefix || lpad(v_next::text, greatest(v_digits, length(v_next::text)), '0');

        IF p_document_kind = 'vendor_purchase_order' AND char_length(v_number) > 11 THEN
            RAISE EXCEPTION 'The next PO number, %, would be longer than 11 characters, which QuickBooks Desktop cannot hold. Change the prefix or the next number in Purchasing settings.',
                v_number USING ERRCODE = 'P0001';
        END IF;

        EXIT WHEN NOT (
            CASE p_document_kind
              WHEN 'vendor_purchase_order' THEN EXISTS (
                  SELECT 1 FROM public.vendor_purchase_orders h
                   WHERE h.company_id = p_company_id AND h.po_number = v_number)
              ELSE EXISTS (
                  SELECT 1 FROM public.vendor_rfqs r
                   WHERE r.company_id = p_company_id AND r.rfq_number = v_number)
            END);

        v_next := v_next + 1;
        v_guard := v_guard + 1;
        IF v_guard > 100000 THEN
            RAISE EXCEPTION 'Could not find an unused % number', p_document_kind USING ERRCODE = 'XX000';
        END IF;
    END LOOP;

    UPDATE public.purchasing_document_series
       SET next_number = v_next + 1
     WHERE company_id = p_company_id AND document_kind = p_document_kind;

    RETURN v_number;
END
$fn$;

COMMENT ON FUNCTION public.next_purchasing_document_number(uuid, text) IS
  'Mint the next vendor PO or RFQ number for a company: prefix || the counter zero-padded to min_digits (never truncated), under a FOR UPDATE lock on the series row held to commit. Skips a number that already exists; never reissues one; a rolled-back create consumes nothing. Refuses a PO number over 11 characters (QuickBooks Desktop). Internal: called only by the create RPCs.';

REVOKE EXECUTE ON FUNCTION public.next_purchasing_document_number(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.next_purchasing_document_number(uuid, text) TO service_role;


-- ============================================================================
-- 5. The vendor-visible document, and the QuickBooks-pushed projection
-- ============================================================================
-- WHAT THE VENDOR SEES, and nothing else. Its md5 decides the revision bump: after a send,
-- the first save that changes it bumps the revision once. Deliberately OUT: the revision
-- number itself, promised dates, closed state, internal notes, price_source,
-- expects_receipt, timestamps and ids. The save keys that change it, which the vendor-visible
-- field list the UI and the DB tests share (lib/purchasing/vendorPoVisibleFields.ts) mirrors:
--   header  vendor_id (-> vendor_name), vendor_address_id (-> vendor_address),
--           vendor_contact_id (-> vendor_contact), ship_to (-> kind, name, address),
--           ordered_on, need_by_on, payment_terms, ship_via, notes_to_vendor.
--           terms_and_conditions prints too, but it is the copy taken from the series at
--           create and no save key changes it.
--   lines   adding or removing a line, part_id (-> part_name), description,
--           vendor_part_number, quantity, unit, unit_price, need_by_on, cert_required,
--           job_id (-> job_number), job_operation_id (-> operation_label),
--           work_center_id (-> work_center_name)
-- trim_scale keeps the hash about values: 5 and 5.0 are the same quantity.
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_document(p_vendor_purchase_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT jsonb_build_object(
           'po_number',            h.po_number,
           'vendor_id',            h.vendor_id,
           'vendor_name',          h.vendor_name,
           'vendor_address',       h.vendor_address,
           'vendor_contact',       h.vendor_contact,
           'ship_to_kind',         h.ship_to_kind,
           'ship_to_name',         h.ship_to_name,
           'ship_to_address',      h.ship_to_address,
           'ordered_on',           h.ordered_on,
           'need_by_on',           h.need_by_on,
           'payment_terms',        h.payment_terms,
           'ship_via',             h.ship_via,
           'notes_to_vendor',      h.notes_to_vendor,
           'terms_and_conditions', h.terms_and_conditions,
           'lines', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'line_number',        l.line_number,
                      'part_name',          l.part_name,
                      'description',        l.description,
                      'vendor_part_number', l.vendor_part_number,
                      'quantity',           trim_scale(l.quantity),
                      'unit',               l.unit,
                      'unit_price',         trim_scale(l.unit_price),
                      'need_by_on',         l.need_by_on,
                      'cert_required',      l.cert_required,
                      'job_number',         l.job_number,
                      'operation_label',    l.operation_label,
                      'work_center_name',   l.work_center_name
                    ) ORDER BY l.line_number)
               FROM public.vendor_purchase_order_lines l
              WHERE l.vendor_purchase_order_id = h.id), '[]'::jsonb))
    FROM public.vendor_purchase_orders h
   WHERE h.id = p_vendor_purchase_order_id;
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_document(uuid) IS
  'The vendor-visible document of a purchase order: what prints for the vendor, minus the revision number. Stored verbatim in vendor_purchase_order_revisions at Mark as sent; its md5 (vendor_purchase_order_document_hash) decides the once-per-send-cycle revision bump. Excludes promised dates, closed state, internal notes, price_source, expects_receipt and ids, so none of those can bump the revision. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_document(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_document(uuid) TO service_role;


CREATE OR REPLACE FUNCTION public.vendor_purchase_order_document_hash(p_vendor_purchase_order_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT md5(public.vendor_purchase_order_document(p_vendor_purchase_order_id)::text);
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_document_hash(uuid) IS
  'md5 of vendor_purchase_order_document(). jsonb renders canonically (sorted keys), so equal documents hash equal. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_document_hash(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_document_hash(uuid) TO service_role;


-- WHAT THE QUICKBOOKS PUSH SENDS (plan section 3.11), as Jigged data. Every writer hashes
-- this before and after and bumps content_version when it moved, so "out of date in
-- QuickBooks" is exact without a trigger and without asking QuickBooks. In: the number, the
-- revision (PrivateNote "Jigged PO-1042 Rev 2"), vendor, TxnDate, the header need-by
-- (QBD expectedDate), terms, ship via, notes to vendor (Memo / vendorMessage), the ship-to
-- block, closed, and per line its kind (-> setup item), the description fields, quantity,
-- unit, rate and line close. Out: receipts, internal notes, promised dates, T&Cs
-- (they reach QuickBooks only through the revision they bump).
CREATE OR REPLACE FUNCTION public.vendor_purchase_order_pushed_projection(p_vendor_purchase_order_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT jsonb_build_object(
           'po_number',       h.po_number,
           'revision',        h.revision,
           'vendor_id',       h.vendor_id,
           'ordered_on',      h.ordered_on,
           'need_by_on',      h.need_by_on,
           'payment_terms',   h.payment_terms,
           'ship_via',        h.ship_via,
           'notes_to_vendor', h.notes_to_vendor,
           'ship_to_name',    h.ship_to_name,
           'ship_to_address', h.ship_to_address,
           'closed',          h.closed_at IS NOT NULL,
           'lines', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id',                 l.id,
                      'line_number',        l.line_number,
                      'line_kind',          l.line_kind,
                      'part_name',          l.part_name,
                      'description',        l.description,
                      'vendor_part_number', l.vendor_part_number,
                      'quantity',           trim_scale(l.quantity),
                      'unit',               l.unit,
                      'unit_price',         trim_scale(l.unit_price),
                      'job_number',         l.job_number,
                      'operation_label',    l.operation_label,
                      'closed',             l.closed_at IS NOT NULL
                    ) ORDER BY l.line_number)
               FROM public.vendor_purchase_order_lines l
              WHERE l.vendor_purchase_order_id = h.id), '[]'::jsonb))
    FROM public.vendor_purchase_orders h
   WHERE h.id = p_vendor_purchase_order_id;
$fn$;

COMMENT ON FUNCTION public.vendor_purchase_order_pushed_projection(uuid) IS
  'The Jigged fields a QuickBooks PO push sends: number, revision, vendor, ordered_on, need_by_on, terms, ship via, notes to vendor, ship-to, closed; per line id, number, kind, part name, description, vendor P/N, quantity, unit, price, job number, operation label, closed. Every purchasing writer compares its md5 before and after and bumps vendor_purchase_orders.content_version when it moved. Receipts, internal notes, promised dates and T&Cs are not in it. Internal.';

REVOKE EXECUTE ON FUNCTION public.vendor_purchase_order_pushed_projection(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_purchase_order_pushed_projection(uuid) TO service_role;


-- ============================================================================
-- 6. quickbooks_purchase_order_state -- the one derived word the views need
-- ============================================================================
-- The status view carries quickbooks_state (not_sent / in_quickbooks / out_of_date /
-- pending / needs_checking / failed). The link table is exempt from the insights AI and
-- denied to it outright, and a security_invoker view reading it would fail for that role.
-- So the state is computed here, as owner, and only for a PO in a company the caller may
-- see: a member's company, or the insights sandbox's jigged.company_id (the same scope its
-- ai_readonly_select policies use). The backend and the platform's own logins see every
-- company, as they do every table: the request's role is service_role (PostgREST sets the
-- `role` setting per request, and SECURITY DEFINER changes current_user, not that), or the
-- session itself is postgres / supabase_admin. It returns one word and no QuickBooks id.
--
-- The link considered is the one for the company's CURRENT QuickBooks file when one is
-- connected (a PO pushed to an old file is not in the new one), else the newest.
--
-- Named after the quickbooks_purchase_order_links table it reads. Browser-callable on
-- purpose (the security_invoker status view calls it as the browser), so it is on
-- function_execute_leaks()'s allowlist with that reason.
CREATE OR REPLACE FUNCTION public.quickbooks_purchase_order_state(p_vendor_purchase_order_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE
           WHEN k.id IS NULL                    THEN 'not_sent'
           WHEN k.status = 'needs_verification' THEN 'needs_checking'
           WHEN k.status = 'pending'            THEN 'pending'
           WHEN k.status = 'error'              THEN 'failed'
           WHEN h.content_version > COALESCE(k.pushed_content_version, -1) THEN 'out_of_date'
           ELSE 'in_quickbooks'
         END
    FROM public.vendor_purchase_orders h
    LEFT JOIN LATERAL (
        SELECT COALESCE(
                 (SELECT c.realm_id FROM public.quickbooks_connections c WHERE c.company_id = h.company_id),
                 (SELECT d.conductor_end_user_id FROM public.quickbooks_desktop_connections d
                   WHERE d.company_id = h.company_id)) AS realm_id
    ) cur ON true
    LEFT JOIN LATERAL (
        SELECT l.id, l.status, l.pushed_content_version
          FROM public.quickbooks_purchase_order_links l
         WHERE l.vendor_purchase_order_id = h.id
           AND (cur.realm_id IS NULL OR l.realm_id = cur.realm_id)
         ORDER BY l.updated_at DESC
         LIMIT 1
    ) k ON true
   WHERE h.id = p_vendor_purchase_order_id
     AND (h.company_id IN (SELECT public.get_user_company_ids())
          OR h.company_id = NULLIF(current_setting('jigged.company_id', true), '')::uuid
          OR current_setting('role', true) = 'service_role'
          OR session_user IN ('postgres', 'supabase_admin'));
$fn$;

COMMENT ON FUNCTION public.quickbooks_purchase_order_state(uuid) IS
  'One word for a vendor PO''s QuickBooks state: not_sent, in_quickbooks, out_of_date (content_version > the link''s pushed_content_version), pending, needs_checking (a Desktop outcome nobody has verified) or failed. SECURITY DEFINER because quickbooks_purchase_order_links is denied to the insights AI, whose views call this; it answers only for a PO in a company the caller is a member of, the sandbox''s jigged.company_id, a service_role request or a postgres / supabase_admin session (NULL otherwise), and returns no QuickBooks id. Never calls QuickBooks.';

REVOKE EXECUTE ON FUNCTION public.quickbooks_purchase_order_state(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.quickbooks_purchase_order_state(uuid)
    TO authenticated, service_role, jigged_ai_readonly;


-- ============================================================================
-- 7. vendor_purchase_order_line_status -- every line's progress, in one place
-- ============================================================================
-- Part lines are measured in STOCK units, so progress is exact: ordered = quantity x the
-- frozen factor, received = the sum of live receipts' stock_quantity. Outside lines are
-- measured from their LINKED SLIPS (live receipts on live slips; a short-closed slip owes
-- nothing, the 20260906005725 per-slip rule). Other lines count quantity only.
--
-- status, first match wins:
--   draft               the PO was never sent
--   received            received >= ordered (over-receipt reads received; "+N" is the UI's)
--   closed              the line, or the whole PO, was closed short
--   no_receipt          an "other" line that never arrives (freight, a fee)
--   partially_received  something has arrived
--   open                nothing yet
-- expected_on: part and other lines COALESCE(promised_on, need_by_on); outside lines the
-- earliest due-back date among linked slips still out, else need_by_on.
CREATE VIEW public.vendor_purchase_order_line_status
WITH (security_invoker = true) AS
SELECT
    m.id,
    m.company_id,
    m.vendor_purchase_order_id,
    m.po_number,
    m.vendor_id,
    m.line_number,
    m.line_kind,
    m.part_id,
    m.part_name,
    m.description,
    m.vendor_part_number,
    m.quantity,
    m.unit,
    m.stock_unit,
    m.stock_factor,
    m.unit_price,
    m.price_source,
    m.need_by_on,
    m.promised_on,
    m.cert_required,
    m.expects_receipt,
    m.job_id,
    m.job_number,
    m.job_part_id,
    m.job_operation_id,
    m.operation_label,
    m.vendor_service_id,
    m.service_name,
    m.work_center_id,
    m.work_center_name,
    m.closed_at,
    m.created_at,
    m.updated_at,
    m.is_archived,
    m.status,
    m.ordered_stock_quantity,
    m.received_quantity,
    m.received_stock_quantity,
    m.sent_quantity,
    m.at_vendor_quantity,
    m.linked_slip_count,
    m.remaining_quantity,
    m.remaining_stock_quantity,
    CASE WHEN m.status IN ('open', 'partially_received') AND NOT m.is_archived
         THEN m.remaining_quantity ELSE 0 END                               AS open_quantity,
    CASE WHEN m.line_kind <> 'part' THEN NULL
         WHEN m.status IN ('open', 'partially_received') AND NOT m.is_archived
         THEN m.remaining_stock_quantity ELSE 0 END                         AS open_stock_quantity,
    m.over_received_quantity,
    m.expected_on,
    public.vendor_po_line_amount(m.quantity, m.unit_price)                  AS amount,
    public.vendor_po_line_amount(
        CASE WHEN m.status IN ('open', 'partially_received') AND NOT m.is_archived
             THEN m.remaining_quantity ELSE 0 END,
        m.unit_price)                                                       AS open_amount
FROM (
    SELECT
        d.*,
        CASE
            WHEN d.po_issued_at IS NULL                                  THEN 'draft'
            WHEN d.is_fully_received                                     THEN 'received'
            WHEN d.closed_at IS NOT NULL OR d.po_closed_at IS NOT NULL   THEN 'closed'
            WHEN NOT d.expects_receipt                                   THEN 'no_receipt'
            WHEN d.has_received                                          THEN 'partially_received'
            ELSE 'open'
        END AS status
    FROM (
        SELECT
            q.*,
            CASE q.line_kind
                WHEN 'part'            THEN trim_scale(q.received_stock_quantity / q.stock_factor)
                WHEN 'outside_service' THEN q.slip_received_quantity
                ELSE q.receipt_quantity
            END AS received_quantity,
            CASE q.line_kind
                WHEN 'part'            THEN q.received_stock_quantity >= q.ordered_stock_quantity
                WHEN 'outside_service' THEN q.slip_received_quantity >= q.quantity
                ELSE q.receipt_quantity >= q.quantity
            END AS is_fully_received,
            CASE q.line_kind
                WHEN 'part'            THEN q.received_stock_quantity > 0
                WHEN 'outside_service' THEN q.slip_received_quantity > 0
                ELSE q.receipt_quantity > 0
            END AS has_received,
            CASE WHEN NOT q.expects_receipt THEN 0
                 WHEN q.line_kind = 'part' THEN trim_scale(
                     greatest(0, q.ordered_stock_quantity - q.received_stock_quantity) / q.stock_factor)
                 WHEN q.line_kind = 'outside_service' THEN greatest(0, q.quantity - q.slip_received_quantity)
                 ELSE greatest(0, q.quantity - q.receipt_quantity)
            END AS remaining_quantity,
            CASE WHEN q.line_kind = 'part'
                 THEN greatest(0, q.ordered_stock_quantity - q.received_stock_quantity)
            END AS remaining_stock_quantity,
            CASE q.line_kind
                WHEN 'part' THEN trim_scale(
                    greatest(0, q.received_stock_quantity - q.ordered_stock_quantity) / q.stock_factor)
                WHEN 'outside_service' THEN greatest(0, q.slip_received_quantity - q.quantity)
                ELSE greatest(0, q.receipt_quantity - q.quantity)
            END AS over_received_quantity,
            CASE WHEN q.line_kind = 'outside_service'
                 THEN COALESCE(q.next_due_back_on, q.need_by_on)
                 ELSE COALESCE(q.promised_on, q.need_by_on)
            END AS expected_on
        FROM (
            SELECT
                l.id, l.company_id, l.vendor_purchase_order_id, h.po_number, h.vendor_id,
                l.line_number, l.line_kind, l.part_id, l.part_name, l.description,
                l.vendor_part_number, l.quantity, l.unit, l.stock_unit, l.stock_factor,
                l.unit_price, l.price_source, l.need_by_on, l.promised_on, l.cert_required,
                l.expects_receipt, l.job_id, l.job_number, l.job_part_id, l.job_operation_id,
                l.operation_label, l.vendor_service_id, l.service_name, l.work_center_id,
                l.work_center_name, l.closed_at, l.created_at, l.updated_at,
                h.issued_at                                   AS po_issued_at,
                h.closed_at                                   AS po_closed_at,
                (h.deleted_at IS NOT NULL)                    AS is_archived,
                CASE WHEN l.line_kind = 'part' THEN l.quantity * l.stock_factor END
                                                              AS ordered_stock_quantity,
                rc.receipt_quantity,
                CASE WHEN l.line_kind = 'part' THEN rc.received_stock_quantity END
                                                              AS received_stock_quantity,
                CASE WHEN l.line_kind = 'outside_service' THEN os.sent_quantity END
                                                              AS sent_quantity,
                os.slip_received_quantity,
                CASE WHEN l.line_kind = 'outside_service' THEN os.at_vendor_quantity END
                                                              AS at_vendor_quantity,
                os.next_due_back_on,
                os.linked_slip_count
            FROM public.vendor_purchase_order_lines l
            JOIN public.vendor_purchase_orders h ON h.id = l.vendor_purchase_order_id
            LEFT JOIN LATERAL (
                SELECT COALESCE(sum(r.quantity), 0)       AS receipt_quantity,
                       COALESCE(sum(r.stock_quantity), 0) AS received_stock_quantity
                  FROM public.vendor_purchase_order_receipts r
                 WHERE r.vendor_purchase_order_line_id = l.id
                   AND r.voided_at IS NULL
            ) rc ON true
            LEFT JOIN LATERAL (
                SELECT COALESCE(sum(s.quantity), 0)                          AS sent_quantity,
                       COALESCE(sum(COALESCE(back.good, 0)), 0)              AS slip_received_quantity,
                       COALESCE(sum(CASE WHEN s.closed_at IS NOT NULL THEN 0
                                         ELSE greatest(0, s.quantity - COALESCE(back.good, 0)) END), 0)
                                                                             AS at_vendor_quantity,
                       min(s.due_back_on) FILTER (
                           WHERE s.closed_at IS NULL AND s.quantity > COALESCE(back.good, 0))
                                                                             AS next_due_back_on,
                       count(*)                                              AS linked_slip_count
                  FROM public.outside_shipments s
                  LEFT JOIN LATERAL (
                      SELECT sum(x.quantity_good) AS good
                        FROM public.outside_shipment_receipts x
                       WHERE x.outside_shipment_id = s.id
                         AND x.voided_at IS NULL
                  ) back ON true
                 WHERE s.vendor_purchase_order_line_id = l.id
                   AND s.voided_at IS NULL
            ) os ON true
        ) q
    ) d
) m;

COMMENT ON VIEW public.vendor_purchase_order_line_status IS
  'Every vendor PO line''s progress, computed once for the UI, MCP and the insights AI. status: draft / received / closed / no_receipt / partially_received / open (first match). Part lines measure in stock units (ordered_stock_quantity, received_stock_quantity, open_stock_quantity) and also report purchase units; outside-service lines measure from their linked live slips (sent_quantity, at_vendor_quantity, received_quantity); other lines count quantity. open_quantity / open_amount are what is still to arrive, 0 once received, closed or archived. expected_on feeds is_vendor_purchase_order_late. security_invoker; no actor columns.';


-- ============================================================================
-- 8. vendor_purchase_order_status -- every PO's status, in one place
-- ============================================================================
-- status, first match wins (labels Draft / Sent / Partly received / Received / Closed):
--   draft               never sent
--   closed              closed by hand, or nothing outstanding and a line closed short
--   received            at least one line expects a receipt, and every such line is received
--   partially_received  anything received or closed
--   sent
-- A PO whose lines all expect no receipt stays Sent until it is closed.
CREATE VIEW public.vendor_purchase_order_status
WITH (security_invoker = true) AS
SELECT
    h.id,
    h.company_id,
    h.po_number,
    h.vendor_id,
    h.vendor_name,
    h.ship_to_kind,
    h.ship_to_vendor_id,
    h.ship_to_customer_id,
    h.ship_to_name,
    h.ordered_on,
    h.need_by_on,
    h.payment_terms,
    h.ship_via,
    h.revision,
    h.sent_revision,
    h.issued_at,
    h.last_sent_at,
    h.content_version,
    h.closed_at,
    h.vendor_rfq_id,
    h.created_at,
    h.updated_at,
    h.deleted_at,
    (h.deleted_at IS NOT NULL) AS is_archived,
    CASE
        WHEN h.issued_at IS NULL THEN 'draft'
        WHEN h.closed_at IS NOT NULL THEN 'closed'
        WHEN COALESCE(a.outstanding_line_count, 0) = 0 AND COALESCE(a.closed_line_count, 0) > 0
            THEN 'closed'
        WHEN COALESCE(a.receivable_line_count, 0) > 0
             AND a.received_line_count = a.receivable_line_count
            THEN 'received'
        WHEN COALESCE(a.received_any_line_count, 0) > 0 OR COALESCE(a.closed_line_count, 0) > 0
            THEN 'partially_received'
        ELSE 'sent'
    END AS status,
    COALESCE(a.line_count, 0)                AS line_count,
    COALESCE(a.outstanding_line_count, 0)    AS outstanding_line_count,
    a.next_expected_on,
    COALESCE(a.ordered_amount, 0)            AS ordered_amount,
    COALESCE(a.open_amount, 0)               AS open_amount,
    COALESCE(a.has_unpriced_lines, false)    AS has_unpriced_lines,
    (h.issued_at IS NOT NULL AND h.revision > h.sent_revision) AS has_unsent_changes,
    public.quickbooks_purchase_order_state(h.id) AS quickbooks_state,
    COALESCE(a.job_ids, '{}'::uuid[])        AS job_ids,
    COALESCE(a.job_numbers, '{}'::text[])    AS job_numbers,
    concat_ws(' ', h.po_number, h.vendor_name, a.search_terms) AS search_text
FROM public.vendor_purchase_orders h
LEFT JOIN LATERAL (
    SELECT
        count(*)                                                             AS line_count,
        count(*) FILTER (WHERE ls.status IN ('open', 'partially_received')) AS outstanding_line_count,
        count(*) FILTER (WHERE ls.status = 'closed')                         AS closed_line_count,
        count(*) FILTER (WHERE ls.expects_receipt)                           AS receivable_line_count,
        count(*) FILTER (WHERE ls.expects_receipt AND ls.status = 'received') AS received_line_count,
        count(*) FILTER (WHERE ls.received_quantity > 0)                     AS received_any_line_count,
        min(ls.expected_on) FILTER (WHERE ls.status IN ('open', 'partially_received'))
                                                                             AS next_expected_on,
        sum(ls.amount)                                                       AS ordered_amount,
        sum(ls.open_amount)                                                  AS open_amount,
        bool_or(ls.unit_price IS NULL)                                       AS has_unpriced_lines,
        array_agg(DISTINCT ls.job_id) FILTER (WHERE ls.job_id IS NOT NULL)   AS job_ids,
        array_agg(DISTINCT ls.job_number) FILTER (WHERE ls.job_number IS NOT NULL) AS job_numbers,
        string_agg(concat_ws(' ', ls.part_name, ls.vendor_part_number, ls.job_number), ' '
                   ORDER BY ls.line_number)                                  AS search_terms
      FROM public.vendor_purchase_order_line_status ls
     WHERE ls.vendor_purchase_order_id = h.id
) a ON true;

COMMENT ON VIEW public.vendor_purchase_order_status IS
  'Every vendor PO''s derived status (draft / sent / partially_received / received / closed, first match), plus line_count, outstanding_line_count, next_expected_on (earliest expected date over outstanding lines; late = is_vendor_purchase_order_late(status, next_expected_on, today)), ordered_amount (sum of line amounts), open_amount (value still to arrive at the PO price), has_unpriced_lines, has_unsent_changes (revision > sent_revision), quickbooks_state, job_ids / job_numbers, and search_text (number, vendor, part numbers, vendor part numbers, job numbers). Lists filter is_archived. security_invoker; no actor columns.';


-- ============================================================================
-- 9. part_on_order, part_vendor_last_purchase, vendor_rfq_status
-- ============================================================================
-- On order is SENT, open, unarchived part lines, in stock units. Drafts are separate. A line
-- whose frozen stock unit no longer matches the part's primary unit cannot be added into
-- either honestly, so it is counted in unit_mismatch_line_count instead.
CREATE VIEW public.part_on_order
WITH (security_invoker = true) AS
SELECT
    p.company_id,
    p.id AS part_id,
    p.primary_unit AS stock_unit,
    COALESCE(sum(ls.open_stock_quantity) FILTER (
        WHERE ls.status IN ('open', 'partially_received') AND ls.stock_unit = p.primary_unit), 0)
                                                                    AS on_order_quantity,
    COALESCE(sum(ls.quantity * ls.stock_factor) FILTER (
        WHERE ls.status = 'draft' AND ls.stock_unit = p.primary_unit), 0)
                                                                    AS on_draft_quantity,
    min(ls.expected_on) FILTER (
        WHERE ls.status IN ('open', 'partially_received') AND ls.stock_unit = p.primary_unit)
                                                                    AS next_expected_on,
    count(*) FILTER (WHERE ls.status IN ('open', 'partially_received')) AS open_line_count,
    count(*) FILTER (WHERE ls.status = 'draft')                         AS draft_line_count,
    count(*) FILTER (
        WHERE ls.status IN ('draft', 'open', 'partially_received')
          AND ls.stock_unit IS DISTINCT FROM p.primary_unit)            AS unit_mismatch_line_count
FROM public.vendor_purchase_order_line_status ls
JOIN public.parts p ON p.id = ls.part_id
WHERE ls.line_kind = 'part'
  AND NOT ls.is_archived
  AND ls.status IN ('draft', 'open', 'partially_received')
GROUP BY p.company_id, p.id, p.primary_unit;

COMMENT ON VIEW public.part_on_order IS
  'Per part, what is coming: on_order_quantity (sent, open, unarchived part lines, in the part''s stock unit), on_draft_quantity (draft lines, shown separately), next_expected_on, open_line_count, draft_line_count, and unit_mismatch_line_count (lines whose frozen stock unit no longer matches the part''s primary unit, so they are in neither total). Only POs in Jigged count. Parts with nothing coming have no row. security_invoker.';


-- "Last PO price": the newest priced line on a SENT, unarchived PO per (part, vendor).
CREATE VIEW public.part_vendor_last_purchase
WITH (security_invoker = true) AS
SELECT DISTINCT ON (l.part_id, h.vendor_id)
    l.company_id,
    l.part_id,
    h.vendor_id,
    h.id               AS vendor_purchase_order_id,
    h.po_number,
    h.ordered_on,
    l.id               AS vendor_purchase_order_line_id,
    l.quantity,
    l.unit,
    l.stock_unit,
    l.stock_factor,
    l.unit_price,
    round(l.unit_price / l.stock_factor, 6) AS unit_price_per_stock_unit
FROM public.vendor_purchase_order_lines l
JOIN public.vendor_purchase_orders h ON h.id = l.vendor_purchase_order_id
WHERE l.line_kind = 'part'
  AND l.unit_price IS NOT NULL
  AND h.issued_at IS NOT NULL
  AND h.deleted_at IS NULL
ORDER BY l.part_id, h.vendor_id, h.ordered_on DESC, h.issued_at DESC, l.line_number DESC;

COMMENT ON VIEW public.part_vendor_last_purchase IS
  '"Last PO price": per (part, vendor), the newest priced part line on a sent, unarchived vendor PO (by ordered_on, then send time), with its price per purchase unit and per stock unit. Drafts and archived POs never count. security_invoker.';


-- RFQ status, first match wins: closed, awarded (every line has an awarded response),
-- quoted (any response), sent (any invitation sent), draft.
CREATE VIEW public.vendor_rfq_status
WITH (security_invoker = true) AS
SELECT
    r.id,
    r.company_id,
    r.rfq_number,
    r.title,
    r.needed_by_on,
    r.respond_by_on,
    r.closed_at,
    r.created_at,
    r.updated_at,
    r.deleted_at,
    (r.deleted_at IS NOT NULL) AS is_archived,
    CASE
        WHEN r.closed_at IS NOT NULL THEN 'closed'
        WHEN COALESCE(lc.line_count, 0) > 0 AND lc.awarded_line_count = lc.line_count THEN 'awarded'
        WHEN COALESCE(ic.responded_count, 0) > 0 THEN 'quoted'
        WHEN COALESCE(ic.sent_count, 0) > 0 THEN 'sent'
        ELSE 'draft'
    END AS status,
    COALESCE(lc.line_count, 0)          AS line_count,
    COALESCE(lc.awarded_line_count, 0)  AS awarded_line_count,
    COALESCE(ic.invited_count, 0)       AS invited_count,
    COALESCE(ic.sent_count, 0)          AS sent_count,
    COALESCE(ic.declined_count, 0)      AS declined_count,
    COALESCE(ic.responded_count, 0)     AS responded_count
FROM public.vendor_rfqs r
LEFT JOIN LATERAL (
    SELECT count(*) AS line_count,
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.vendor_rfq_responses x
                WHERE x.vendor_rfq_line_id = ln.id AND x.awarded_at IS NOT NULL)) AS awarded_line_count
      FROM public.vendor_rfq_lines ln
     WHERE ln.vendor_rfq_id = r.id
) lc ON true
LEFT JOIN LATERAL (
    SELECT count(*)                                         AS invited_count,
           count(*) FILTER (WHERE i.sent_at IS NOT NULL)     AS sent_count,
           count(*) FILTER (WHERE i.declined_at IS NOT NULL) AS declined_count,
           count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM public.vendor_rfq_responses x
                WHERE x.vendor_rfq_invitation_id = i.id))   AS responded_count
      FROM public.vendor_rfq_invitations i
     WHERE i.vendor_rfq_id = r.id
) ic ON true;

COMMENT ON VIEW public.vendor_rfq_status IS
  'Every vendor RFQ''s derived status (draft / sent / quoted / awarded / closed, first match) with line, awarded-line, invited, sent, declined and responded counts. Lists filter is_archived. security_invoker.';


-- The views arrive with the table default privileges (TRUNCATE, REFERENCES, TRIGGER,
-- MAINTAIN for the browser roles, SELECT for the AI). Named revokes, explicit grants.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
    public.vendor_purchase_order_line_status, public.vendor_purchase_order_status,
    public.part_on_order, public.part_vendor_last_purchase, public.vendor_rfq_status
FROM anon, authenticated;

GRANT SELECT ON TABLE
    public.vendor_purchase_order_line_status, public.vendor_purchase_order_status,
    public.part_on_order, public.part_vendor_last_purchase, public.vendor_rfq_status
TO authenticated, service_role, jigged_ai_readonly;


-- ============================================================================
-- 10. The stock RPCs return the ledger row they wrote
-- ============================================================================
-- add_stock_at_location: newest body 20260906153732, WORD FOR WORD, plus `v_txn`, the
-- RETURNING on the ledger insert and 'transaction_id' in the result. Nothing else differs.
CREATE OR REPLACE FUNCTION public.add_stock_at_location(
    p_part_id uuid,
    p_location_id uuid,
    p_quantity numeric,
    p_unit text,
    p_converted_quantity numeric,
    p_notes text DEFAULT NULL::text,
    p_operator_id uuid DEFAULT NULL::uuid,
    p_photo_path text DEFAULT NULL::text,
    p_heat_number text DEFAULT NULL::text,
    p_lot_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
    v_lot uuid; v_heat text;
    v_new_balance numeric; v_rollup numeric;
    v_started_tracking boolean := false;
    v_txn uuid;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, lot_tracked
      INTO v_company, v_item_name, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    -- The first real heat on an untraced part is the decision to trace it.
    -- Normalised the same way the ledger normalises, so "  " decides nothing.
    IF NOT v_tracked AND NULLIF(btrim(COALESCE(p_heat_number, '')), '') IS NOT NULL THEN
        -- BEFORE the insert below, so the stock arriving now lands in its own
        -- real lot and only the PRE-EXISTING lot-less balances are migrated.
        PERFORM public.set_part_lot_tracking(p_part_id, true);
        v_tracked := true;
        v_started_tracking := true;
    END IF;

    -- Mint on the way IN, so a tracked bar that arrives untagged is still storable.
    v_lot := public.resolve_lot(v_company, p_part_id, p_lot_id, p_heat_number, true, v_tracked);
    SELECT heat_number INTO v_heat FROM public.material_lots WHERE id = v_lot;

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, lot_id, quantity)
    VALUES (v_company, p_part_id, p_location_id, v_lot, p_converted_quantity)
    ON CONFLICT (part_id, location_id, lot_key)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_new_balance;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, operator_id, photo_path, heat_number, lot_id, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_notes, p_operator_id, p_photo_path, v_heat, v_lot, auth.uid())
    RETURNING id INTO v_txn;

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    -- `started_tracking` is returned so the UI can SAY what just happened. A part
    -- that silently begins demanding a heat on every removal is the surprise this
    -- whole design is trying to avoid; the dialog that caused it is the only place
    -- that can explain it at the moment it becomes true.
    RETURN jsonb_build_object('location_balance', v_new_balance, 'part_quantity', v_rollup,
                              'lot_id', v_lot, 'started_tracking', v_started_tracking,
                              'transaction_id', v_txn);
END;
$function$;

COMMENT ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text, uuid) IS
  'Stock a part into a location. Recording a heat on an untraced part turns tracking ON for it (and migrates its lot-less balances), because writing down a mill heat IS the decision to trace that part -- there is no separate setting. Resolves the lot -- an explicit p_lot_id, else the typed heat, else a minted code when the part is tracked, else none -- so the balance is keyed by (part, location, lot). Returns started_tracking so the caller can say what just happened, and transaction_id (the ledger row it wrote) so a vendor PO receipt can link it (20261110043700).';


-- deplete_stock_at_location: newest body 20260906121901, WORD FOR WORD (CREATE became
-- CREATE OR REPLACE), plus `v_txn`, the RETURNING on the ledger insert and 'transaction_id'.
CREATE OR REPLACE FUNCTION public.deplete_stock_at_location(
    p_part_id uuid,
    p_location_id uuid,
    p_quantity numeric,
    p_unit text,
    p_converted_quantity numeric,
    p_graceful boolean DEFAULT false,
    p_notes text DEFAULT NULL::text,
    p_job_id uuid DEFAULT NULL::uuid,
    p_job_operation_id uuid DEFAULT NULL::uuid,
    p_operator_id uuid DEFAULT NULL::uuid,
    p_heat_number text DEFAULT NULL::text,
    p_lot_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_primary_unit text; v_tracked boolean;
    v_lot uuid; v_heat text; v_sentinel constant uuid := '00000000-0000-0000-0000-000000000000';
    v_current numeric; v_new numeric; v_rollup numeric;
    v_discrepancy boolean := false; v_shortfall numeric := 0;
    v_notes text; v_disc_note text;
    v_txn uuid;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id, part_name, primary_unit, lot_tracked
      INTO v_company, v_item_name, v_primary_unit, v_tracked
      FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_location_id, v_company);

    -- NEVER mint on the way out. A take names material that is already here; minting
    -- would invent a lot to consume, which is how a free-text field became a heat
    -- nobody received. p_mint is false, so an unknown heat resolves to a real lot
    -- only if one exists.
    v_lot := public.resolve_lot(v_company, p_part_id, p_lot_id, p_heat_number, false, false);

    -- THE ENFORCEMENT, and the only place a movement is refused for a reason that is
    -- not arithmetic. A take off a tracked part must say WHICH heat left the shelf,
    -- because that is the figure the packing slip prints. It strands nobody:
    -- set_part_lot_tracking() gave every existing balance of a tracked part a lot in
    -- the same transaction that set the flag.
    IF v_tracked AND v_lot IS NULL THEN
        RAISE EXCEPTION 'This part is heat-tracked, so a removal has to say which heat it came from'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT heat_number INTO v_heat FROM public.material_lots WHERE id = v_lot;

    -- Scoped to the lot, through `lot_key` rather than an IS NOT DISTINCT FROM, so the
    -- unique index is used and an untracked part still matches its single NULL row.
    SELECT quantity INTO v_current
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_location_id
       AND lot_key = COALESCE(v_lot, v_sentinel)
       FOR UPDATE;
    v_current := COALESCE(v_current, 0);

    v_new := v_current - p_converted_quantity;
    v_notes := p_notes;

    IF v_new < 0 THEN
        IF p_graceful THEN
            v_shortfall := p_converted_quantity - v_current;
            v_new := 0;
            v_discrepancy := true;
            v_disc_note := format(
                '[DISCREPANCY: Confirmed %s %s, but only %s %s was available. Shortfall: %s %s]',
                p_converted_quantity, v_primary_unit, v_current, v_primary_unit, v_shortfall, v_primary_unit);
            v_notes := CASE WHEN v_notes IS NULL OR v_notes = '' THEN v_disc_note
                            ELSE v_notes || ' ' || v_disc_note END;
        ELSE
            RAISE EXCEPTION 'Insufficient stock at location (have %, need %)', v_current, p_converted_quantity
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF v_new = 0 THEN
        DELETE FROM public.part_location_stock
         WHERE part_id = p_part_id AND location_id = p_location_id
           AND lot_key = COALESCE(v_lot, v_sentinel);
    ELSE
        INSERT INTO public.part_location_stock (company_id, part_id, location_id, lot_id, quantity)
        VALUES (v_company, p_part_id, p_location_id, v_lot, v_new)
        ON CONFLICT (part_id, location_id, lot_key) DO UPDATE SET quantity = EXCLUDED.quantity;
    END IF;

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, job_id, job_operation_id, operator_id, notes, has_discrepancy,
         heat_number, lot_id, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_location_id, p_job_id, p_job_operation_id, p_operator_id, v_notes, v_discrepancy,
         v_heat, v_lot, auth.uid())
    RETURNING id INTO v_txn;

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object(
        'location_balance', v_new, 'part_quantity', v_rollup,
        'has_discrepancy', v_discrepancy, 'shortfall', v_shortfall, 'lot_id', v_lot,
        'transaction_id', v_txn);
END;
$function$;

COMMENT ON FUNCTION public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text, uuid) IS
  'Take stock out of a location, from ONE lot. Refuses a lot-less take off a lot-tracked part -- the only non-arithmetic refusal in this module, and it can strand nobody because set_part_lot_tracking() gives every existing balance a lot the moment the flag goes on. Never mints: a take names material already here, and minting on the way out is how free text became a heat nobody received. Returns transaction_id, the ledger row it wrote, so a voided vendor PO receipt can link its reversal (20261110043700).';


-- ============================================================================
-- Guards -- the 20260906153732 guard, repeated for BOTH functions
-- ============================================================================
-- CREATE OR REPLACE keeps the ACL, but "keeps" is the claim being tested: the allowlist in
-- function_execute_leaks() names both, so a lost grant would not show there as a leak -- it
-- would show as a browser that can no longer receive or take stock, at runtime, in a shop.
DO $guard$
DECLARE
    v_name  text;
    v_sig   text;
    v_count integer;
BEGIN
    FOR v_name, v_sig IN
        SELECT * FROM (VALUES
            ('add_stock_at_location',
             'public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text, uuid)'),
            ('deplete_stock_at_location',
             'public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text, uuid)')
        ) AS t(n, s)
    LOOP
        SELECT count(*) INTO v_count
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;
        IF v_count <> 1 THEN
            RAISE EXCEPTION '% must have exactly one overload (has %)', v_name, v_count;
        END IF;
        IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
            RAISE EXCEPTION 'authenticated lost EXECUTE on %', v_name;
        END IF;
        IF has_function_privilege('anon', v_sig, 'EXECUTE') THEN
            RAISE EXCEPTION 'anon must not execute %', v_name;
        END IF;
        IF pg_get_functiondef(v_sig::regprocedure) NOT LIKE '%''transaction_id'', v_txn%' THEN
            RAISE EXCEPTION '% does not return transaction_id after this migration', v_name;
        END IF;
    END LOOP;
END
$guard$;
