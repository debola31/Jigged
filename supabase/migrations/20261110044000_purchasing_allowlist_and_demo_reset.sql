-- ============================================================================
-- PURCHASING (5 of 5): the execute allowlist, the demo reset, and the final check
-- ============================================================================
-- 1. function_execute_leaks(): every SECURITY DEFINER function a browser role can execute
--    must be on its reviewed allowlist. The purchasing write doors and the QuickBooks-state
--    read helper join it, each with its reason. Rebuilt from its newest body
--    (20261109163801) word for word plus those entries; CREATE OR REPLACE keeps the ACL.
-- 2. reset_demo_company(): rebuilt from its newest body (20260906182521) word for word plus
--    the purchasing deletes (before the jobs block, which PO lines RESTRICT) and the heat
--    lots and certs (after the ledger, before parts). The latter fixes a reset that would
--    abort for any demo user who had recorded a heat: material_lots RESTRICTs parts and
--    nothing deleted it.
-- 3. A final assertion that every function the purchasing migrations added exists once,
--    with exactly the grants intended, and that no guard flags a purchasing object.
-- ============================================================================


-- ============================================================================
-- 1. function_execute_leaks
-- ============================================================================
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
      -- Added 20261109163801: PostgREST's db_pre_request hook. PostgREST runs it AS THE
      -- REQUESTING ROLE before every Data API call, so anon and authenticated must be able to
      -- execute it or every request fails. It takes no arguments, returns nothing and reveals
      -- nothing: it only refuses an OAuth-issued token (an AI assistant's) that arrives without
      -- the MCP gateway key. DEFINER because it reads private.mcp_gateway_keys.
      'mcp_token_binding',
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
      'correct_invoice_recorded_quantities',
      -- Added 20261110044000: purchasing. Every purchasing table grants the browser SELECT
      -- and nothing else, so these SECURITY DEFINER RPCs ARE the write doors: numbering and
      -- the frozen snapshots need service-role-only helpers, the revision and QuickBooks
      -- content versions need one writer, and decision 3 needs the office role enforced
      -- in the database (RLS has no role predicate). Each one derives its company from the
      -- row (only the settings save and RFQ create take p_company_id, and assert it), calls
      -- assert_office_member (P0001 for non-members, 42501 for operators), calls
      -- company_can_write by hand, and scopes every id it is handed to its own document.
      'save_part_vendor', 'archive_part_vendor',
      'create_vendor_purchase_order', 'save_vendor_purchase_order',
      'set_vendor_purchase_order_state', 'set_vendor_purchase_order_line_state',
      'receive_vendor_purchase_order', 'void_vendor_purchase_order_receipt',
      'set_outside_shipment_vendor_purchase_order_line',
      'create_vendor_rfq', 'save_vendor_rfq', 'set_vendor_rfq_state',
      'set_vendor_rfq_invitation_state', 'save_vendor_rfq_responses', 'award_vendor_rfq',
      'apply_part_cost_from_vendor',
      -- Added 20261110044000: the one word vendor_purchase_order_status shows for QuickBooks
      -- (not_sent, in_quickbooks, out_of_date, pending, needs_checking, failed). DEFINER
      -- because quickbooks_purchase_order_links is denied to the insights AI, which reads
      -- that view. Read-only, writes nothing, returns no QuickBooks id, and answers only
      -- for a PO in a company the caller is a member of (or the sandbox's jigged.company_id,
      -- or a service_role request): anyone else gets NULL.
      'quickbooks_purchase_order_state'
    )
  ORDER BY 1, 2;
$$;


-- ============================================================================
-- 2. reset_demo_company
-- ============================================================================
-- seed_demo_data needs no change: the template's preferred vendors list themselves in
-- part_vendors through ensure_preferred_vendor_is_listed as the parts are inserted.
CREATE OR REPLACE FUNCTION public.reset_demo_company(p_source_company_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_demo_company_id uuid;
BEGIN
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    SELECT demo_company_id INTO v_demo_company_id
    FROM companies WHERE id = p_source_company_id;

    IF v_demo_company_id IS NULL THEN
        RAISE EXCEPTION 'No demo company exists for company: %', p_source_company_id;
    END IF;

    -- Delete leaves-first. The order is not cosmetic: six of these are RESTRICT
    -- parents (shipment_line_items -> job_parts, part_location_stock -> parts,
    -- work_center_attachments -> work_centers, quickbooks_invoice_line_items ->
    -- job_parts, notes -> work_centers, job_materials -> parts), and because the
    -- whole body is one transaction a single RESTRICT violation rolled the
    -- entire reset back — deleting nothing, permanently, for any demo that had
    -- shipped something. That was #675.

    -- notes and their children (notes RESTRICTs work_centers; note_* CASCADE
    -- from notes, but explicit beats relying on it)
    DELETE FROM note_reactions WHERE company_id = v_demo_company_id;
    DELETE FROM note_views     WHERE company_id = v_demo_company_id;
    DELETE FROM note_media     WHERE company_id = v_demo_company_id;
    DELETE FROM notes          WHERE company_id = v_demo_company_id;

    -- fulfillment + invoicing edges, above job_parts
    DELETE FROM job_fulfillment_audit WHERE company_id = v_demo_company_id;
    DELETE FROM shipment_line_items
        WHERE shipment_id IN (SELECT id FROM shipments WHERE company_id = v_demo_company_id);
    DELETE FROM shipments      WHERE company_id = v_demo_company_id;
    DELETE FROM quickbooks_invoice_line_items WHERE company_id = v_demo_company_id;
    DELETE FROM quickbooks_invoice_links      WHERE company_id = v_demo_company_id;

    -- purchasing (20261110044000), leaves first and BEFORE the jobs block: PO lines
    -- RESTRICT job_operations, job_parts and jobs; receipts RESTRICT their lines; RFQ
    -- responses RESTRICT their lines and invitations. Removing a PO line clears any
    -- outside slip pointing at it (ON DELETE SET NULL). The QuickBooks push records hang
    -- off the POs and vendors; quickbooks_purchasing_setup is KEPT, like the connections
    -- it belongs to. The series goes, so numbering restarts at PO-0001 / RFQ-0001.
    DELETE FROM quickbooks_purchase_order_line_links WHERE company_id = v_demo_company_id;
    DELETE FROM quickbooks_purchase_order_links      WHERE company_id = v_demo_company_id;
    DELETE FROM quickbooks_vendor_map                WHERE company_id = v_demo_company_id;
    DELETE FROM vendor_rfq_responses            WHERE company_id = v_demo_company_id;
    DELETE FROM vendor_rfq_invitations          WHERE company_id = v_demo_company_id;
    DELETE FROM vendor_rfq_lines                WHERE company_id = v_demo_company_id;
    DELETE FROM part_vendor_price_breaks        WHERE company_id = v_demo_company_id;
    DELETE FROM vendor_purchase_order_receipts  WHERE company_id = v_demo_company_id;
    DELETE FROM vendor_purchase_order_revisions WHERE company_id = v_demo_company_id;
    DELETE FROM vendor_purchase_order_lines     WHERE company_id = v_demo_company_id;
    DELETE FROM vendor_purchase_orders          WHERE company_id = v_demo_company_id;
    DELETE FROM vendor_rfqs                     WHERE company_id = v_demo_company_id;
    DELETE FROM part_vendors                    WHERE company_id = v_demo_company_id;
    DELETE FROM purchasing_document_series      WHERE company_id = v_demo_company_id;

    -- inventory ledger and balances (part_location_stock RESTRICTs parts)
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM part_location_stock    WHERE company_id = v_demo_company_id;

    -- heat lots and their certs (20261110044000): never deleted here before, and
    -- material_lots RESTRICTs parts, so a demo that ever recorded a heat could not be
    -- reset. After the ledger and balances that point at them, before parts.
    DELETE FROM lot_certificates WHERE company_id = v_demo_company_id;
    DELETE FROM material_lots    WHERE company_id = v_demo_company_id;

    -- jobs
    -- Outside shipping: receipts before shipments (the FK cascades, but every
    -- sibling here is explicit and an implicit cascade is a reviewability
    -- regression -- you cannot see what a reset removes by reading it).
    DELETE FROM outside_shipment_receipts WHERE company_id = v_demo_company_id;
    DELETE FROM outside_shipments         WHERE company_id = v_demo_company_id;
    DELETE FROM job_operation_completions WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials  WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM job_parts      WHERE company_id = v_demo_company_id;
    DELETE FROM jobs           WHERE company_id = v_demo_company_id;

    -- quotes
    DELETE FROM quote_line_items WHERE company_id = v_demo_company_id;
    DELETE FROM quotes           WHERE company_id = v_demo_company_id;

    -- routings, then parts and their children
    DELETE FROM routing_operations
        WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    DELETE FROM parts_bom
        WHERE parent_part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id)
           OR child_part_id  IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    -- One ladder now: the pricing-tier delete below carries the cost with it.
    DELETE FROM part_pricing_tiers WHERE company_id = v_demo_company_id;
    DELETE FROM parts_unit_conversions
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM part_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM part_comments    WHERE company_id = v_demo_company_id;
    DELETE FROM parts            WHERE company_id = v_demo_company_id;

    -- storage locations, now that nothing holds a balance in one
    DELETE FROM inventory_locations WHERE company_id = v_demo_company_id;

    -- work centers (work_center_attachments RESTRICTs them)
    DELETE FROM work_center_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM work_centers            WHERE company_id = v_demo_company_id;
    -- Before vendors: vendor_services.vendor_id is ON DELETE RESTRICT, so a
    -- demo reset would fail on the first vendor that performs a service.
    DELETE FROM vendor_services         WHERE company_id = v_demo_company_id;

    -- parties
    DELETE FROM customer_carrier_accounts WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;  -- contacts/addresses CASCADE
    DELETE FROM vendors   WHERE company_id = v_demo_company_id;  -- vendor_contacts + vendor_addresses CASCADE

    -- odds and ends the demo owns
    DELETE FROM operator_events  WHERE company_id = v_demo_company_id;
    DELETE FROM ai_chat_queries  WHERE company_id = v_demo_company_id;
    DELETE FROM saved_insights   WHERE company_id = v_demo_company_id;
    DELETE FROM company_custom_units WHERE company_id = v_demo_company_id;

    -- Reset the shared Q-/J- counter so the re-seeded demo reads Q-0001 / J-0009
    -- again rather than climbing on every reset.
    DELETE FROM company_order_counters WHERE company_id = v_demo_company_id;

    -- Deliberately KEPT: user_company_access (the membership Reset is documented
    -- to preserve), company_billing, invitations, quickbooks_connections,
    -- ai_config, auth_audit_log, feedback.

    -- Flags are not data the reset wipes — they are re-mirrored from the source,
    -- so Reset restores the demo's product surface as well as its rows.
    PERFORM sync_demo_features(p_source_company_id, v_demo_company_id);

    PERFORM seed_demo_data(v_demo_company_id, p_user_id);
END;
$function$;


-- ============================================================================
-- 3. Every purchasing function: once, with the grants intended
-- ============================================================================
DO $check$
DECLARE
    v_name    text;
    v_count   integer;
    v_oid     oid;
    v_def     text;
    v_definer boolean;
    v_functions text[];
    v_tables    text[];
BEGIN
    -- The browser's write doors: DEFINER, authenticated yes, anon no, the role check and the
    -- billing literal in their own bodies.
    FOREACH v_name IN ARRAY ARRAY[
        'save_part_vendor', 'archive_part_vendor',
        'create_vendor_purchase_order', 'save_vendor_purchase_order',
        'set_vendor_purchase_order_state', 'set_vendor_purchase_order_line_state',
        'receive_vendor_purchase_order', 'void_vendor_purchase_order_receipt',
        'set_outside_shipment_vendor_purchase_order_line',
        'create_vendor_rfq', 'save_vendor_rfq', 'set_vendor_rfq_state',
        'set_vendor_rfq_invitation_state', 'save_vendor_rfq_responses', 'award_vendor_rfq',
        'apply_part_cost_from_vendor'
    ] LOOP
        SELECT count(*), min(p.oid::text)::oid, bool_and(p.prosecdef) INTO v_count, v_oid, v_definer
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;
        IF v_count <> 1 THEN
            RAISE EXCEPTION '% must exist exactly once (found %)', v_name, v_count;
        END IF;
        IF NOT v_definer THEN
            RAISE EXCEPTION '% must be SECURITY DEFINER: the browser has no table writes', v_name;
        END IF;
        IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% must be executable by authenticated', v_name;
        END IF;
        IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% must not be executable by anon', v_name;
        END IF;
        v_def := pg_get_functiondef(v_oid);
        IF v_def NOT LIKE '%company_can_write%' THEN
            RAISE EXCEPTION '% must call company_can_write in its own body', v_name;
        END IF;
        IF v_def NOT LIKE '%assert_office_member%' THEN
            RAISE EXCEPTION '% must call assert_office_member', v_name;
        END IF;
    END LOOP;

    -- Shared reads: INVOKER, authenticated yes, anon no.
    FOREACH v_name IN ARRAY ARRAY[
        'preview_part_cost_from_vendor', 'is_vendor_purchase_order_late', 'vendor_po_line_amount',
        'unit_name_key', 'part_unit_factor'
    ] LOOP
        SELECT count(*), min(p.oid::text)::oid, bool_or(p.prosecdef) INTO v_count, v_oid, v_definer
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;
        IF v_count <> 1 THEN
            RAISE EXCEPTION '% must exist exactly once (found %)', v_name, v_count;
        END IF;
        IF v_definer THEN
            RAISE EXCEPTION '% must be SECURITY INVOKER', v_name;
        END IF;
        IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
           OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% must be executable by authenticated and not by anon', v_name;
        END IF;
    END LOOP;

    -- What the insights AI writes into its own SQL, or reaches through a view.
    FOREACH v_name IN ARRAY ARRAY[
        'is_vendor_purchase_order_late', 'vendor_po_line_amount', 'quickbooks_purchase_order_state'
    ] LOOP
        SELECT min(p.oid::text)::oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;
        IF v_oid IS NULL OR NOT has_function_privilege('jigged_ai_readonly', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% must be executable by jigged_ai_readonly', v_name;
        END IF;
    END LOOP;
    SELECT min(p.oid::text)::oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'quickbooks_purchase_order_state';
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'quickbooks_purchase_order_state must be executable by authenticated and not by anon';
    END IF;

    -- Internal helpers and trigger functions: no browser role may execute them.
    FOREACH v_name IN ARRAY ARRAY[
        'assert_office_member', 'purchasing_assert_keys', 'company_address_block_snapshot',
        'next_purchasing_document_number', 'vendor_purchase_order_document',
        'vendor_purchase_order_document_hash', 'vendor_purchase_order_pushed_projection',
        'vendor_purchase_order_lock_jobs', 'vendor_purchase_order_resolve_ship_to',
        'vendor_purchase_order_vendor_party', 'vendor_purchase_order_insert',
        'vendor_purchase_order_upsert_line', 'vendor_purchase_order_write_lines',
        'vendor_purchase_order_settle_versions', 'vendor_purchase_order_receipt_result',
        'part_vendor_write', 'vendor_rfq_upsert_line', 'vendor_rfq_invite',
        'ensure_preferred_vendor_is_listed', 'assert_outside_shipment_line_matches',
        'outside_receipt_settles_vendor_purchase_order'
    ] LOOP
        SELECT count(*), min(p.oid::text)::oid INTO v_count, v_oid
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;
        IF v_count <> 1 THEN
            RAISE EXCEPTION '% must exist exactly once (found %)', v_name, v_count;
        END IF;
        IF has_function_privilege('authenticated', v_oid, 'EXECUTE')
           OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% is internal: no browser role may execute it', v_name;
        END IF;
    END LOOP;

    -- And the guards this work had to satisfy hold for what it added. SCOPED to the purchasing
    -- objects on purpose: CI runs every guard unscoped against a fresh replay, and an unscoped
    -- check here would abort this migration in production over drift that has nothing to do
    -- with purchasing (a hand-made backup table with a company_id column is enough).
    v_functions := ARRAY[
        'save_part_vendor', 'archive_part_vendor',
        'create_vendor_purchase_order', 'save_vendor_purchase_order',
        'set_vendor_purchase_order_state', 'set_vendor_purchase_order_line_state',
        'receive_vendor_purchase_order', 'void_vendor_purchase_order_receipt',
        'set_outside_shipment_vendor_purchase_order_line',
        'create_vendor_rfq', 'save_vendor_rfq', 'set_vendor_rfq_state',
        'set_vendor_rfq_invitation_state', 'save_vendor_rfq_responses', 'award_vendor_rfq',
        'apply_part_cost_from_vendor', 'quickbooks_purchase_order_state',
        'ensure_preferred_vendor_is_listed', 'outside_receipt_settles_vendor_purchase_order',
        'create_outside_shipment', 'add_stock_at_location', 'deplete_stock_at_location'];
    v_tables := ARRAY[
        'purchasing_document_series',
        'vendor_rfqs', 'vendor_rfq_lines', 'vendor_rfq_invitations', 'vendor_rfq_responses',
        'vendor_purchase_orders', 'vendor_purchase_order_lines',
        'vendor_purchase_order_receipts', 'vendor_purchase_order_revisions',
        'part_vendors', 'part_vendor_price_breaks',
        'quickbooks_vendor_map', 'quickbooks_purchasing_setup',
        'quickbooks_purchase_order_links', 'quickbooks_purchase_order_line_links',
        'outside_shipments', 'vendors'];

    IF EXISTS (SELECT 1 FROM public.function_execute_leaks() f WHERE f.function_name = ANY (v_functions)) THEN
        RAISE EXCEPTION 'function_execute_leaks() flags a purchasing function: %',
            (SELECT string_agg(f.function_name || '/' || f.role_name, ', ') FROM public.function_execute_leaks() f
              WHERE f.function_name = ANY (v_functions));
    END IF;
    IF EXISTS (SELECT 1 FROM public.definer_writers_missing_write_gate() f WHERE f.function_name = ANY (v_functions)) THEN
        RAISE EXCEPTION 'definer_writers_missing_write_gate() flags a purchasing function: %',
            (SELECT string_agg(f.function_name, ', ') FROM public.definer_writers_missing_write_gate() f
              WHERE f.function_name = ANY (v_functions));
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenant_tables_missing_write_gate() t WHERE t.table_name = ANY (v_tables)) THEN
        RAISE EXCEPTION 'tenant_tables_missing_write_gate() flags a purchasing table: %',
            (SELECT string_agg(t.table_name, ', ') FROM public.tenant_tables_missing_write_gate() t
              WHERE t.table_name = ANY (v_tables));
    END IF;
    IF EXISTS (SELECT 1 FROM public.tenant_tables_missing_ai_decision() t WHERE t.table_name = ANY (v_tables)) THEN
        RAISE EXCEPTION 'tenant_tables_missing_ai_decision() flags a purchasing table: %',
            (SELECT string_agg(t.table_name, ', ') FROM public.tenant_tables_missing_ai_decision() t
              WHERE t.table_name = ANY (v_tables));
    END IF;
    IF EXISTS (SELECT 1 FROM public.ai_policies_missing_soft_delete_filter() t WHERE t.table_name = ANY (v_tables)) THEN
        RAISE EXCEPTION 'ai_policies_missing_soft_delete_filter() flags a purchasing table: %',
            (SELECT string_agg(t.table_name, ', ') FROM public.ai_policies_missing_soft_delete_filter() t
              WHERE t.table_name = ANY (v_tables));
    END IF;
    IF EXISTS (SELECT 1 FROM public.ai_policies_without_grant() t WHERE t.table_name = ANY (v_tables)) THEN
        RAISE EXCEPTION 'ai_policies_without_grant() flags a purchasing table: %',
            (SELECT string_agg(t.table_name, ', ') FROM public.ai_policies_without_grant() t
              WHERE t.table_name = ANY (v_tables));
    END IF;
END
$check$;
