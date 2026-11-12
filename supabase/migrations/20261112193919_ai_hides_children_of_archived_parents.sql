-- ============================================================================
-- The insights AI stops seeing the children of archived parents
-- ============================================================================
-- An archived vendor's contacts and addresses were readable by jigged_ai_readonly.
-- Their ai_readonly_select policies scope through the vendor for the COMPANY and
-- for nothing else, so "who do we call at <vendor>?" answered for a vendor no
-- screen shows -- the six-phantom-jobs bug of 20260827114613, one level down.
-- CLAUDE.md's rule is that ai_readonly_select policies carry the soft-delete
-- filter. The guard that enforces it, ai_policies_missing_soft_delete_filter(),
-- read only a table's OWN deleted_at, so a child with none of its own passed it
-- vacuously whatever its parent's state.
--
-- Extending the guard to every table a policy reads (section 2) found the same
-- leak on six more children, fixed here too because a guard cannot ship red:
--   customer_addresses                          -> customers
--   job_materials, job_operations, job_parts    -> jobs
--   parts_bom, parts_unit_conversions           -> parts
-- Each policy is rebuilt from its NEWEST definition with one clause added -- the
-- parent must be live -- the shape customer_contacts (20260827114613) and
-- vendor_purchase_order_lines (20261110043600) already have. Nothing else in any
-- of them changes; grants are untouched.
--
-- THE SAME LEAK WITH NO READ AT ALL (section 1b). A child that carries its own
-- company_id was usually given "company_id = <the company>" and nothing else, so
-- its policy reads no other table and the extended guard had nothing to judge:
-- an archived quote's lines and an archived part's price tiers stayed readable.
-- Section 2's third branch closes that class -- a NOT NULL foreign key to a
-- soft-deletable table says the row BELONGS to that parent, and the policy must
-- read it through that key -- and found six more beside those two, all fixed the
-- same way:
--   quote_line_items                               -> quotes
--   part_pricing_tiers, routings, material_lots    -> parts
--   vendor_services                                -> vendors
--   part_vendors                                   -> parts AND vendors
--   outside_shipments, shipments                   -> jobs
-- Each one is a child the app reaches only through its parent, or whose list read
-- filters on the parent's deleted_at already: the slip register and the dashboard's
-- shipment tiles drop an archived job's slips; listPartVendors / listVendorParts
-- drop an approved-vendor row whose vendor or part is archived. Four grandchildren
-- go with them: outside_shipment_receipts reads its slip's job (its key is the slip,
-- which has no deleted_at); routing_operations, part_vendor_price_breaks and
-- shipment_line_items already read their parent, and RLS applies inside a policy's
-- subquery, so they follow it with no change of their own.
--
-- The NOT NULL keys that only REFER are listed in the guard with their reasons --
-- a job's or quote's line naming an archived part, a document naming an archived
-- vendor or customer. Hiding those would take a live job's line, a live PO or a
-- shipped customer's revenue history with them.
--
-- WHAT IT COSTS, as 20260827114613 said of the parents: the model cannot answer
-- about an archived job's parts or an archived vendor's contacts. It already
-- could not see the job or the vendor, so a child it could see was an orphan it
-- would report as live. parts_bom hides an archived ASSEMBLY's structure; a live
-- assembly whose BOM names an archived component keeps the row, and the
-- component itself stays hidden by parts' own policy. And one cost in a view:
-- vendor_purchase_order_line_status is security_invoker, so an outside PO line
-- whose slips are on a job archived since reads to the model as not yet sent,
-- where the PO page, a by-id read, still counts them.


-- ============================================================================
-- 1. The policies, each from its newest definition plus "the parent is live"
-- ============================================================================

-- vendor_contacts: baseline (20260527151536).
DROP POLICY IF EXISTS ai_readonly_select ON public.vendor_contacts;
CREATE POLICY ai_readonly_select ON public.vendor_contacts
    FOR SELECT TO jigged_ai_readonly
    USING (
      vendor_id IN (
        SELECT v.id FROM public.vendors v
         WHERE v.company_id = (current_setting('jigged.company_id', true))::uuid
           AND v.deleted_at IS NULL
      )
    );

-- vendor_addresses: 20260824022226.
DROP POLICY IF EXISTS ai_readonly_select ON public.vendor_addresses;
CREATE POLICY ai_readonly_select ON public.vendor_addresses
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.vendors v
         WHERE v.id = vendor_addresses.vendor_id
           AND v.company_id = (current_setting('jigged.company_id', true))::uuid
           AND v.deleted_at IS NULL
      )
    );

-- customer_addresses: 20260826112948.
DROP POLICY IF EXISTS ai_readonly_select ON public.customer_addresses;
CREATE POLICY ai_readonly_select ON public.customer_addresses
    FOR SELECT TO jigged_ai_readonly
    USING (
      customer_id IN (
        SELECT c.id FROM public.customers c
         WHERE c.company_id = (current_setting('jigged.company_id', true))::uuid
           AND c.deleted_at IS NULL
      )
    );

-- job_materials, job_operations, job_parts: baseline (20260527151536).
DROP POLICY IF EXISTS ai_readonly_select ON public.job_materials;
CREATE POLICY ai_readonly_select ON public.job_materials
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.jobs
         WHERE jobs.id = job_materials.job_id
           AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid
           AND jobs.deleted_at IS NULL
      )
    );

DROP POLICY IF EXISTS ai_readonly_select ON public.job_operations;
CREATE POLICY ai_readonly_select ON public.job_operations
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.jobs
         WHERE jobs.id = job_operations.job_id
           AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid
           AND jobs.deleted_at IS NULL
      )
    );

DROP POLICY IF EXISTS ai_readonly_select ON public.job_parts;
CREATE POLICY ai_readonly_select ON public.job_parts
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.jobs
         WHERE jobs.id = job_parts.job_id
           AND jobs.company_id = (current_setting('jigged.company_id', true))::uuid
           AND jobs.deleted_at IS NULL
      )
    );

-- parts_bom, parts_unit_conversions: baseline (20260527151536).
DROP POLICY IF EXISTS ai_readonly_select ON public.parts_bom;
CREATE POLICY ai_readonly_select ON public.parts_bom
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.parts
         WHERE parts.id = parts_bom.parent_part_id
           AND parts.company_id = (current_setting('jigged.company_id', true))::uuid
           AND parts.deleted_at IS NULL
      )
    );

DROP POLICY IF EXISTS ai_readonly_select ON public.parts_unit_conversions;
CREATE POLICY ai_readonly_select ON public.parts_unit_conversions
    FOR SELECT TO jigged_ai_readonly
    USING (
      EXISTS (
        SELECT 1 FROM public.parts
         WHERE parts.id = parts_unit_conversions.part_id
           AND parts.company_id = (current_setting('jigged.company_id', true))::uuid
           AND parts.deleted_at IS NULL
      )
    );


-- ============================================================================
-- 1b. The children whose policies never read their parent at all
-- ============================================================================
-- Each keeps its newest definition -- its own company_id, and its own deleted_at
-- where it has one -- and gains the parent clause, the vendor_purchase_order_lines
-- shape. Grants are untouched, the column lists on shipments, outside_shipments,
-- outside_shipment_receipts and part_vendors included.

-- quote_line_items: baseline (20260527151536).
DROP POLICY IF EXISTS ai_readonly_select ON public.quote_line_items;
CREATE POLICY ai_readonly_select ON public.quote_line_items
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND EXISTS (
        SELECT 1 FROM public.quotes q
         WHERE q.id = quote_line_items.quote_id
           AND q.deleted_at IS NULL
      )
    );

-- part_pricing_tiers, routings: baseline (20260527151536). routing_operations
-- reads routings, so an archived part's routing steps go with this.
DROP POLICY IF EXISTS ai_readonly_select ON public.part_pricing_tiers;
CREATE POLICY ai_readonly_select ON public.part_pricing_tiers
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND EXISTS (
        SELECT 1 FROM public.parts p
         WHERE p.id = part_pricing_tiers.part_id
           AND p.deleted_at IS NULL
      )
    );

DROP POLICY IF EXISTS ai_readonly_select ON public.routings;
CREATE POLICY ai_readonly_select ON public.routings
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND EXISTS (
        SELECT 1 FROM public.parts p
         WHERE p.id = routings.part_id
           AND p.deleted_at IS NULL
      )
    );

-- material_lots: 20260906121901. A lot is stock of one part; every lot read in
-- the app goes through its part, and inventory_on_hand_cost drops archived parts.
DROP POLICY IF EXISTS ai_readonly_select ON public.material_lots;
CREATE POLICY ai_readonly_select ON public.material_lots
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.parts p
         WHERE p.id = material_lots.part_id
           AND p.deleted_at IS NULL
      )
    );

-- vendor_services: apply_ai_read_access in 20260827114613. A service is a
-- process that vendor performs, unique per vendor.
DROP POLICY IF EXISTS ai_readonly_select ON public.vendor_services;
CREATE POLICY ai_readonly_select ON public.vendor_services
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.vendors v
         WHERE v.id = vendor_services.vendor_id
           AND v.deleted_at IS NULL
      )
    );

-- part_vendors: apply_ai_read_access in 20261110043600. The approved-vendor row
-- belongs to both sides; part_vendor_price_breaks reads it, so a price sheet goes
-- with either.
DROP POLICY IF EXISTS ai_readonly_select ON public.part_vendors;
CREATE POLICY ai_readonly_select ON public.part_vendors
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.parts p
         WHERE p.id = part_vendors.part_id
           AND p.deleted_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM public.vendors v
         WHERE v.id = part_vendors.vendor_id
           AND v.deleted_at IS NULL
      )
    );

-- outside_shipments, outside_shipment_receipts: 20260903203741. Neither has a
-- deleted_at (a slip is voided, never archived); both go with the job. A receipt's
-- key is its slip, so it reads the slip's job.
DROP POLICY IF EXISTS ai_readonly_select ON public.outside_shipments;
CREATE POLICY ai_readonly_select ON public.outside_shipments
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND EXISTS (
        SELECT 1 FROM public.jobs j
         WHERE j.id = outside_shipments.job_id
           AND j.deleted_at IS NULL
      )
    );

DROP POLICY IF EXISTS ai_readonly_select ON public.outside_shipment_receipts;
CREATE POLICY ai_readonly_select ON public.outside_shipment_receipts
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND EXISTS (
        SELECT 1 FROM public.outside_shipments s
          JOIN public.jobs j ON j.id = s.job_id
         WHERE s.id = outside_shipment_receipts.outside_shipment_id
           AND j.deleted_at IS NULL
      )
    );

-- shipments: apply_ai_read_access in 20260826010319. Voided, never archived, so
-- it goes with its job, as the dashboard's shipment tiles already drop an archived
-- job's. shipment_line_items reads shipments.
DROP POLICY IF EXISTS ai_readonly_select ON public.shipments;
CREATE POLICY ai_readonly_select ON public.shipments
    FOR SELECT TO jigged_ai_readonly
    USING (
      company_id = (current_setting('jigged.company_id', true))::uuid
      AND EXISTS (
        SELECT 1 FROM public.jobs j
         WHERE j.id = shipments.job_id
           AND j.deleted_at IS NULL
      )
    );


-- ============================================================================
-- 2. The guard sees the tables a policy READS, and the parents a row BELONGS to
-- ============================================================================
-- Rebuilt from its newest definition (20260827114613). Branch (1) is that body
-- verbatim but for its ORDER BY, which now closes the UNION.
--
-- Branch (2) asks pg_depend rather than the policy's text. CREATE POLICY records
-- a dependency on every column its expression reads -- inside a subquery too --
-- which is why such a column cannot be dropped out from under the policy. So
-- "this policy reads vendors and filters vendors.deleted_at" is a catalogue fact:
-- a dependency on vendors with no dependency on vendors.deleted_at is the leak.
-- A text match (branch (1)'s method) cannot tell which table a "deleted_at" in
-- the expression belongs to; customer_contacts mentions it twice for that reason.
--
-- Branch (3) catches the policy that reads no parent at all, which (2) passes
-- vacuously. A NOT NULL foreign key to a soft-deletable table is the catalogue's
-- statement that every row has that parent; the policy must then read the parent
-- THROUGH that key -- a dependency on the parent table and on the key's own
-- columns, so parts_bom reading parts through parent_part_id does not also clear
-- child_part_id -- and (2) then holds that read to the parent's deleted_at.
-- company_id is left out of a key: it is the tenant half of a composite key, never
-- the owner. A nullable key is out of scope -- a row can exist without that parent,
-- so it refers rather than belongs.
--
-- reference_keys lists the NOT NULL keys that refer rather than own, each with its
-- reason. It is keyed on the table AND the key, so a table's owning key stays
-- checked while one of its references is exempt. An entry is a decision a reviewer
-- reads, as on tenant_tables_missing_ai_decision()'s list.
CREATE OR REPLACE FUNCTION public.ai_policies_missing_soft_delete_filter()
RETURNS TABLE(table_name text)
LANGUAGE sql
STABLE
AS $fn$
  WITH reference_keys(table_name, key_columns, reason) AS (VALUES
    ('job_parts', 'part_id',
     'A job''s line: it belongs to the job, required live through job_id. An archived part leaves the live job whole; parts'' own policy hides the part.'),
    ('job_materials', 'material_part_id',
     'A job''s material line: as job_parts.part_id.'),
    ('quote_line_items', 'part_id',
     'A quote''s line: it belongs to the quote, required live through quote_id; as job_parts.part_id.'),
    ('parts_bom', 'child_part_id',
     'A BOM line belongs to its assembly, required live through parent_part_id. archive_parts (20260719013048) deletes the lines naming an archived component.'),
    ('shipments', 'customer_id',
     'A packing slip belongs to its job, required live through job_id. Revenue groups by its customer_name snapshot; hiding it would take an archived customer''s shipped history with them.'),
    ('outside_shipments', 'vendor_id',
     'A vendor packing slip belongs to its job, required live through job_id. The vendor''s name is frozen on it, and parts sent to a vendor archived since are still there.'),
    ('vendor_purchase_orders', 'vendor_id',
     'A PO is a document with its own deleted_at. The PO list keeps it whatever the vendor''s state, under the vendor name frozen on it.'),
    ('vendor_rfq_invitations', 'vendor_id',
     'An invitation belongs to its RFQ, required live through vendor_rfq_id; the RFQ lists everyone it asked, under the name frozen on the invitation.')
  )
  -- (1) The table's OWN deleted_at.
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_policy  p ON p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = c.oid AND a.attname = 'deleted_at' AND NOT a.attisdropped
    )
    AND pg_get_expr(p.polqual, p.polrelid) NOT LIKE '%deleted_at%'
  UNION
  -- (2) Every OTHER soft-deletable table the policy reads -- a parent it scopes
  -- through -- must have its deleted_at read too.
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_policy  p ON p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
  JOIN pg_depend  d ON d.classid = 'pg_policy'::regclass AND d.objid = p.oid
                   AND d.refclassid = 'pg_class'::regclass
  JOIN pg_class   r ON r.oid = d.refobjid AND r.relkind = 'r' AND r.oid <> c.oid
  JOIN pg_attribute del ON del.attrelid = r.oid AND del.attname = 'deleted_at'
                       AND NOT del.attisdropped
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d2
       WHERE d2.classid = 'pg_policy'::regclass AND d2.objid = p.oid
         AND d2.refclassid = 'pg_class'::regclass
         AND d2.refobjid = r.oid AND d2.refobjsubid = del.attnum
    )
  UNION
  -- (3) Every soft-deletable parent a row BELONGS to -- a NOT NULL foreign key --
  -- must be read by the policy through that key, unless the key only refers.
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_policy  p ON p.polrelid = c.oid AND p.polname = 'ai_readonly_select'
  JOIN pg_constraint fk ON fk.conrelid = c.oid AND fk.contype = 'f'
                       AND fk.confrelid <> c.oid
  JOIN pg_attribute del ON del.attrelid = fk.confrelid AND del.attname = 'deleted_at'
                       AND NOT del.attisdropped
  CROSS JOIN LATERAL (
    SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS key_columns,
           array_agg(a.attnum) AS key_attnums
      FROM unnest(fk.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE a.attname <> 'company_id'
  ) owner_key
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    -- every column of the key NOT NULL: each row has this parent
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
       WHERE a.attrelid = c.oid AND a.attnum = ANY (fk.conkey) AND NOT a.attnotnull
    )
    AND NOT EXISTS (
      SELECT 1 FROM reference_keys e
       WHERE e.table_name = c.relname::text AND e.key_columns = owner_key.key_columns
    )
    AND NOT (
      -- the policy reads the parent ...
      EXISTS (
        SELECT 1 FROM pg_depend d3
         WHERE d3.classid = 'pg_policy'::regclass AND d3.objid = p.oid
           AND d3.refclassid = 'pg_class'::regclass
           AND d3.refobjid = fk.confrelid
      )
      -- ... through this key: every column of it is read too
      AND NOT EXISTS (
        SELECT 1 FROM unnest(owner_key.key_attnums) AS k(attnum)
         WHERE NOT EXISTS (
           SELECT 1 FROM pg_depend d4
            WHERE d4.classid = 'pg_policy'::regclass AND d4.objid = p.oid
              AND d4.refclassid = 'pg_class'::regclass
              AND d4.refobjid = c.oid AND d4.refobjsubid = k.attnum
         )
      )
    )
  ORDER BY 1;
$fn$;

-- CREATE OR REPLACE keeps the ACL; the COMMENT is re-issued, and so are the
-- grants, so this file states the whole posture on its own.
COMMENT ON FUNCTION public.ai_policies_missing_soft_delete_filter() IS
  'Tables the insights sandbox can read through an ai_readonly_select policy that lets archived rows through: (1) the table has a deleted_at column the policy does not mention; (2) the policy reads another table that has one -- a parent it scopes through -- without reading that table''s deleted_at (checked in pg_depend, so it names the table, not a substring); or (3) the table''s rows belong to a soft-deletable parent through a NOT NULL foreign key and the policy does not read that parent through that key -- unless the key only refers, as the reviewed reference_keys list in this function says, with a reason for each. Should always be empty; asserted by test_ai_read_access.py. Branches (2) and (3) since 20261112193919: (2) when an archived vendor''s contacts and addresses, and six other children, were found readable; (3) when an archived quote''s lines and an archived part''s price tiers were, through company-only policies that read no parent for (2) to judge, and six more like them. Six phantom "late jobs" were reported to a shop owner in August 2026 because branch (1) held for jobs and only prose said otherwise.';

REVOKE EXECUTE ON FUNCTION public.ai_policies_missing_soft_delete_filter() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_policies_missing_soft_delete_filter() TO service_role;


-- ============================================================================
-- 3. This migration's own tables pass the guard it extends
-- ============================================================================
-- Scoped to the tables rebuilt here and the ones its reference list names, as
-- 20261110044000 scopes its check to the purchasing tables: the whole list is
-- CI's assertion, and an unrelated drift elsewhere must not hold this migration
-- hostage.
DO $check$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(t.table_name, ', ') INTO v_left
      FROM public.ai_policies_missing_soft_delete_filter() t
     WHERE t.table_name = ANY (ARRAY[
         'vendor_contacts', 'vendor_addresses', 'customer_addresses',
         'job_materials', 'job_operations', 'job_parts',
         'parts_bom', 'parts_unit_conversions',
         'quote_line_items', 'part_pricing_tiers', 'routings', 'material_lots',
         'vendor_services', 'part_vendors', 'outside_shipments',
         'outside_shipment_receipts', 'shipments',
         'vendor_purchase_orders', 'vendor_rfq_invitations']);
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'ai_policies_missing_soft_delete_filter() still flags: %', v_left;
    END IF;
END
$check$;
