-- ============================================================================
-- Vendor multi-contact: extract contacts to vendor_contacts table, drop notes
-- ============================================================================
--
-- Context. Iteration 1 shipped vendors with a single embedded contact
-- (contact_name / contact_email / contact_phone) plus a free-form notes column.
-- Usability review (Shane @ Contour) surfaced that real shops carry multiple
-- contacts per vendor — sales rep, AP clerk, quality engineer, etc. — and
-- need to mark one as primary. The fix is a separate vendor_contacts table
-- with a role enum + an is_primary boolean.
--
-- This migration:
--   1. Creates vendor_contacts with the role enum + is_primary
--   2. Adds a partial unique index ensuring at most one primary per vendor
--   3. Backfills ONLY rows where contact_name IS NOT NULL — vendors with
--      email/phone but no contact_name are intentionally left without a
--      contact row (see DO $$ block below for the rationale + report)
--   4. Drops vendors.contact_name / contact_email / contact_phone / notes
--   5. Adds the full RLS policy set + updated_at trigger + ai_readonly grant
--
-- Customer multi-contact follows the same pattern and ships in a parallel
-- follow-up PR (kept out of this migration to keep the diff focused). The
-- two follow-ups will be functionally symmetric: customer_contacts table,
-- same role enum (or a customer-specific one if usability review points
-- another way), same is_primary semantics, same backfill rule.
--
-- Forward-only. Single BEGIN/COMMIT.

BEGIN;

-- ============================================================================
-- Phase 1: Create vendor_contacts table
-- ============================================================================
--
-- role values: sales / accounts_payable / quality / engineering /
-- shipping_receiving / customer_service / other.
--
-- role_label is required when role='other' (enforced via CHECK below). It
-- holds the user-typed free-text label so the UI can render
-- "Other (Production Manager)" rather than just "Other".
--
-- is_primary marks the canonical contact. The partial unique index in Phase
-- 2 ensures at most one primary per vendor; the access layer's transactional
-- helpers (createVendorContact, updateVendorContact, setPrimaryContact) clear
-- any existing primary for the vendor before flipping a new row to primary,
-- so the UI never trips the constraint.

CREATE TABLE public.vendor_contacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    name text NOT NULL,
    role text NOT NULL CHECK (role IN (
        'sales',
        'accounts_payable',
        'quality',
        'engineering',
        'shipping_receiving',
        'customer_service',
        'other'
    )),
    role_label text,
    email text,
    phone text,
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vendor_contacts_role_label_required
        CHECK (role <> 'other' OR (role_label IS NOT NULL AND length(role_label) > 0))
);

COMMENT ON TABLE public.vendor_contacts
    IS 'People at a vendor. Replaces the single embedded contact_name/email/phone columns on vendors. Each row is one person with a role + optional email/phone. At most one row per vendor can have is_primary=true (enforced by the vendor_contacts_one_primary partial unique index).';

COMMENT ON COLUMN public.vendor_contacts.role_label
    IS 'Free-text label used when role=''other''. Lets the UI render "Other (Production Manager)" without inventing a new enum value for every shop-specific role.';

COMMENT ON COLUMN public.vendor_contacts.is_primary
    IS 'True for the contact treated as the vendor''s primary point of contact. Surfaced on the vendors list page and as a star badge on the vendor detail page. Enforced unique-per-vendor by the vendor_contacts_one_primary partial index.';

CREATE INDEX idx_vendor_contacts_vendor
    ON public.vendor_contacts (vendor_id);


-- ============================================================================
-- Phase 2: Partial unique index for the one-primary-per-vendor invariant
-- ============================================================================

CREATE UNIQUE INDEX vendor_contacts_one_primary
    ON public.vendor_contacts (vendor_id) WHERE is_primary;


-- ============================================================================
-- Phase 3: Backfill from the existing single-contact columns
-- ============================================================================
--
-- IMPORTANT: only insert rows where contact_name IS NOT NULL.
--
-- A previous draft used COALESCE(contact_name, name) — i.e. fall back to the
-- vendor's company name as the contact's person-name. That silently corrupts
-- data: "Midwest Steel Supply" is a company name, not a person, and the UI
-- has no way to tell the two apart afterward. The no-silent-fallbacks
-- engineering principle says: surface the gap, don't paper over it.
--
-- So we only backfill rows that already have a real contact_name. Vendors
-- with email/phone but no name are surfaced via the DO $$ NOTICE block below
-- so the user can prioritize adding real contacts via the new Contacts UI.
-- The vendor detail page's empty-state ("No contacts yet. + Add Contact")
-- handles the no-contact case explicitly.

INSERT INTO public.vendor_contacts (vendor_id, name, role, email, phone, is_primary)
SELECT id, contact_name, 'sales', contact_email, contact_phone, true
FROM public.vendors
WHERE contact_name IS NOT NULL
  AND length(trim(contact_name)) > 0;


-- ============================================================================
-- Phase 4: Data-quality report — vendors with email/phone but no name
-- ============================================================================

DO $$
DECLARE
    v_orphan_count integer;
    v_row record;
BEGIN
    SELECT count(*) INTO v_orphan_count
      FROM public.vendors
     WHERE (contact_name IS NULL OR length(trim(contact_name)) = 0)
       AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL);

    IF v_orphan_count > 0 THEN
        RAISE NOTICE
            'vendor_contacts backfill: % vendor(s) had email/phone but no contact_name. They have no contact row yet — add real contacts via the new Contacts UI on each vendor detail page:',
            v_orphan_count;
        FOR v_row IN
            SELECT id, name, contact_email, contact_phone
              FROM public.vendors
             WHERE (contact_name IS NULL OR length(trim(contact_name)) = 0)
               AND (contact_email IS NOT NULL OR contact_phone IS NOT NULL)
             ORDER BY name
        LOOP
            RAISE NOTICE '  vendor %: % | email=% | phone=%',
                v_row.id, v_row.name,
                COALESCE(v_row.contact_email, '—'),
                COALESCE(v_row.contact_phone, '—');
        END LOOP;
    END IF;
END $$;


-- ============================================================================
-- Phase 5: Drop the old single-contact columns + notes
-- ============================================================================
--
-- notes was a free-form text dumping ground. Usability review showed it was
-- almost always empty in practice and, when used, mostly held contact-related
-- info that now belongs on a vendor_contacts row. Drop it; if a contained
-- "internal notes" field is needed later we can add it back as a typed column
-- with a clearer purpose.

ALTER TABLE public.vendors
    DROP COLUMN contact_name,
    DROP COLUMN contact_email,
    DROP COLUMN contact_phone,
    DROP COLUMN notes;


-- ============================================================================
-- Phase 6: RLS policies on vendor_contacts
-- ============================================================================
--
-- Same pattern as vendors: 4 user policies via get_user_company_ids() joined
-- through vendors.company_id, plus an ai_readonly_select policy via the
-- jigged.company_id setting. No direct company_id column on vendor_contacts —
-- access is always scoped through the parent vendor row.

ALTER TABLE public.vendor_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view vendor_contacts" ON public.vendor_contacts;
CREATE POLICY "Users can view vendor_contacts"
    ON public.vendor_contacts
    FOR SELECT
    USING (
        vendor_id IN (
            SELECT v.id
              FROM public.vendors v
             WHERE v.company_id IN (SELECT get_user_company_ids())
        )
    );

DROP POLICY IF EXISTS "Users can insert vendor_contacts" ON public.vendor_contacts;
CREATE POLICY "Users can insert vendor_contacts"
    ON public.vendor_contacts
    FOR INSERT
    WITH CHECK (
        vendor_id IN (
            SELECT v.id
              FROM public.vendors v
             WHERE v.company_id IN (SELECT get_user_company_ids())
        )
    );

DROP POLICY IF EXISTS "Users can update vendor_contacts" ON public.vendor_contacts;
CREATE POLICY "Users can update vendor_contacts"
    ON public.vendor_contacts
    FOR UPDATE
    USING (
        vendor_id IN (
            SELECT v.id
              FROM public.vendors v
             WHERE v.company_id IN (SELECT get_user_company_ids())
        )
    );

DROP POLICY IF EXISTS "Users can delete vendor_contacts" ON public.vendor_contacts;
CREATE POLICY "Users can delete vendor_contacts"
    ON public.vendor_contacts
    FOR DELETE
    USING (
        vendor_id IN (
            SELECT v.id
              FROM public.vendors v
             WHERE v.company_id IN (SELECT get_user_company_ids())
        )
    );

DROP POLICY IF EXISTS "ai_readonly_select" ON public.vendor_contacts;
CREATE POLICY "ai_readonly_select"
    ON public.vendor_contacts
    FOR SELECT
    TO jigged_ai_readonly
    USING (
        vendor_id IN (
            SELECT v.id
              FROM public.vendors v
             WHERE v.company_id = (current_setting('jigged.company_id', true))::uuid
        )
    );

GRANT SELECT ON public.vendor_contacts TO jigged_ai_readonly;


-- ============================================================================
-- Phase 7: updated_at trigger
-- ============================================================================

DROP TRIGGER IF EXISTS vendor_contacts_updated_at ON public.vendor_contacts;
CREATE TRIGGER vendor_contacts_updated_at
    BEFORE UPDATE ON public.vendor_contacts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- Phase 8: Update demo seed template + seed_demo_data() for vendor_contacts
-- ============================================================================
--
-- The demo seed shipped in 20260504_rebuild_demo_seed wrote contact_name /
-- contact_email / contact_phone directly on the vendors row. Those columns
-- no longer exist after Phase 5. Move the demo contact info into a
-- vendor_contacts array under each vendor in template_data, then rewrite
-- the seed_demo_data() vendors block to:
--   1. Insert the vendor row WITHOUT the dropped columns
--   2. For each entry in v_item->'contacts', insert a vendor_contacts row
--
-- The rest of seed_demo_data() (work_centers, parts, parts_bom, routings,
-- customers, quotes, jobs) is unchanged from the chunk 11 version.

UPDATE public.demo_data_templates
   SET template_data = jsonb_set(
        template_data,
        '{vendors}',
        jsonb_build_array(
            jsonb_build_object(
                '_ref', 'vendor_steel_supply',
                'name', 'Midwest Steel Supply',
                'city', 'Chicago',
                'state', 'IL',
                'contacts', jsonb_build_array(
                    jsonb_build_object(
                        'name', 'Pat Reyes',
                        'role', 'sales',
                        'email', 'orders@midweststeel.example.com',
                        'phone', '555-0142',
                        'is_primary', true
                    )
                )
            ),
            jsonb_build_object(
                '_ref', 'vendor_coating',
                'name', 'PerformCoat Finishing',
                'city', 'Cleveland',
                'state', 'OH',
                'contacts', jsonb_build_array(
                    jsonb_build_object(
                        'name', 'Sam Lee',
                        'role', 'sales',
                        'email', 'jobs@performcoat.example.com',
                        'phone', '555-0177',
                        'is_primary', true
                    )
                )
            ),
            jsonb_build_object(
                '_ref', 'vendor_edm',
                'name', 'Precision EDM Partners',
                'city', 'Milwaukee',
                'state', 'WI',
                'contacts', jsonb_build_array(
                    jsonb_build_object(
                        'name', 'Jamie Quinn',
                        'role', 'sales',
                        'email', 'rfq@precisionedm.example.com',
                        'phone', '555-0198',
                        'is_primary', true
                    )
                )
            )
        ),
        true
   )
 WHERE is_active = true;


CREATE OR REPLACE FUNCTION public.seed_demo_data(
    p_company_id uuid,
    p_user_id uuid,
    p_template_name text DEFAULT 'default'
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template jsonb;
    v_ref_map jsonb := '{}'::jsonb;
    v_item jsonb;
    v_inner jsonb;
    v_contact jsonb;
    v_new_id uuid;
    v_routing_id uuid;
    v_quote_id uuid;
    v_job_id uuid;
    v_job_part_id uuid;
    v_part_id uuid;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- ── Vendors ───────────────────────────────────────────────────────────
    -- Inserts the vendor row WITHOUT the dropped contact_name/email/phone/
    -- notes columns. Each entry in v_item->'contacts' becomes a
    -- vendor_contacts row, with is_primary respected (defaulting to false
    -- when omitted).
    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name,
                                 address_line1, address_line2, city, state, postal_code, country,
                                 legacy_id)
            VALUES (v_new_id, p_company_id, v_item->>'name',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'legacy_id');

            IF v_item->'contacts' IS NOT NULL THEN
                FOR v_contact IN SELECT * FROM jsonb_array_elements(v_item->'contacts') LOOP
                    INSERT INTO vendor_contacts (vendor_id, name, role, role_label,
                                                 email, phone, is_primary)
                    VALUES (v_new_id,
                            v_contact->>'name',
                            COALESCE(v_contact->>'role', 'sales'),
                            v_contact->>'role_label',
                            v_contact->>'email',
                            v_contact->>'phone',
                            COALESCE((v_contact->>'is_primary')::boolean, false));
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- ── Work centers ──────────────────────────────────────────────────────
    -- Resolves vendor_ref via the ref-map for external work_centers.
    -- The CHECK constraints on work_centers enforce internal/external ↔ vendor.
    IF v_template->'work_centers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'work_centers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO work_centers (id, company_id, name, kind, vendor_id,
                                      labor_rate, description)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    COALESCE(v_item->>'kind', 'internal'),
                    CASE WHEN v_item->>'vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'vendor_ref'))::uuid
                         ELSE NULL END,
                    NULLIF(v_item->>'labor_rate', '')::numeric,
                    v_item->>'description');
        END LOOP;
    END IF;

    -- ── Parts ─────────────────────────────────────────────────────────────
    -- Inserted before parts_bom so child refs resolve. preferred_vendor_ref
    -- resolves through the ref-map. Reads `source` / `is_stocked` from
    -- template_data (renamed from `is_manufacturable` / `is_stockable` in
    -- the 20260504_part_source_enum_and_stocked_rename migration).
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO parts (id, company_id, part_name, description,
                               source, is_stocked,
                               primary_unit, quantity, cost_per_unit,
                               reorder_point, preferred_vendor_id, legacy_id)
            VALUES (v_new_id, p_company_id,
                    v_item->>'part_name', v_item->>'description',
                    COALESCE(v_item->>'source', 'made'),
                    COALESCE((v_item->>'is_stocked')::boolean, false),
                    v_item->>'primary_unit',
                    COALESCE((v_item->>'quantity')::numeric, 0),
                    NULLIF(v_item->>'cost_per_unit', '')::numeric,
                    NULLIF(v_item->>'reorder_point', '')::numeric,
                    CASE WHEN v_item->>'preferred_vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'preferred_vendor_ref'))::uuid
                         ELSE NULL END,
                    v_item->>'legacy_id');
        END LOOP;
    END IF;

    -- ── parts_bom edges ───────────────────────────────────────────────────
    IF v_template->'parts_bom' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts_bom') LOOP
            INSERT INTO parts_bom (parent_part_id, child_part_id, quantity, unit, sequence, notes)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0),
                    v_item->>'notes');
        END LOOP;
    END IF;

    -- ── Routings + nested routing_operations ──────────────────────────────
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_routing_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_routing_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description, created_by)
            VALUES (v_routing_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description', p_user_id);

            IF v_item->'operations' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'operations') LOOP
                    INSERT INTO routing_operations (
                        routing_id, work_center_id, sequence,
                        setup_minutes, cycle_minutes_per_unit,
                        labor_rate_override,
                        external_unit_price, external_setup_cost,
                        instructions
                    ) VALUES (
                        v_routing_id,
                        (v_ref_map->>(v_inner->>'work_center_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
                        NULLIF(v_inner->>'external_setup_cost', '')::numeric,
                        v_inner->>'instructions'
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- ── Customers ─────────────────────────────────────────────────────────
    -- Customers still carry the embedded contact fields; multi-contact for
    -- customers is a parallel follow-up. When that ships, this block needs
    -- the same kind of treatment as vendors above.
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO customers (id, company_id, name,
                                   contact_name, contact_email, contact_phone,
                                   address_line1, address_line2, city, state, postal_code, country,
                                   website)
            VALUES (v_new_id, p_company_id,
                    v_item->>'name',
                    v_item->>'contact_name', v_item->>'contact_email', v_item->>'contact_phone',
                    v_item->>'address_line1', v_item->>'address_line2',
                    v_item->>'city', v_item->>'state', v_item->>'postal_code',
                    COALESCE(v_item->>'country', 'USA'),
                    v_item->>'website');
        END LOOP;
    END IF;

    -- ── Quotes + nested line_items ────────────────────────────────────────
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_quote_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_quote_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status,
                                lead_time_days, expiration_date, created_by)
            VALUES (v_quote_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid
                         ELSE NULL END,
                    COALESCE(v_item->>'status', 'active'),
                    NULLIF(v_item->>'lead_time_days', '')::integer,
                    NULLIF(v_item->>'expiration_date', '')::date,
                    p_user_id);

            IF v_item->'line_items' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'line_items') LOOP
                    INSERT INTO quote_line_items (
                        quote_id, company_id, part_id,
                        sequence, quantity, unit_price, total_price
                    ) VALUES (
                        v_quote_id, p_company_id,
                        (v_ref_map->>(v_inner->>'part_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        (v_inner->>'quantity')::integer,
                        (v_inner->>'unit_price')::numeric,
                        NULLIF(v_inner->>'total_price', '')::numeric
                    );
                END LOOP;
            END IF;
        END LOOP;
    END IF;

    -- ── Jobs + job_parts ──────────────────────────────────────────────────
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_job_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_job_id::text));

            INSERT INTO jobs (id, company_id, customer_id, quote_id,
                              job_number, status, created_by)
            VALUES (v_job_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid
                         ELSE NULL END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid
                         ELSE NULL END,
                    COALESCE(v_item->>'job_number',
                             'J-DEMO-' || substr(v_job_id::text, 1, 8)),
                    COALESCE(v_item->>'status', 'not_started'),
                    p_user_id);

            IF v_item->'parts' IS NOT NULL THEN
                FOR v_inner IN SELECT * FROM jsonb_array_elements(v_item->'parts') LOOP
                    v_part_id := (v_ref_map->>(v_inner->>'part_ref'))::uuid;
                    v_job_part_id := gen_random_uuid();

                    INSERT INTO job_parts (id, job_id, company_id, part_id,
                                           sequence, quantity, status)
                    VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                            COALESCE((v_inner->>'sequence')::integer, 10),
                            COALESCE((v_inner->>'quantity')::integer, 1),
                            COALESCE(v_inner->>'status', 'not_started'));

                    IF v_inner->>'routing_ref' IS NOT NULL THEN
                        PERFORM create_job_part_operations_from_routing(
                            v_job_part_id,
                            (v_ref_map->>(v_inner->>'routing_ref'))::uuid
                        );
                    END IF;
                END LOOP;
            END IF;
        END LOOP;
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.seed_demo_data(uuid, uuid, text)
    IS 'Seeds a company from the active demo_data_templates row. Walks vendors (+ vendor_contacts) → work_centers → parts → parts_bom → routings/routing_operations → customers → quotes/line_items → jobs/job_parts. Uses a jsonb ref-map to resolve _ref → uuid across the template. Vendor contacts come from v_item->''contacts'' (one vendor_contacts row per entry, is_primary respected); the embedded contact_name/email/phone columns on vendors were dropped in 20260504_vendor_contacts_and_drop_notes. Customer contacts still embed on the customers row pending a parallel multi-contact follow-up.';

COMMIT;
