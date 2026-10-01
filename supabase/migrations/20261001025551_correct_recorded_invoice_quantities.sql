-- Self-service correction of what Jigged RECORDED an invoice as billing.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE BUG THIS CLOSES
-- ═══════════════════════════════════════════════════════════════════════════════
-- Before partial invoicing (20260702011324) an invoice billed the whole job, so a
-- shop that wanted to bill half pushed from Jigged and then edited the invoice DOWN
-- in QuickBooks. 20260702011324 section 7b backfilled one line per job_part at the
-- part's FULL CURRENT quantity for every legacy `created` invoice, on the stated
-- assumption that "current job_parts.quantity == the invoiced qty". For those
-- hand-edited invoices that assumption is false, so Jigged recorded MORE as billed
-- than QuickBooks ever billed. qty_invoiceable (api/services/quickbooks.py:1276) is
-- then 0 forever and the job can never be invoiced again — reported live on J-0018,
-- and fixed until now by hand-editing production.
--
-- Neither existing escape hatch fits:
--   * Raising job_parts.quantity reopens the part (trigger_recompute_jp_invoicing_on_qty)
--     but the ORDERED quantity is correct; inflating it to unlock billing corrupts
--     a second number to work around the first.
--   * Voiding in QuickBooks reopens it via the mirror (20260903203624), but the
--     invoice is a real, sent, often paid document; it reopens the WHOLE quantity
--     rather than the un-billed remainder; and QuickBooks Desktop has no mirror.
--
-- There is deliberately NO backfill. CLAUDE.md requires data-at-rest problems to be
-- fixed at rest, and names the exception this falls under: only the shop knows what
-- its QuickBooks invoice actually billed. qb_total_amt cannot settle it either — it
-- is tax-inclusive and so not comparable with Jigged's line total
-- (docs/modules/invoicing.md:102, 121-124). So the fix is a tool the shop drives,
-- not a guess this migration makes on its behalf.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS NOT
-- ═══════════════════════════════════════════════════════════════════════════════
-- It never touches the QuickBooks document. It corrects Jigged's NOTE of what that
-- document billed. The invoice keeps its number, its date, its payment mirror and
-- its place in the activity rail.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Close a latent write hole on the line-item table
-- ─────────────────────────────────────────────────────────────────────────────
-- quickbooks_invoice_line_items was created 2026-07-02 with RLS on and a SELECT
-- policy only, on the reasoning that "writes are service-role only ... so only a
-- SELECT policy is needed" (20260702011324:78-85). That left the TABLE GRANT
-- untouched, and the table predates 20260716025048, which revoked the permissive
-- default and says at :42 that it "ONLY AFFECTS FUTURE OBJECTS". So `authenticated`
-- still holds INSERT/UPDATE/DELETE here and the single thing denying a browser write
-- is the absence of a write policy — one policy away, with no CI check watching.
-- Its parent was closed properly on day one (20260620122700:138); match it, so the
-- RPC below is the only write path rather than merely the intended one.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.quickbooks_invoice_line_items
  FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Record that a correction happened
-- ─────────────────────────────────────────────────────────────────────────────
-- Same shape as voided_at / voided_by on this table, and for the same reason: this
-- repo has no audit table, it stamps the row. It also answers the question the next
-- person asks — why Jigged's line total no longer matches the invoice Jigged pushed.
-- A silent discrepancy is what caused this whole defect; a second silent one would
-- be the wrong lesson to draw from it.
ALTER TABLE public.quickbooks_invoice_links
    ADD COLUMN IF NOT EXISTS corrected_at timestamptz,
    ADD COLUMN IF NOT EXISTS corrected_by uuid;

COMMENT ON COLUMN public.quickbooks_invoice_links.corrected_at IS
  'When someone last corrected the per-part quantities Jigged recorded against this invoice (correct_invoice_recorded_quantities). NULL means the recorded quantities are still the ones the push wrote. The QuickBooks document itself is never edited by Jigged.';

COMMENT ON COLUMN public.quickbooks_invoice_links.corrected_by IS
  'auth.uid() of whoever last corrected the recorded quantities — an auth user id, like shipments.voided_by, NOT a user_company_access id like pushed_by. Deliberately no FK, matching voided_by: the record must outlive the membership row.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Bring both invoice tables under the billing write-gate
-- ─────────────────────────────────────────────────────────────────────────────
-- Both sit on tenant_tables_missing_write_gate()'s exempt list under the rationale
-- "writes never come from the browser" (20260825170421:246-252). The RPC below makes
-- that rationale false, which is EXACTLY the #645 shape the same list warns about
-- three lines up, where part_location_stock's exemption hid an ungated browser write
-- path for months (20260801150944:14-18).
--
-- Neither CI guard can see this on its own: tenant_tables_missing_write_gate() is
-- satisfied by the exemption, and definer_writers_missing_write_gate() only inspects
-- functions writing a table that HAS a billing_gate_insert policy — which an exempt
-- table never does (20260907234149). So the two tables come off the list and get the
-- gate, which turns an invisible-to-CI write path into a guarded one: from here, a
-- future SECURITY DEFINER function writing either table without consulting
-- company_can_write() fails the build.
--
-- The gate's policies are TO authenticated only, so the service-role push path and
-- apply_qbo_invoice_mirror are untouched, and reads stay open on both tables.
--
-- Body restated from 20260825170421 (the newest definition) minus the two entries.
-- CREATE OR REPLACE takes the WHOLE body, so basing this on anything older would
-- silently restore entries removed since.
CREATE OR REPLACE FUNCTION public.tenant_tables_missing_write_gate()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname NOT IN (
      -- identity / bootstrap (gating would block signup / team / preferences)
      'companies', 'user_company_access', 'user_preferences', 'system_admins',
      'invitations', 'demo_data_templates', 'waitlist', 'saved_insights', 'feedback',
      'company_billing',
      -- service-role-only / SELECT-only (writes never come from the browser).
      -- `part_location_stock` was removed from this list in 20260801150944: its
      -- writes DO come from the browser, through SECURITY DEFINER RPCs, and the
      -- exemption was what hid issue #645.
      -- `quickbooks_invoice_links` and `quickbooks_invoice_line_items` left the
      -- list HERE for the same reason: correct_invoice_recorded_quantities is a
      -- browser-callable SECURITY DEFINER writer, so "writes never come from the
      -- browser" stopped being true of them. Both are gated below.
      'auth_audit_log', 'job_fulfillment_audit',
      'company_order_counters', 'quickbooks_connections', 'quickbooks_customer_map',
      'quickbooks_desktop_connections', 'quickbooks_terms_cache',
      -- SECURITY DEFINER-only writers; see 20260728040701
      'note_views', 'operator_events',
      -- `operator_time_access_log` stood HERE, added 20260816203641 and carried
      -- forward by 20260818142814. The table is dropped in 20260825170421, so
      -- the entry goes with it. job_operation_intervals is unaffected: it IS
      -- gated (apply_billing_write_gate, 20260816203641), so it is satisfied by
      -- the policy-existence check below and never by this list.
      -- Append-only legal record, service-role write only
      'terms_acceptances'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = c.relname
        AND p.policyname = 'billing_gate_insert'
    )
  ORDER BY 1;
$$;

COMMENT ON FUNCTION public.tenant_tables_missing_write_gate() IS
  'Lists public tables with a company_id column that are neither billing-gated nor exempt. A CI test asserts this returns no rows, so a new tenant table left un-gated fails the build instead of silently bypassing billing.';

SELECT public.apply_billing_write_gate('public.quickbooks_invoice_links');
SELECT public.apply_billing_write_gate('public.quickbooks_invoice_line_items');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The correction itself
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER, not a direct Supabase write. CLAUDE.md's Supabase-first rule
-- cannot be satisfied here: both tables deny browser writes by construction (section
-- 1 above and 20260620122700:138), and total_price must stay round(quantity *
-- unit_price, 4) — nothing in the schema enforces that, so a client that supplies
-- both columns can make Jigged's revenue figure say anything. Computing it here is
-- what makes the narrow write safe. It is still not a FastAPI route: there is no
-- QuickBooks call, no secret and no third party in this path, so architecture.md
-- section 8.1's four criteria are all unmet.
--
-- Reopening is left entirely to the EXISTING triggers. Lowering a line fires
-- trigger_recompute_jp_invoicing_on_line_upd -> compute_job_part_invoicing_status ->
-- trigger_sync_job_invoicing_from_parts_upd, exactly as a push does; nothing here
-- writes invoicing_status, which no code outside those triggers is allowed to do
-- (docs/modules/jobs.md:261). The ordered cap is likewise left to
-- assert_invoice_not_over_ordered, which already fires BEFORE INSERT OR UPDATE OF
-- quantity (20260702011324:303-305) and excludes this invoice's own lines from the
-- comparison — so a reduction always passes and a raise is still capped at ordered.
CREATE OR REPLACE FUNCTION public.correct_invoice_recorded_quantities(
    p_invoice_link_id uuid,
    p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_user      uuid;
    v_company   uuid;
    v_job       uuid;
    v_status    text;
    v_voided    timestamptz;
    v_role      text;
    v_changed   integer := 0;
    v_removed   integer := 0;
    v_remaining numeric;
    v_over      text;
BEGIN
    v_user := auth.uid();
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'You must be signed in to correct an invoice.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Lock the invoice for the transaction. Two people correcting the same invoice
    -- would otherwise each compute "what will be left" against a row the other is
    -- changing, and the lower of the two totals would win silently.
    SELECT company_id, job_id, status, voided_at
      INTO v_company, v_job, v_status, v_voided
      FROM public.quickbooks_invoice_links
     WHERE id = p_invoice_link_id
       FOR UPDATE;

    -- Membership and existence answer together on purpose: a caller who is not a
    -- member must not be able to tell a missing invoice from someone else's.
    IF v_company IS NOT NULL THEN
        SELECT role INTO v_role
          FROM public.user_company_access
         WHERE user_id = v_user AND company_id = v_company;
    END IF;
    IF v_company IS NULL OR v_role IS NULL THEN
        RAISE EXCEPTION 'That invoice is not available.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Office roles only. Invoicing is already member-level rather than admin-only
    -- (api/routes/quickbooks_routes.py: push_invoice takes no require_admin), and the
    -- person who creates invoices is the person who finds one recorded wrong — so
    -- gating this to admin would simply rebuild the support escalation it removes.
    -- An operator has no business on an invoice either way.
    IF v_role = 'operator' THEN
        RAISE EXCEPTION 'Correcting an invoice is an office task.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- The billing gate, by hand and in plain sight. SECURITY DEFINER runs as the
    -- owner and so walks straight past the restrictive billing_gate_* policies
    -- section 3 just attached; burying this in a helper is how #645 happened
    -- (20260801150944:40-45), so the function says that it checked.
    IF NOT public.company_can_write(v_company) THEN
        RAISE EXCEPTION 'company % has no active subscription', v_company
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_status <> 'created' THEN
        RAISE EXCEPTION 'Only an invoice that reached QuickBooks has recorded quantities to correct.';
    END IF;
    IF v_voided IS NOT NULL THEN
        RAISE EXCEPTION 'This invoice already counts for nothing, so it has no recorded quantities to correct.';
    END IF;

    IF p_lines IS NULL
       OR jsonb_typeof(p_lines) <> 'array'
       OR jsonb_array_length(p_lines) = 0 THEN
        RAISE EXCEPTION 'No corrected quantities were supplied.';
    END IF;

    IF (SELECT count(DISTINCT e->>'job_part_id') FROM jsonb_array_elements(p_lines) e)
       <> jsonb_array_length(p_lines) THEN
        RAISE EXCEPTION 'The same part was corrected twice in one request.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_lines) e
         WHERE jsonb_typeof(e->'quantity') <> 'number'
            OR (e->>'quantity')::numeric < 0
    ) THEN
        RAISE EXCEPTION 'A corrected quantity must be zero or more.';
    END IF;

    -- Correcting edits what THIS invoice recorded. It can never name a part the
    -- invoice did not bill: that quantity belongs on a new invoice, which is what
    -- the whole feature exists to unblock.
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_lines) e
         WHERE NOT EXISTS (
             SELECT 1 FROM public.quickbooks_invoice_line_items ili
              WHERE ili.invoice_link_id = p_invoice_link_id
                AND ili.job_part_id = (e->>'job_part_id')::uuid
         )
    ) THEN
        RAISE EXCEPTION 'A corrected line does not belong to this invoice.';
    END IF;

    -- Cap each corrected line at what the job ordered, MINUS what other invoices
    -- already record against the same part. assert_invoice_not_over_ordered is the
    -- at-rest backstop for exactly this and it fires on UPDATE too
    -- (20260702011324:303-305), but it raises check_violation naming a job_part UUID,
    -- which friendlyErrorMessage passes straight through to the screen
    -- (lib/supabaseErrors.ts:546). Refusing here first means the shop reads a sentence
    -- about a part instead of an internal id, and the backstop stays untouched.
    SELECT string_agg(format('%s (at most %s)', v.part_name, v.headroom), ', '
                      ORDER BY v.part_name)
      INTO v_over
      FROM (
        SELECT COALESCE(p.part_name, 'that part') AS part_name,
               jp.quantity - COALESCE((
                 SELECT SUM(o.quantity)
                   FROM public.quickbooks_invoice_line_items o
                   JOIN public.quickbooks_invoice_links ol ON ol.id = o.invoice_link_id
                  WHERE o.job_part_id = jp.id
                    AND o.invoice_link_id <> p_invoice_link_id
                    AND ol.status = 'created'
                    AND ol.voided_at IS NULL), 0) AS headroom,
               (e->>'quantity')::numeric AS wanted
          FROM jsonb_array_elements(p_lines) e
          JOIN public.job_parts jp ON jp.id = (e->>'job_part_id')::uuid
          LEFT JOIN public.parts p ON p.id = jp.part_id
      ) v
     WHERE v.wanted > v.headroom;
    IF v_over IS NOT NULL THEN
        RAISE EXCEPTION 'That is more than the job ordered for %. Lower it and try again.', v_over;
    END IF;

    -- An invoice may not be corrected down to nothing at all. Beyond it being a
    -- strange record, derive_invoice_status reads "QuickBooks says 0 while Jigged's
    -- line total is > 0" as a void (docs/modules/invoicing.md:116, 126-129): drive
    -- Jigged's total to 0 and a genuinely voided QuickBooks invoice starts reading
    -- as PAID instead. Voiding is the operation for "this invoice counts for
    -- nothing", and it belongs in QuickBooks.
    SELECT COALESCE(SUM(q), 0) INTO v_remaining
      FROM (
        SELECT COALESCE(
                 (SELECT (e->>'quantity')::numeric
                    FROM jsonb_array_elements(p_lines) e
                   WHERE (e->>'job_part_id')::uuid = ili.job_part_id),
                 ili.quantity) AS q
          FROM public.quickbooks_invoice_line_items ili
         WHERE ili.invoice_link_id = p_invoice_link_id
      ) s;
    IF v_remaining <= 0 THEN
        RAISE EXCEPTION 'An invoice has to record at least some quantity. To make this invoice count for nothing, void it in QuickBooks.';
    END IF;

    -- A line corrected to zero is deleted rather than stored: qb_ili_quantity_positive
    -- forbids quantity = 0, and a line that billed nothing is not a line.
    -- trigger_recompute_jp_invoicing_on_line_del reopens that part.
    WITH submitted AS (
        SELECT (e->>'job_part_id')::uuid AS job_part_id,
               (e->>'quantity')::numeric AS quantity
          FROM jsonb_array_elements(p_lines) e
    )
    DELETE FROM public.quickbooks_invoice_line_items ili
     USING submitted s
     WHERE ili.invoice_link_id = p_invoice_link_id
       AND ili.job_part_id = s.job_part_id
       AND s.quantity = 0;
    GET DIAGNOSTICS v_removed = ROW_COUNT;

    -- total_price is recomputed here, never accepted from the caller: it is Jigged's
    -- revenue figure and the price is LOCKED once invoiced, so unit_price stays the
    -- snapshot the push took. round(..., 4) is the convention the column was created
    -- with (20260702011324:56). Unchanged lines are skipped so a re-submit of the
    -- same numbers costs no trigger work.
    WITH submitted AS (
        SELECT (e->>'job_part_id')::uuid AS job_part_id,
               (e->>'quantity')::numeric AS quantity
          FROM jsonb_array_elements(p_lines) e
    )
    UPDATE public.quickbooks_invoice_line_items ili
       SET quantity    = s.quantity,
           total_price = round(s.quantity * ili.unit_price, 4),
           updated_at  = now()
      FROM submitted s
     WHERE ili.invoice_link_id = p_invoice_link_id
       AND ili.job_part_id = s.job_part_id
       AND s.quantity > 0
       AND ili.quantity <> s.quantity;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    -- Stamp the link only when something moved, so "corrected" never claims an edit
    -- that was a no-op. This touches neither status nor voided_at, so
    -- trigger_recompute_jp_invoicing_on_link does not fire and the line-level
    -- triggers above remain the only recompute.
    IF v_changed > 0 OR v_removed > 0 THEN
        UPDATE public.quickbooks_invoice_links
           SET corrected_at = now(),
               corrected_by = v_user,
               updated_at   = now()
         WHERE id = p_invoice_link_id;
    END IF;

    RETURN jsonb_build_object(
        'job_id',        v_job,
        'lines_changed', v_changed,
        'lines_removed', v_removed
    );
END;
$function$;

COMMENT ON FUNCTION public.correct_invoice_recorded_quantities(uuid, jsonb) IS
  'Correct the per-part quantities Jigged RECORDED against one created invoice, so its ledger matches what the QuickBooks document actually billed; the un-billed remainder then reopens for invoicing through the existing triggers. Never touches QuickBooks. Office roles only (admin or user), billing-gated by hand because SECURITY DEFINER bypasses the billing_gate_* policies, capped at ordered by assert_invoice_not_over_ordered, and refuses to leave an invoice recording nothing (that is a void, and it belongs in QuickBooks). p_lines is [{job_part_id, quantity}] naming lines this invoice already has; quantity 0 removes one.';

-- Browser-callable on purpose: this is the whole point of the feature. The ON
-- FUNCTIONS default stopped auto-granting in 20260801024552, so the GRANT is
-- required rather than decorative, and anon is named explicitly rather than assumed.
REVOKE EXECUTE ON FUNCTION public.correct_invoice_recorded_quantities(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_invoice_recorded_quantities(uuid, jsonb)
  TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Let CI see that the new RPC's EXECUTE grant is deliberate
-- ─────────────────────────────────────────────────────────────────────────────
-- function_execute_leaks() lists every SECURITY DEFINER function in `public` that
-- anon or authenticated can execute, against a reviewed allowlist; a browser-callable
-- definer function that is not named there fails the build. This one is meant to be
-- callable -- that is the feature -- so it is named, with the reason.
--
-- Body restated from 20260907203956, the NEWEST definition. CREATE OR REPLACE takes
-- the WHOLE body, and this function has been reverted four times by restating an
-- older copy (20260828124806:225-231), so basing it on anything else silently drops
-- every entry added since.
CREATE OR REPLACE FUNCTION public.function_execute_leaks()
RETURNS TABLE(function_name text, role_name text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p.proname::text, r.rolname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    AND p.proname NOT IN (
      -- Named in an RLS policy: the browser cannot query the table without it.
      'company_can_write', 'get_operator_access_id', 'get_user_company_ids',
      'is_company_admin', 'is_system_admin',
      -- Called directly from application code (utils/*Access.ts, app/, hooks/).
      -- NB: enable_location_tracking / disable_location_tracking are deliberately absent.
      -- 20260802015101 dropped both RPCs; re-listing them here would leave the allowlist
      -- naming functions that no longer exist, which is how this list rots.
      'accept_invitation', 'add_stock_at_location', 'adjust_stock_at_location',
      'create_demo_company', 'create_shipment_with_line_items', 'delete_location',
      'deplete_stock_at_location', 'log_note_views', 'log_operator_event',
      'note_viewers', 'reset_demo_company', 'sync_demo_access', 'transfer_stock',
      -- Added 20260801181116: the count sheet's put-away calls it directly
      -- (`bulkPutAway` in utils/inventoryLocationsAccess.ts).
      'bulk_put_away',
      -- Added 20260803043406: the Me tab dismisses its recognition block through it
      -- (`markHelpfulSeen` in utils/operatorAccess.ts).
      'mark_reactions_seen',
      -- Added 20260810142715: the Storage page's create/duplicate path calls it
      -- directly (`materializeLocationSpec` in utils/inventoryLocationsAccess.ts).
      -- Atomicity IS the feature — the loop it replaces could leave a partial
      -- tree behind an opaque error (#618) — so it cannot be decomposed either.
      'create_location_tree',
      -- Added 20260815192344: the Storage page's `Change layout` calls it directly
      -- (`applyLocationLayout` in utils/inventoryLocationsAccess.ts). Create,
      -- rename, re-parent, move stock and delete must be ONE transaction, and two
      -- of those steps are illegal outside one that defers the container/bin
      -- invariant. `subdivide_location` left the list in the same migration: it is
      -- dropped there, and an allowlist naming functions that no longer exist is
      -- how this list rots.
      'apply_location_layout',
      -- Added 20260816203641: operator cycle-time capture. That migration added
      -- FIVE; get_operator_time_detail was the fifth and is dropped in
      -- 20260825170421, so it leaves this list for the subdivide_location reason --
      -- an allowlist naming functions that no longer exist is how the list rots.
      -- cancel_operation_interval joined the group in 20260826105251: the step
      -- screen calls it directly to discard a running timer.
      -- void_open_intervals_for_operation joined in 20260828124806: the OFFICE
      -- discards someone else's, from the job page's Complete and the Still-running
      -- card's Stop.
      -- pause_operation_interval joined HERE (20260907203755): the step screen
      -- calls it directly to close a span the operator means to come back to. It
      -- is DEFINER for the same reason its two siblings are -- the browser has no
      -- INSERT or UPDATE grant on ended_at/close_reason at all, by construction
      -- (20260816203641's column-scoped GRANT UPDATE names three columns and these
      -- are not among them) -- and it asserts ownership itself.
      -- get_paused_operations joined in 20260907203956: the office card reads
      -- the other half of the forgotten-work channel. Admin-checked inside and
      -- returns no operator identity, exactly like get_open_intervals.
      'start_operation_interval', 'close_operation_interval',
      'cancel_operation_interval', 'pause_operation_interval',
      'void_open_intervals_for_operation',
      'get_operation_actuals', 'get_open_intervals', 'get_paused_operations',
      -- Added 20260903203741: outside-processing shipping. BOTH are browser
      -- callable on purpose. create_outside_shipment IS the send -- it mints
      -- VPS-{jobBase}-{n} under a per-job advisory lock and freezes the vendor
      -- address block, neither of which a PostgREST insert can do, which is why
      -- outside_shipments grants the browser SELECT and nothing else.
      -- void_outside_shipment must void the receipts BEFORE the shipment in one
      -- transaction, or the op -> part -> job cascade crosses the
      -- pg_trigger_depth() > 2 bail and freezes the job status silently.
      -- Both derive company_id from the row rather than taking it as an
      -- argument, and both call company_can_write by hand.
      'create_outside_shipment', 'void_outside_shipment',
      -- Added 20260906121901: the part page's heat-tracking toggle
      -- (`setPartLotTracking`). DEFINER because setting the flag and migrating the
      -- part's lot-less balances into a PRE-TRACKING lot must be one transaction.
      'set_part_lot_tracking',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      -- (get_ready_operations_for_station -> get_running_operation_ids_for_station,
      --  added 20260826010648, and -> get_paused_operation_ids_for_station,
      --  added 20260907203956 -- same contract, ids and nothing else)
      'next_order_number', 'get_running_operation_ids_for_station',
      'get_paused_operation_ids_for_station',
      -- Added 20261001025551: the job page's Invoices menu calls it directly
      -- (`correctInvoiceRecordedQuantities` in utils/quickbooksAccess.ts) to fix
      -- what Jigged RECORDED an invoice as billing. DEFINER because both invoice
      -- tables deny browser writes by construction and because total_price must be
      -- recomputed server-side from the locked unit_price snapshot -- a caller that
      -- supplied it could make Jigged's revenue figure say anything. Same contract
      -- as create_outside_shipment / void_outside_shipment above: it derives
      -- company_id from the row rather than taking it as an argument, and it calls
      -- company_can_write by hand.
      'correct_invoice_recorded_quantities'
    )
  ORDER BY 1, 2;
$$;
