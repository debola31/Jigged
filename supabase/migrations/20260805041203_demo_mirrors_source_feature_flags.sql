-- A demo company mirrors its source company's feature flags.
--
-- WHY. `create_demo_company` inserts the demo with no `settings` at all, so every
-- demo sits at `{}` — meaning every opt-IN flag reads off. A shop with Storage,
-- Data import and Machine Maintenance enabled entered its demo and found none of
-- them. Both demo companies in production were in exactly that state.
--
-- **And there is no other way to set them.** The feature-flag editor is
-- `/admin/companies`, which lists companies through `admin_routes.py` filtering
-- `.eq("is_demo", False)` — demo companies are deliberately invisible there, as
-- they are to the company switcher and the login redirect. So the flags on a demo
-- company were not merely wrong by default, they were unreachable.
--
-- WHY MIRROR RATHER THAN TURN EVERYTHING ON. The demo presents as the user's own
-- company with a DEMO badge, and entering/leaving preserves page context both
-- ways — so a flag on in the demo and off in the real company is a page that
-- vanishes on exit. Beyond that: `machine_maintenance` is a one-pilot-shop-at-a-
-- time experiment with a written kill criterion, and all-on would put it in front
-- of shops outside the pilot and pollute the measurement; `ai_insights` is opt-OUT
-- with a per-tenant kill switch, so all-on would re-expose to a tenant precisely
-- the thing they turned off. An always-on demo is a *sales showcase*, which is a
-- different product from this one.
--
-- SCOPE — `settings.features` ONLY, and the rest of `settings` is left alone:
--   * `defaults`, `default_payment_terms`, `custom_payment_terms` are editable
--     from the Settings page, which IS reachable inside demo mode (full CRUD is
--     the point). Mirroring them on every entry would silently revert whatever
--     the user had just changed in there.
--   * `ai_limits` is admin-only like `features`, but is deliberately NOT mirrored:
--     it caps Anthropic spend per company, and copying a raised limit onto a
--     second company_id doubles the exposure. Demos keep the default of 20/hour.
--
-- The whole `features` object is copied verbatim rather than key-by-key, so an
-- explicit `false` on an opt-out flag survives as a `false` — an omitted key and
-- a stored `false` resolve differently in `readFeatureFlag`, and squashing that
-- distinction is how a kill switch quietly stops killing.

-- ---------------------------------------------------------------------------
-- 1. The mirror itself
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_demo_features(p_source_company_id uuid, p_demo_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    UPDATE companies d
       SET settings = jsonb_set(COALESCE(d.settings, '{}'::jsonb), '{features}',
                                COALESCE(s.settings->'features', '{}'::jsonb), true),
           updated_at = now()
      FROM companies s
     WHERE d.id = p_demo_company_id
       AND s.id = p_source_company_id
       -- Only when it actually differs. This runs on every demo entry, and an
       -- unconditional write would touch the row (and updated_at) every time.
       AND (d.settings->'features')
           IS DISTINCT FROM COALESCE(s.settings->'features', '{}'::jsonb);
END;
$function$;

-- Backend-only: every caller is a SECURITY DEFINER function in this file. A
-- browser role reaching this directly could rewrite any company's feature block,
-- since SECURITY DEFINER bypasses the RLS on `companies`.
REVOKE EXECUTE ON FUNCTION public.sync_demo_features(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.sync_demo_features(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.sync_demo_features(uuid, uuid) IS
'Copies companies.settings.features verbatim from a source company onto its demo company, and nothing else in settings — the sibling blocks (defaults, default_payment_terms, custom_payment_terms) are editable from inside demo mode and must not be reverted, and ai_limits is withheld on purpose so a raised Anthropic cap is not duplicated onto a second company_id. No-ops when the two already match. Called by create_demo_company, sync_demo_access and reset_demo_company; not reachable from the browser.';

-- ---------------------------------------------------------------------------
-- 2. Mirror at creation
-- ---------------------------------------------------------------------------
-- Verbatim from the live definition, plus the sync_demo_features call. Placed
-- BEFORE seed_demo_data because seeding reads nothing from settings today, but a
-- future seeder branching on a flag should see the mirrored value, not '{}'.

CREATE OR REPLACE FUNCTION public.create_demo_company(p_source_company_id uuid, p_user_id uuid, p_template_name character varying DEFAULT 'default'::character varying)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_source_name TEXT;
    v_demo_company_id UUID;
    v_existing_demo_id UUID;
BEGIN
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Access denied: cannot create demo company for another user';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = p_user_id
          AND company_id = p_source_company_id
          AND role = 'admin'
    ) THEN
        RAISE EXCEPTION 'Access denied: must be admin of source company';
    END IF;

    -- Idempotency: return existing demo if linked
    SELECT demo_company_id INTO v_existing_demo_id
    FROM companies
    WHERE id = p_source_company_id;

    IF v_existing_demo_id IS NOT NULL THEN
        RETURN v_existing_demo_id;
    END IF;

    SELECT name INTO v_source_name FROM companies WHERE id = p_source_company_id;
    IF v_source_name IS NULL THEN
        RAISE EXCEPTION 'Source company not found: %', p_source_company_id;
    END IF;

    INSERT INTO companies (name, is_demo)
    VALUES (v_source_name || ' - Demo', TRUE)
    RETURNING id INTO v_demo_company_id;

    UPDATE companies SET demo_company_id = v_demo_company_id
    WHERE id = p_source_company_id;

    -- Mirror access (operator/user/admin all preserved)
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, v_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id;

    -- Mirror feature flags, so the demo shows the same product surface as the
    -- company it is standing in for.
    PERFORM sync_demo_features(p_source_company_id, v_demo_company_id);

    PERFORM seed_demo_data(v_demo_company_id, p_user_id, p_template_name::text);

    RETURN v_demo_company_id;
END;
$function$;

COMMENT ON FUNCTION public.create_demo_company(uuid, uuid, character varying) IS
'Creates (or returns existing) demo company for the source company, mirrors user_company_access and settings.features, and seeds via seed_demo_data. Idempotent: returns existing demo_company_id if companies.demo_company_id is already set. Caller must be admin of source company.';

-- ---------------------------------------------------------------------------
-- 3. Re-mirror on every entry
-- ---------------------------------------------------------------------------
-- This is the function DemoModeProvider already calls on each entry to a demo
-- that exists, which makes it the one place a flag flipped AFTER the demo was
-- created can converge. Its name still says "access"; it now also syncs the
-- feature block, and the COMMENT says so rather than the name being quietly
-- wrong. Renaming would churn the RPC, utils/demoAccess.ts, the provider and the
-- function_execute_leaks() allowlist for no behavioural gain.

CREATE OR REPLACE FUNCTION public.sync_demo_access(p_source_company_id uuid, p_demo_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    -- Add any missing access entries (new team members since demo was created)
    INSERT INTO user_company_access (user_id, company_id, role, name)
    SELECT uca.user_id, p_demo_company_id, uca.role, uca.name
    FROM user_company_access uca
    WHERE uca.company_id = p_source_company_id
      AND NOT EXISTS (
        SELECT 1 FROM user_company_access
        WHERE user_id = uca.user_id AND company_id = p_demo_company_id
      );

    -- Update roles that changed in the source company
    UPDATE user_company_access demo_uca
    SET role = source_uca.role
    FROM user_company_access source_uca
    WHERE demo_uca.company_id = p_demo_company_id
      AND source_uca.company_id = p_source_company_id
      AND demo_uca.user_id = source_uca.user_id
      AND demo_uca.role != source_uca.role;

    -- Feature flags the admin has changed on the source since the demo was made.
    PERFORM sync_demo_features(p_source_company_id, p_demo_company_id);
END;
$function$;

COMMENT ON FUNCTION public.sync_demo_access(uuid, uuid) IS
'Lazy convergence of a demo company on its source, called on every entry to an existing demo. Despite the name it syncs two things: user_company_access (adds members added since, updates changed roles) and settings.features via sync_demo_features. Does not remove members dropped from the source, and does not touch any other settings block.';

-- ---------------------------------------------------------------------------
-- 4. Re-mirror on reset
-- ---------------------------------------------------------------------------
-- Reset runs from inside demo mode, so entry-sync has already happened and the
-- flags are usually right. It is here so that "Reset" means the demo is fully
-- back to its intended state without depending on when the user last entered.

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

    -- inventory ledger and balances (part_location_stock RESTRICTs parts)
    DELETE FROM inventory_transactions WHERE company_id = v_demo_company_id;
    DELETE FROM part_location_stock    WHERE company_id = v_demo_company_id;

    -- jobs
    DELETE FROM job_operation_completions WHERE company_id = v_demo_company_id;
    DELETE FROM job_materials  WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_operations WHERE job_id IN (SELECT id FROM jobs WHERE company_id = v_demo_company_id);
    DELETE FROM job_attachments WHERE company_id = v_demo_company_id;
    DELETE FROM job_parts      WHERE company_id = v_demo_company_id;
    DELETE FROM jobs           WHERE company_id = v_demo_company_id;

    -- quotes
    DELETE FROM quote_line_items WHERE company_id = v_demo_company_id;
    DELETE FROM quote_materials  WHERE company_id = v_demo_company_id;
    DELETE FROM quote_operations WHERE company_id = v_demo_company_id;
    DELETE FROM quotes           WHERE company_id = v_demo_company_id;

    -- routings, then parts and their children
    DELETE FROM routing_operations
        WHERE routing_id IN (SELECT id FROM routings WHERE company_id = v_demo_company_id);
    DELETE FROM routings WHERE company_id = v_demo_company_id;
    DELETE FROM parts_bom
        WHERE parent_part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id)
           OR child_part_id  IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
    DELETE FROM part_procurement_tiers
        WHERE part_id IN (SELECT id FROM parts WHERE company_id = v_demo_company_id);
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

    -- parties
    DELETE FROM customer_carrier_accounts WHERE company_id = v_demo_company_id;
    DELETE FROM customers WHERE company_id = v_demo_company_id;  -- contacts/addresses CASCADE
    DELETE FROM vendors   WHERE company_id = v_demo_company_id;  -- vendor_contacts CASCADE

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

COMMENT ON FUNCTION public.reset_demo_company(uuid, uuid) IS
'Wipes every table the demo company owns, re-mirrors settings.features from the source, then re-seeds from the active template. Caller must be the requesting user (auth.uid() check). Deletion is leaves-first because six child tables are ON DELETE RESTRICT against parts/job_parts/work_centers; the body is one transaction, so a single violation rolls the whole reset back (#675). Keeps user_company_access, company_billing, invitations, quickbooks_connections, ai_config, auth_audit_log and feedback; clears company_order_counters so quote/job numbering restarts.';

-- ---------------------------------------------------------------------------
-- 5. Backfill the demos that already exist
-- ---------------------------------------------------------------------------
-- Every existing demo company satisfies the invariant by the time this migration
-- finishes — no "if empty, read the source instead" fallback in the access layer.
-- Both production demos are at settings = '{}' today while their sources have
-- three opt-in flags on between them, so this is the statement that actually
-- fixes what was reported.

UPDATE public.companies d
   SET settings = jsonb_set(COALESCE(d.settings, '{}'::jsonb), '{features}',
                            COALESCE(s.settings->'features', '{}'::jsonb), true),
       updated_at = now()
  FROM public.companies s
 WHERE s.demo_company_id = d.id
   AND d.is_demo
   AND (d.settings->'features')
       IS DISTINCT FROM COALESCE(s.settings->'features', '{}'::jsonb);
