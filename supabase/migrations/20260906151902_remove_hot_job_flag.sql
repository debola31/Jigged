-- Retire the "Hot" (rush) job marker: drop jobs.is_hot.
--
-- Shipped 20260720202151 as the digital equivalent of Contour's pink paper and a
-- red-pen "HOT". It was visibility-only by design -- no scheduling, no capacity,
-- no due-date behaviour -- and after six weeks it has gone unused: 8 of 170 jobs
-- carry it in production, none set recently, and no one asks for it. What it
-- costs is surface area: a header toggle, a checkbox in two creation modals, a
-- badge on four screens, a rubber stamp on the printed traveler, and a primary
-- sort tier threaded through three plpgsql bodies.
--
-- ORDER MATTERS. Statements run one at a time under the Supabase CLI rather than
-- in one transaction, so every function body that names the column is replaced
-- BEFORE the column goes (§2-§4, then §5). This is not tidiness: a plpgsql body
-- referencing a dropped column compiles LAZILY, so reversing the order applies
-- clean, passes `supabase db reset`, passes every static guard, and then fails
-- the first time someone actually calls the function.
--
-- Each function is rebuilt from its NEWEST definition, not from the migration
-- that introduced hot-first ordering -- restating an older body silently reverts
-- everything added between the two. Sources are named at each step.
--
-- NOT DONE, deliberately: the demo template JSON in demo_templates still carries
-- `"is_hot": true` on two jobs. That JSON lives inside migrations that have
-- already run and must never be edited, and after §4 the key is inert -- the seed
-- function no longer reads it.


-- ---------------------------------------------------------------------------
-- §1. Assert before destroying.
--
--     Verified against production pg_depend before writing this: the only
--     dependency on jobs.is_hot is the column's own DEFAULT (deptype 'a', dropped
--     with the column). No index, no CHECK, no trigger, no view, no RLS
--     predicate. This block makes that a checked claim rather than a grep
--     result, and it runs before the first irreversible statement so a surprise
--     aborts the deploy instead of being discovered by §5's RESTRICT.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_deps text;
BEGIN
    SELECT string_agg(format('%s (deptype %s)', d.classid::regclass, d.deptype), ', ')
      INTO v_deps
      FROM pg_depend d
     WHERE d.refobjid = 'public.jobs'::regclass
       AND d.refobjsubid = (SELECT attnum FROM pg_attribute
                             WHERE attrelid = 'public.jobs'::regclass
                               AND attname = 'is_hot')
       AND d.classid <> 'pg_attrdef'::regclass;

    IF v_deps IS NOT NULL THEN
        RAISE EXCEPTION 'jobs.is_hot has unexpected dependents: %', v_deps
            USING HINT = 'Drop or rewrite them here before the column goes.';
    END IF;
END $$;


-- ---------------------------------------------------------------------------
-- §2. search_jobs_by_identifier -- retained rows are newest first.
--
--     Rebuilt from 20260827114551, the newest definition. CREATE OR REPLACE: the
--     signature and return type (job_id, match_source, total_matches) are
--     unchanged, so the ACL survives and only the COMMENT needs re-issuing -- it
--     asserts the retention order in prose and would otherwise keep claiming
--     "hot first".
--
--     Two edits, both in the tail: j.is_hot leaves the `filtered` CTE, and the
--     final ORDER BY loses its leading tier. created_at DESC was already the tier
--     under it, so what the cap keeps is unchanged for every job that was not hot.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_jobs_by_identifier(
    p_company_id  uuid,
    p_query       text,
    -- Exact 'production:fulfillment' pairs for the selected lifecycle stages, built by
    -- stagesToStatusPairs() in types/job.ts. That helper enumerates the 12 combinations
    -- through getJobLifecycleStage itself rather than reading the hand-maintained
    -- STAGE_TO_JOB_FILTERS inverse: the latter ANDs two IN lists, which is exact for a
    -- single stage but a SUPERSET for a multi-select ({not_started, partially_shipped}
    -- would also admit in_progress+unshipped). A superset would make total_matches
    -- over-count and the on-screen "of N" lie, which is the whole thing we are fixing.
    -- NULL = no stage narrowing. '{}' = the user ticked nothing, which matches nothing.
    p_stage_pairs text[] DEFAULT NULL,
    p_customer_id uuid    DEFAULT NULL,
    p_overdue     boolean DEFAULT false,
    -- The CALLER's local date. Mirrors applyOverdueJobsFilter / todayLocalISODate in
    -- utils/jobsAccess.ts: the overdue day boundary is the shop's local midnight, not
    -- UTC's. Taking it as a parameter keeps the two definitions agreeing; current_date
    -- here would flip a job overdue in the search but not in the list for part of a day.
    p_today       date    DEFAULT NULL,
    p_limit       integer DEFAULT 100
) RETURNS TABLE("job_id" uuid, "match_source" text, "total_matches" bigint)
    LANGUAGE plpgsql STABLE SECURITY INVOKER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_pattern text;
    -- Hard ceiling, enforced here so no caller can talk the function past the URL cliff
    -- described above. Clamped rather than rejected: a bad p_limit should not error out
    -- a search box.
    v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
BEGIN
    IF p_query IS NULL OR length(trim(p_query)) = 0 THEN
        RETURN;
    END IF;
    v_pattern := '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';

    RETURN QUERY
    WITH deduped AS (
        -- One row per job, carrying its highest-priority match_source. The ORDER BY here
        -- is required by DISTINCT ON and is NOT the output order — see the final SELECT.
        SELECT DISTINCT ON (m.job_id) m.job_id, m.match_source
          FROM (
              SELECT j.id AS job_id, 'packing_slip'::text AS match_source, 1::int AS priority
                FROM public.jobs j
                JOIN public.job_parts jp ON jp.job_id = j.id
                JOIN public.shipment_line_items sli ON sli.job_part_id = jp.id
                JOIN public.shipments s ON s.id = sli.shipment_id
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND s.voided_at IS NULL
                 AND s.packing_slip_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'job_number'::text, 2
                FROM public.jobs j
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND j.job_number ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'customer_po'::text, 3
                FROM public.jobs j
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND j.customer_po_number ILIKE v_pattern
              UNION ALL
              -- customers.deleted_at and parts.deleted_at are deliberately NOT filtered.
              -- The jobs list renders an archived customer's and an archived part's name
              -- (retained-FK by-id reads, which architecture.md §16 exempts from the
              -- filter rule), so a name visible on screen has to stay searchable.
              SELECT j.id, 'customer'::text, 4
                FROM public.jobs j
                JOIN public.customers c ON c.id = j.customer_id
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND c.name ILIKE v_pattern
              UNION ALL
              SELECT j.id, 'part'::text, 5
                FROM public.jobs j
                JOIN public.job_parts jp ON jp.job_id = j.id
                JOIN public.parts p ON p.id = jp.part_id
               WHERE j.company_id = p_company_id
                 AND j.deleted_at IS NULL
                 AND p.part_name ILIKE v_pattern
          ) AS m
         ORDER BY m.job_id, m.priority
    ),
    filtered AS (
        -- Every filter the caller used to apply AFTER the cap now applies BEFORE it, so
        -- the rows that survive are rows the user would actually have seen.
        SELECT d.job_id, d.match_source, j.created_at
          FROM deduped d
          JOIN public.jobs j ON j.id = d.job_id
         WHERE (p_stage_pairs IS NULL
                OR (j.production_status || ':' || j.fulfillment_status) = ANY (p_stage_pairs))
           AND (p_customer_id IS NULL OR j.customer_id = p_customer_id)
           -- COALESCE on p_today, not a bare comparison: `due_date < NULL` is NULL,
           -- so an omitted date would quietly report "nothing is overdue" rather
           -- than falling back to the server's idea of today. The app always sends
           -- it; this is about the default not being a trap.
           AND (NOT COALESCE(p_overdue, false)
                OR public.is_job_late(j.due_date, j.production_status,
                                      j.fulfillment_status,
                                      COALESCE(p_today, current_date)))
    )
    -- count(*) OVER () is evaluated across the whole `filtered` set before LIMIT, so the
    -- total is exact no matter how much the cap cuts. Newest first; job_id is the
    -- tiebreak so the retained set is deterministic when created_at ties.
    SELECT f.job_id, f.match_source, count(*) OVER ()::bigint
      FROM filtered f
     ORDER BY f.created_at DESC NULLS LAST, f.job_id
     LIMIT v_limit;
END $$;


COMMENT ON FUNCTION public.search_jobs_by_identifier(uuid, text, text[], uuid, boolean, date, integer) IS
  'Extended jobs-list search across job_number, jobs.customer_po_number, customers.name, parts.part_name, shipments.packing_slip_number. Returns one row per matching non-archived job with its highest-priority match_source, plus total_matches — the exact count of matches AFTER every filter, so the UI can say "showing 120 of 843" instead of truncating silently (#688). Stage / customer / overdue filters are applied BEFORE the cap; they used to be applied by the caller after it, which cut into an arbitrary subset. Retained rows are newest first (a rush tier sorted above that until 20260906151902 dropped jobs.is_hot). p_limit is clamped to 200 because the caller round-trips these ids through a PostgREST .in() URL — see JOB_SEARCH_LIMIT in lib/queryLimits.ts; the escalation past that ceiling is a pager, not a bigger number. SECURITY INVOKER, so jobs/customers/parts RLS still enforces tenancy and p_company_id is only a narrowing filter.';


-- ---------------------------------------------------------------------------
-- §3. get_ready_operations_for_station -- the dispatch list loses its hot tier.
--
--     Rebuilt from 20260826010648, the newest definition. is_hot is IN the
--     RETURNS TABLE, and Postgres refuses to replace a function whose return type
--     changed -- so this is DROP + CREATE, which destroys BOTH the ACL and the
--     COMMENT. Section 3b re-issues the grants exactly as 20260826010648 did
--     (CLAUDE.md's DROP FUNCTION rule) and the COMMENT follows it.
--
--     function_execute_leaks() is deliberately NOT restated. This function is
--     SECURITY INVOKER and has never been on that allowlist; the entry that
--     exists there is for get_running_operation_ids_for_station, which this does
--     not touch. Re-emitting the list from anything but its newest definition is
--     how entries have silently reverted before.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_ready_operations_for_station(uuid, uuid);

CREATE FUNCTION public.get_ready_operations_for_station(
    p_company_id uuid,
    p_work_center_id uuid
)
RETURNS TABLE(
    job_id uuid,
    job_part_id uuid,
    job_operation_id uuid,
    operation_name text,
    op_status text,
    job_number text,
    part_id uuid,
    part_name text,
    part_description text,
    part_quantity numeric,
    -- NEW. True when a timer is open on this step at this station. The card reads
    -- it to mark the row, and WITHOUT the mark the row is worse than absent: an
    -- out-of-sequence step appearing under EDM with no explanation reads as the
    -- dispatch list being wrong.
    has_open_interval boolean
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    WITH running_ops AS (
        -- Evaluated once. The set is tiny (open intervals at ONE work centre --
        -- normally zero or one, since the chain allows one per machine) and this
        -- keeps the SECURITY DEFINER hop out of the per-row path.
        SELECT public.get_running_operation_ids_for_station(
                   p_company_id, p_work_center_id) AS job_operation_id
    ),
    eligible_jobs AS (
        SELECT j.id, j.job_number FROM jobs j
        WHERE j.company_id = p_company_id
          AND j.production_status IN ('not_started', 'in_progress')
    ),
    station_ops AS (
        SELECT jo.id, jo.job_id, jo.job_part_id, jo.operation_name, jo.status, jo.sequence,
               ej.job_number
        FROM job_operations jo
        JOIN eligible_jobs ej ON ej.id = jo.job_id
        WHERE jo.work_center_id = p_work_center_id
          AND jo.status IN ('pending', 'in_progress')
    ),
    ready_or_active AS (
        SELECT so.id, so.job_id, so.job_part_id, so.operation_name, so.status,
               so.job_number,
               (so.id IN (SELECT r.job_operation_id FROM running_ops r)) AS has_open_interval
        FROM station_ops so
        WHERE so.status = 'in_progress'
           -- THE NEW BRANCH. Sequence-readiness is not consulted: a step somebody
           -- is standing at is under way whatever the steps before it say, and
           -- hiding it is what stranded J-0118.
           OR so.id IN (SELECT r.job_operation_id FROM running_ops r)
           OR NOT EXISTS (
               SELECT 1 FROM job_operations prev
               WHERE prev.job_part_id = so.job_part_id
                 AND prev.sequence < so.sequence
                 AND prev.status <> 'completed'
           )
    )
    SELECT
        ra.job_id,
        ra.job_part_id,
        ra.id AS job_operation_id,
        ra.operation_name,
        ra.status AS op_status,
        ra.job_number,
        jp.part_id,
        p.part_name,
        p.description AS part_description,
        jp.quantity AS part_quantity,
        ra.has_open_interval
    FROM ready_or_active ra
    JOIN job_parts jp ON jp.id = ra.job_part_id
    JOIN parts p ON p.id = jp.part_id
    -- Running first, and now first outright: of the work that is ready, the step a
    -- machine is already turning is the one an operator walking up to this station
    -- has to deal with first, and on a busy station it would otherwise sort by job
    -- number into the middle of the pile. job_number breaks the remaining ties, so
    -- the order stays deterministic. A rush tier used to outrank both; it went with
    -- the column this migration drops.
    ORDER BY ra.has_open_interval DESC, ra.job_number;
END;
$$;

-- §3b. Re-issue what the DROP destroyed.
--
--      Copied from 20260826010648 rather than reasoned about afresh: `anon` is
--      deliberately not granted (the function is SECURITY INVOKER, an anon caller
--      reads zero rows under anon's RLS, and no anon caller exists because the
--      operator layout redirects to /login without a session).
REVOKE EXECUTE ON FUNCTION public.get_ready_operations_for_station(uuid, uuid)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_ready_operations_for_station(uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_ready_operations_for_station(uuid, uuid) IS
  'The dispatch list for one station: steps that are sequence-ready, have quantity recorded against them, or have a timer still open. The third branch was added 20260826010648 — op status derives from recorded quantity, so a started-but-nothing-produced step reads `pending`, and if it is also out of sequence it fell through every branch and appeared on no operator surface at all. Rows come back running-first, then by job number; a rush tier sorted above both until 20260906151902 dropped jobs.is_hot. SECURITY INVOKER: company isolation is RLS on jobs/job_operations, not the p_company_id argument.';


-- ---------------------------------------------------------------------------
-- §4. seed_demo_data -- the whole body, re-emitted.
--
--     Rebuilt from 20260906005845, the newest definition, NOT from 20260906005725
--     (#815's copy) or anything older. Its INSERT INTO jobs names is_hot, and
--     that is the lazy-compilation trap the header describes -- nothing in CI
--     calls this function, because supabase/seed.sql does not use it.
--
--     CREATE OR REPLACE and the signature is unchanged, so the ACL and COMMENT
--     survive. Exactly two lines differ from the source: `is_hot` leaves the
--     column list and its COALESCE leaves the VALUES list. Nothing else is edited.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_demo_data(p_company_id uuid, p_user_id uuid, p_template_name text DEFAULT 'default'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_template   jsonb;
    v_ref_map    jsonb := '{}'::jsonb;
    v_service_refs  jsonb := '[]'::jsonb;
    v_item       jsonb;
    v_inner      jsonb;
    v_leaf       jsonb;
    v_new_id     uuid;
    v_routing_id uuid;
    v_quote_id   uuid;
    v_job_id     uuid;
    v_job_part_id uuid;
    v_ship_id    uuid;
    v_note_id    uuid;
    v_op_id      uuid;
    v_part_id    uuid;
    v_cust_id    uuid;
    v_loc_id     uuid;
    v_source     text;
    v_qty        numeric;
    v_unit_price numeric;
    v_job_number text;
    v_base       text;
    v_seq        integer;
    v_members    uuid[];   -- user_company_access.id
    v_users      uuid[];   -- auth.users.id
    v_author     uuid;
    v_n_authors  integer;
BEGIN
    SELECT template_data INTO v_template
    FROM demo_data_templates
    WHERE name = p_template_name AND is_active = true
    LIMIT 1;

    IF v_template IS NULL THEN
        RAISE EXCEPTION 'No active demo template found with name: %', p_template_name;
    END IF;

    -- Two author pools, because the schema names actors two different ways and
    -- getting them backwards is a FK error at best and the wrong name on screen
    -- at worst:
    --   notes.author_id / note_reactions.reactor_id -> user_company_access.id
    --       (the MEMBERSHIP row — a note belongs to someone's membership of this
    --        company, so removing them from the company detaches it)
    --   job_operation_completions.completed_by, inventory_transactions.created_by,
    --   jobs/quotes/shipments.created_by                    -> auth.users.id
    -- Both are built in one pass ordered by user_id, so `author_index: 2` is the
    -- same person in a note and in a completion, and stays that person across
    -- resets. create_demo_company mirrors user_company_access BEFORE seeding, so
    -- the demo already has the real company's team — which is what makes the
    -- activity feed read like a shop rather than one person talking to themselves.
    SELECT COALESCE(array_agg(id      ORDER BY user_id), ARRAY[]::uuid[]),
           COALESCE(array_agg(user_id ORDER BY user_id), ARRAY[]::uuid[])
      INTO v_members, v_users
      FROM user_company_access WHERE company_id = p_company_id;
    IF array_length(v_users, 1) IS NULL THEN
        v_members := ARRAY[]::uuid[];      -- no membership row to point a note at
        v_users   := ARRAY[p_user_id];
    END IF;
    v_n_authors := array_length(v_users, 1);

    -- ---- custom units -------------------------------------------------
    IF v_template->'custom_units' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'custom_units') LOOP
            INSERT INTO company_custom_units (company_id, unit_name)
            VALUES (p_company_id, v_item#>>'{}')
            ON CONFLICT (company_id, unit_name) DO NOTHING;
        END LOOP;
    END IF;

    -- ---- storage locations --------------------------------------------
    -- Parents must be listed before their children; `parent_ref` resolves
    -- through the same map as everything else.
    IF v_template->'locations' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'locations') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO inventory_locations (id, company_id, parent_id, name, kind, sort_order)
            VALUES (v_new_id, p_company_id,
                    CASE WHEN v_item->>'parent_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'parent_ref'))::uuid END,
                    v_item->>'name',
                    v_item->>'kind',
                    COALESCE((v_item->>'sort_order')::integer, 0));
        END LOOP;
    END IF;

    -- ---- vendors + contacts -------------------------------------------
    IF v_template->'vendors' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'vendors') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            INSERT INTO vendors (id, company_id, name)
            VALUES (v_new_id, p_company_id, v_item->>'name');

            -- The address is its own row now. The TEMPLATE keeps its flat
            -- address_* keys — they still describe one address, which is all a
            -- demo vendor needs — so only the destination changed. A template
            -- entry with no street and no city produces no row at all, rather
            -- than a blank address the UI would render as "an address exists".
            IF COALESCE(v_item->>'address_line1', '') <> ''
               OR COALESCE(v_item->>'city', '') <> '' THEN
                INSERT INTO vendor_addresses (vendor_id, address_line1, address_line2,
                                              city, state, postal_code, country, is_default)
                VALUES (v_new_id, v_item->>'address_line1', v_item->>'address_line2',
                        v_item->>'city', v_item->>'state', v_item->>'postal_code',
                        COALESCE(v_item->>'country', 'USA'), true);
            END IF;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'contacts', '[]'::jsonb)) LOOP
                INSERT INTO vendor_contacts (vendor_id, name, role, role_label, email, phone, is_primary)
                VALUES (v_new_id, v_inner->>'name',
                        COALESCE(v_inner->>'role', 'sales'), v_inner->>'role_label',
                        v_inner->>'email', v_inner->>'phone',
                        COALESCE((v_inner->>'is_primary')::boolean, false));
            END LOOP;
        END LOOP;
    END IF;

    -- ---- work centers and vendor services ------------------------------
    -- One template array still feeds both, because the template's own shape is
    -- fine: an entry with kind='external' and a vendor_ref has always described
    -- a vendor's service rather than a station. Only the destination changed,
    -- so no template row needs rewriting.
    --
    -- v_service_refs records which _refs became services, so the routing loop
    -- below knows which of the two target columns to fill. The _ref -> uuid map
    -- stays shared, so a template's work_center_ref keeps resolving either way.
    IF v_template->'work_centers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'work_centers') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));

            IF COALESCE(v_item->>'kind', 'internal') = 'external' THEN
                v_service_refs := v_service_refs || jsonb_build_array(v_item->>'_ref');
                INSERT INTO vendor_services (id, company_id, vendor_id, name, description, unit_price)
                VALUES (v_new_id, p_company_id,
                        (v_ref_map->>(v_item->>'vendor_ref'))::uuid,
                        v_item->>'name',
                        v_item->>'description',
                        NULLIF(v_item->>'unit_price', '')::numeric);
            ELSE
                INSERT INTO work_centers (id, company_id, name, labor_rate, description,
                                          make, model, serial_number, year_built, purchased_on)
                VALUES (v_new_id, p_company_id, v_item->>'name',
                        NULLIF(v_item->>'labor_rate', '')::numeric,
                        v_item->>'description',
                        v_item->>'make', v_item->>'model', v_item->>'serial_number',
                        NULLIF(v_item->>'year_built', '')::integer,
                        CASE WHEN v_item->>'purchased_years_ago' IS NOT NULL
                             THEN (CURRENT_DATE - make_interval(years =>
                                      (v_item->>'purchased_years_ago')::integer))::date END);
            END IF;
        END LOOP;
    END IF;

    -- ---- parts, with their tiers, conversions and shelf balances -------
    IF v_template->'parts' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts') LOOP
            v_new_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_new_id::text));
            v_source := COALESCE(v_item->>'source', 'made');

            -- quantity is DERIVED from part_location_stock by trigger. When the
            -- template places stock on named shelves we insert the part at 0 and
            -- let `recompute_part_quantity_from_locations` do the arithmetic;
            -- with no `stock` array we pass the quantity through and
            -- `seed_new_part_balance` parks it at Unassigned. Never write both
            -- — that is how a part ends up counted twice.
            INSERT INTO parts (id, company_id, part_name, description, source,
                               primary_unit, quantity, reorder_point,
                               costing_batch_quantity, preferred_vendor_id)
            VALUES (v_new_id, p_company_id, v_item->>'part_name', v_item->>'description',
                    v_source,
                    COALESCE(v_item->>'primary_unit', 'each'),
                    CASE WHEN v_item->'stock' IS NOT NULL THEN 0
                         ELSE COALESCE((v_item->>'quantity')::numeric, 0) END,
                    NULLIF(v_item->>'reorder_point', '')::numeric,
                    COALESCE((v_item->>'costing_batch_quantity')::numeric, 1),
                    CASE WHEN v_item->>'preferred_vendor_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'preferred_vendor_ref'))::uuid END);

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'stock', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                CONTINUE WHEN v_qty IS NULL OR v_qty <= 0;  -- CHECK: quantity > 0
                INSERT INTO part_location_stock (company_id, part_id, location_id, quantity)
                VALUES (p_company_id, v_new_id,
                        (v_ref_map->>(v_inner->>'location_ref'))::uuid, v_qty);
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'procurement_tiers', '[]'::jsonb)) LOOP
                INSERT INTO part_procurement_tiers (part_id, min_quantity, cost_per_unit,
                                                    quoted_at, expires_at, notes)
                VALUES (v_new_id,
                        (v_inner->>'min_quantity')::numeric,
                        (v_inner->>'cost_per_unit')::numeric,
                        CASE WHEN v_inner->>'quoted_days_ago' IS NOT NULL
                             THEN (CURRENT_DATE - (v_inner->>'quoted_days_ago')::integer) END,
                        CASE WHEN v_inner->>'expires_in_days' IS NOT NULL
                             THEN (CURRENT_DATE + (v_inner->>'expires_in_days')::integer) END,
                        v_inner->>'notes');
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'pricing_tiers', '[]'::jsonb)) LOOP
                INSERT INTO part_pricing_tiers (part_id, company_id, sequence, quantity, markup_percent)
                VALUES (v_new_id, p_company_id,
                        (v_inner->>'sequence')::integer,
                        (v_inner->>'quantity')::numeric,
                        NULLIF(v_inner->>'markup_percent', '')::numeric);
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'unit_conversions', '[]'::jsonb)) LOOP
                INSERT INTO parts_unit_conversions (part_id, from_unit, to_primary_factor)
                VALUES (v_new_id, v_inner->>'from_unit', (v_inner->>'to_primary_factor')::numeric);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- BOM ------------------------------------------------------------
    IF v_template->'parts_bom' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'parts_bom') LOOP
            INSERT INTO parts_bom (parent_part_id, child_part_id, quantity, unit, sequence,
                                   notes)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0),
                    v_item->>'notes');
        END LOOP;
    END IF;

    -- ---- routings --------------------------------------------------------
    IF v_template->'routings' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'routings') LOOP
            v_routing_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_routing_id::text));
            INSERT INTO routings (id, company_id, part_id, name, description, created_by)
            VALUES (v_routing_id, p_company_id,
                    (v_ref_map->>(v_item->>'part_ref'))::uuid,
                    v_item->>'name', v_item->>'description', p_user_id);

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'operations', '[]'::jsonb)) LOOP
                -- Exactly one target, per routing_operations_exactly_one_target.
                INSERT INTO routing_operations (routing_id, work_center_id, vendor_service_id, sequence,
                                                setup_minutes, cycle_minutes_per_unit,
                                                labor_rate_override, external_unit_price, instructions)
                VALUES (v_routing_id,
                        CASE WHEN NOT (v_service_refs ? (v_inner->>'work_center_ref'))
                             THEN (v_ref_map->>(v_inner->>'work_center_ref'))::uuid END,
                        CASE WHEN v_service_refs ? (v_inner->>'work_center_ref')
                             THEN (v_ref_map->>(v_inner->>'work_center_ref'))::uuid END,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        NULLIF(v_inner->>'setup_minutes', '')::numeric,
                        NULLIF(v_inner->>'cycle_minutes_per_unit', '')::numeric,
                        NULLIF(v_inner->>'labor_rate_override', '')::numeric,
                        NULLIF(v_inner->>'external_unit_price', '')::numeric,
                        v_inner->>'instructions');
            END LOOP;
        END LOOP;
    END IF;

    -- ---- customers, contacts, addresses ---------------------------------
    -- The embedded contact_*/address_* columns were dropped from `customers`;
    -- both are now child tables, and `jobs`/`quotes` reference them by id.
    IF v_template->'customers' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'customers') LOOP
            v_cust_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_cust_id::text));
            INSERT INTO customers (id, company_id, name, default_payment_terms,
                                   credit_status, credit_hold_note)
            VALUES (v_cust_id, p_company_id, v_item->>'name',
                    v_item->>'default_payment_terms',
                    COALESCE(v_item->>'credit_status', 'open'),
                    v_item->>'credit_hold_note');

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'contacts', '[]'::jsonb)) LOOP
                v_new_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_new_id::text));
                END IF;
                INSERT INTO customer_contacts (id, customer_id, name, role, role_label,
                                               email, phone, is_primary, is_billing_default)
                VALUES (v_new_id, v_cust_id, v_inner->>'name',
                        COALESCE(v_inner->>'role', 'buyer'), v_inner->>'role_label',
                        v_inner->>'email', v_inner->>'phone',
                        COALESCE((v_inner->>'is_primary')::boolean, false),
                        COALESCE((v_inner->>'is_billing_default')::boolean, false));
            END LOOP;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'addresses', '[]'::jsonb)) LOOP
                v_new_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_new_id::text));
                END IF;
                INSERT INTO customer_addresses (id, customer_id, address_line1, address_line2,
                                                city, state, postal_code, country, attention_to,
                                                default_billing, default_shipping)
                VALUES (v_new_id, v_cust_id, v_inner->>'address_line1', v_inner->>'address_line2',
                        v_inner->>'city', v_inner->>'state', v_inner->>'postal_code',
                        COALESCE(v_inner->>'country', 'USA'), v_inner->>'attention_to',
                        COALESCE((v_inner->>'default_billing')::boolean, false),
                        COALESCE((v_inner->>'default_shipping')::boolean, false));
            END LOOP;
        END LOOP;
    END IF;

    -- ---- quotes ----------------------------------------------------------
    -- quote_number is minted by the set_quote_number trigger off the shared
    -- per-company counter, exactly as the app gets it. Reset clears that counter
    -- so a re-seeded demo starts at Q-0001 again instead of drifting upward.
    IF v_template->'quotes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'quotes') LOOP
            v_quote_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_quote_id::text));
            INSERT INTO quotes (id, company_id, customer_id, status, expiration_date,
                                lead_time_text, payment_terms,
                                billing_address_id, shipping_address_id, contact_id,
                                created_by, created_at)
            VALUES (v_quote_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid END,
                    COALESCE(v_item->>'status', 'active'),
                    CASE WHEN v_item->>'expires_in_days' IS NOT NULL
                         THEN (CURRENT_DATE + (v_item->>'expires_in_days')::integer) END,
                    v_item->>'lead_time_text',
                    v_item->>'payment_terms',
                    CASE WHEN v_item->>'billing_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'billing_address_ref'))::uuid END,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    CASE WHEN v_item->>'contact_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'contact_ref'))::uuid END,
                    p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'created_days_ago')::integer, 0)));

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'line_items', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                v_unit_price := (v_inner->>'unit_price')::numeric;
                INSERT INTO quote_line_items (quote_id, company_id, part_id, sequence, quantity,
                                              unit_price, total_price, markup_percent,
                                              base_cost_per_unit, lead_time_text)
                VALUES (v_quote_id, p_company_id,
                        (v_ref_map->>(v_inner->>'part_ref'))::uuid,
                        COALESCE((v_inner->>'sequence')::integer, 10),
                        v_qty, v_unit_price,
                        COALESCE(NULLIF(v_inner->>'total_price', '')::numeric,
                                 round(v_qty * v_unit_price, 4)),
                        NULLIF(v_inner->>'markup_percent', '')::numeric,
                        NULLIF(v_inner->>'base_cost_per_unit', '')::numeric,
                        v_inner->>'lead_time_text');
            END LOOP;
        END LOOP;
    END IF;

    -- ---- jobs -------------------------------------------------------------
    IF v_template->'jobs' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'jobs') LOOP
            v_job_id := gen_random_uuid();
            v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_job_id::text));
            v_job_number := COALESCE(v_item->>'job_number', generate_direct_job_number(p_company_id));

            INSERT INTO jobs (id, company_id, customer_id, quote_id, job_number,
                              production_status, fulfillment_status, invoicing_status,
                              due_date, customer_po_number,
                              payment_terms, freight_terms, ship_via, shipping_instructions,
                              billing_address_id, shipping_address_id, contact_id,
                              created_by, created_at)
            VALUES (v_job_id, p_company_id,
                    CASE WHEN v_item->>'customer_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'customer_ref'))::uuid END,
                    CASE WHEN v_item->>'quote_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'quote_ref'))::uuid END,
                    v_job_number,
                    'not_started', 'unshipped', 'uninvoiced',
                    CASE WHEN v_item->>'due_in_days' IS NOT NULL
                         THEN (CURRENT_DATE + (v_item->>'due_in_days')::integer) END,
                    v_item->>'customer_po_number',
                    v_item->>'payment_terms', v_item->>'freight_terms',
                    v_item->>'ship_via', v_item->>'shipping_instructions',
                    CASE WHEN v_item->>'billing_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'billing_address_ref'))::uuid END,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    CASE WHEN v_item->>'contact_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'contact_ref'))::uuid END,
                    p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'created_days_ago')::integer, 0)));

            -- A quote that produced a job is converted, by definition.
            IF v_item->>'quote_ref' IS NOT NULL THEN
                UPDATE quotes SET converted_at = COALESCE(converted_at, now())
                 WHERE id = (v_ref_map->>(v_item->>'quote_ref'))::uuid;
            END IF;

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'parts', '[]'::jsonb)) LOOP
                v_job_part_id := gen_random_uuid();
                IF v_inner->>'_ref' IS NOT NULL THEN
                    v_ref_map := jsonb_set(v_ref_map, ARRAY[v_inner->>'_ref'], to_jsonb(v_job_part_id::text));
                END IF;
                v_part_id := (v_ref_map->>(v_inner->>'part_ref'))::uuid;
                v_qty := COALESCE((v_inner->>'quantity')::numeric, 1);
                v_unit_price := NULLIF(v_inner->>'unit_price', '')::numeric;

                -- A bought part has no operations to run, so createJobFromPO
                -- lands it 'completed' on creation. Mirror that, and let made
                -- parts be driven entirely by their completions below.
                v_source := COALESCE(v_inner->>'source', 'made');
                INSERT INTO job_parts (id, job_id, company_id, part_id, sequence, quantity,
                                       unit_price, total_price,
                                       production_status, fulfillment_status, invoicing_status,
                                       started_at, completed_at)
                VALUES (v_job_part_id, v_job_id, p_company_id, v_part_id,
                        COALESCE((v_inner->>'sequence')::integer, 10), v_qty,
                        v_unit_price,
                        CASE WHEN v_unit_price IS NOT NULL THEN round(v_qty * v_unit_price, 4) END,
                        CASE WHEN v_source = 'bought' THEN 'completed' ELSE 'not_started' END,
                        'unshipped', 'uninvoiced',
                        CASE WHEN v_source = 'bought' THEN now() END,
                        CASE WHEN v_source = 'bought' THEN now() END);

                IF v_inner->>'routing_ref' IS NOT NULL THEN
                    PERFORM create_job_part_operations_from_routing(
                        v_job_part_id, (v_ref_map->>(v_inner->>'routing_ref'))::uuid);
                END IF;

                -- Progress is expressed the way the shop floor expresses it: a
                -- completion event per operation. The triggers then derive the
                -- operation status, the job_part's, and the job's — so the demo
                -- can never hold a status combination the app cannot produce.
                FOR v_leaf IN SELECT * FROM jsonb_array_elements(COALESCE(v_inner->'operations', '[]'::jsonb)) LOOP
                    SELECT id INTO v_op_id FROM job_operations
                     WHERE job_part_id = v_job_part_id
                       AND sequence = (v_leaf->>'sequence')::integer;
                    CONTINUE WHEN v_op_id IS NULL;

                    -- Outside ops are driven by the send/receive lifecycle, not
                    -- by quantity events (compute_job_operation_status returns
                    -- their stored status untouched), so they are set directly.
                    IF v_leaf->>'status' IS NOT NULL THEN
                        UPDATE job_operations
                           SET status = v_leaf->>'status',
                               sent_at = CASE WHEN v_leaf->>'status' IN ('sent', 'completed')
                                              THEN now() - make_interval(days =>
                                                   COALESCE((v_leaf->>'days_ago')::integer, 1)) END,
                               sent_by = CASE WHEN v_leaf->>'status' IN ('sent', 'completed')
                                              THEN p_user_id END,
                               completed_at = CASE WHEN v_leaf->>'status' = 'completed'
                                              THEN now() - make_interval(days =>
                                                   COALESCE((v_leaf->>'days_ago')::integer, 0)) END
                         WHERE id = v_op_id;
                    END IF;

                    IF v_leaf->>'completed_quantity' IS NOT NULL THEN
                        v_author := v_users[1 + (COALESCE((v_leaf->>'author_index')::integer, 0)
                                                 % v_n_authors)];
                        INSERT INTO job_operation_completions
                            (company_id, job_operation_id, job_part_id, quantity_good,
                             completed_by, completed_at, note)
                        VALUES (p_company_id, v_op_id, v_job_part_id,
                                (v_leaf->>'completed_quantity')::numeric,
                                v_author,
                                now() - make_interval(days =>
                                        COALESCE((v_leaf->>'days_ago')::integer, 0)),
                                v_leaf->>'note');
                    END IF;
                END LOOP;

                -- External ops set above bypass the completion trigger, so roll
                -- the job_part up explicitly; that UPDATE fires the part->job
                -- sync in turn.
                UPDATE job_parts jp
                   SET production_status = compute_job_part_production_status(jp.id),
                       current_operation_sequence = COALESCE(
                           (SELECT min(o.sequence) FROM job_operations o
                             WHERE o.job_part_id = jp.id AND o.status <> 'completed'),
                           (SELECT max(o.sequence) FROM job_operations o
                             WHERE o.job_part_id = jp.id))
                 WHERE jp.id = v_job_part_id
                   AND jp.production_status IS DISTINCT FROM compute_job_part_production_status(jp.id);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- shipments --------------------------------------------------------
    -- Inserted directly rather than through create_shipment_with_line_items:
    -- that RPC gates on auth.uid()'s company access, which is not a dependency a
    -- seeder should carry. The packing-slip formula is the RPC's, verbatim
    -- (PS-{job_number minus alpha prefix}-{nth shipment on that job}).
    IF v_template->'shipments' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'shipments') LOOP
            v_ship_id := gen_random_uuid();
            v_job_id  := (v_ref_map->>(v_item->>'job_ref'))::uuid;
            SELECT job_number INTO v_job_number FROM jobs WHERE id = v_job_id;
            v_base := regexp_replace(v_job_number, '^[A-Za-z]+-?', '');
            SELECT count(*) + 1 INTO v_seq FROM shipments WHERE job_id = v_job_id;

            INSERT INTO shipments (id, company_id, customer_id, job_id, shipping_address_id,
                                   packing_slip_number, ship_date, carrier, shipping_method,
                                   freight_terms, created_by, created_at)
            VALUES (v_ship_id, p_company_id,
                    (v_ref_map->>(v_item->>'customer_ref'))::uuid, v_job_id,
                    CASE WHEN v_item->>'shipping_address_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'shipping_address_ref'))::uuid END,
                    'PS-' || v_base || '-' || v_seq::text,
                    CURRENT_DATE - COALESCE((v_item->>'ship_days_ago')::integer, 0),
                    v_item->>'carrier',
                    COALESCE(v_item->>'shipping_method', 'shipment'),
                    v_item->>'freight_terms', p_user_id,
                    now() - make_interval(days => COALESCE((v_item->>'ship_days_ago')::integer, 0)));

            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'line_items', '[]'::jsonb)) LOOP
                v_qty := (v_inner->>'quantity')::numeric;
                CONTINUE WHEN v_qty IS NULL OR v_qty <= 0;
                INSERT INTO shipment_line_items (shipment_id, job_part_id, quantity)
                VALUES (v_ship_id, (v_ref_map->>(v_inner->>'job_part_ref'))::uuid, v_qty);
            END LOOP;
        END LOOP;
    END IF;

    -- ---- notes / activity feed -------------------------------------------
    IF v_template->'notes' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'notes') LOOP
            v_note_id := gen_random_uuid();
            IF v_item->>'_ref' IS NOT NULL THEN
                v_ref_map := jsonb_set(v_ref_map, ARRAY[v_item->>'_ref'], to_jsonb(v_note_id::text));
            END IF;
            -- NULL author when the company somehow has no membership rows: an
            -- unattributed note is a real state the UI renders, a dangling FK is not.
            v_author := CASE WHEN array_length(v_members, 1) IS NULL THEN NULL
                        ELSE v_members[1 + (COALESCE((v_item->>'author_index')::integer, 0)
                                            % array_length(v_members, 1))] END;

            INSERT INTO notes (id, company_id, subject_kind, note_type, body, author_id,
                               job_id, job_part_id, job_operation_id,
                               part_id, work_center_id, maintenance_kind, resolves_note_id,
                               created_at)
            VALUES (v_note_id, p_company_id,
                    v_item->>'subject_kind',
                    COALESCE(v_item->>'note_type', 'user'),
                    v_item->>'body', v_author,
                    CASE WHEN v_item->>'job_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'job_ref'))::uuid END,
                    CASE WHEN v_item->>'job_part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'job_part_ref'))::uuid END,
                    CASE WHEN v_item->>'job_part_ref' IS NOT NULL
                          AND v_item->>'operation_sequence' IS NOT NULL
                         THEN (SELECT id FROM job_operations
                                WHERE job_part_id = (v_ref_map->>(v_item->>'job_part_ref'))::uuid
                                  AND sequence = (v_item->>'operation_sequence')::integer) END,
                    CASE WHEN v_item->>'part_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'part_ref'))::uuid END,
                    CASE WHEN v_item->>'work_center_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'work_center_ref'))::uuid END,
                    v_item->>'maintenance_kind',
                    CASE WHEN v_item->>'resolves_ref' IS NOT NULL
                         THEN (v_ref_map->>(v_item->>'resolves_ref'))::uuid END,
                    now() - make_interval(days => COALESCE((v_item->>'days_ago')::integer, 0)));

            CONTINUE WHEN array_length(v_members, 1) IS NULL;  -- reactor_id is NOT NULL
            FOR v_inner IN SELECT * FROM jsonb_array_elements(COALESCE(v_item->'reactions', '[]'::jsonb)) LOOP
                v_author := v_members[1 + (COALESCE((v_inner->>'reactor_index')::integer, 0)
                                           % array_length(v_members, 1))];
                INSERT INTO note_reactions (company_id, note_id, reactor_id, kind)
                VALUES (p_company_id, v_note_id, v_author, COALESCE(v_inner->>'kind', 'helpful'))
                ON CONFLICT DO NOTHING;
            END LOOP;
        END LOOP;
    END IF;

    -- ---- inventory movement history --------------------------------------
    -- The ledger only; balances already come from part_location_stock above.
    -- Writing both is deliberate: the transaction rows are what the Storage
    -- history reads, and they are a log, not a source of truth for quantity.
    IF v_template->'inventory_transactions' IS NOT NULL THEN
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_template->'inventory_transactions') LOOP
            v_part_id := (v_ref_map->>(v_item->>'part_ref'))::uuid;
            v_loc_id  := CASE WHEN v_item->>'location_ref' IS NOT NULL
                              THEN (v_ref_map->>(v_item->>'location_ref'))::uuid END;
            v_qty     := (v_item->>'quantity')::numeric;
            v_author  := v_users[1 + (COALESCE((v_item->>'author_index')::integer, 0) % v_n_authors)];

            INSERT INTO inventory_transactions (company_id, part_id, item_name, type, quantity,
                                                unit, converted_quantity, location_id,
                                                job_id, notes, created_by, created_at)
            SELECT p_company_id, v_part_id, p.part_name, v_item->>'type', v_qty,
                   COALESCE(v_item->>'unit', p.primary_unit),
                   COALESCE(NULLIF(v_item->>'converted_quantity', '')::numeric, v_qty),
                   v_loc_id,
                   CASE WHEN v_item->>'job_ref' IS NOT NULL
                        THEN (v_ref_map->>(v_item->>'job_ref'))::uuid END,
                   v_item->>'notes', v_author,
                   now() - make_interval(days => COALESCE((v_item->>'days_ago')::integer, 0))
              FROM parts p WHERE p.id = v_part_id;
        END LOOP;
    END IF;
END;
$function$;


-- ---------------------------------------------------------------------------
-- §5. Finally, the column itself.
--
--     Plain RESTRICT, not CASCADE. §1 proved nothing depends on it; if that is
--     somehow wrong on a database this has not seen, RESTRICT raises and the
--     deploy stops, where CASCADE would quietly take the dependent with it.
--
--     8 of 170 production jobs carry the flag today. They keep everything else;
--     what is discarded is a boolean nothing reads.
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs DROP COLUMN is_hot;
