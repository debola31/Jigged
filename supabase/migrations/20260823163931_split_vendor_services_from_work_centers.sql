-- ═══════════════════════════════════════════════════════════════════════════════
-- Vendor services stop pretending to be work centres.
-- ═══════════════════════════════════════════════════════════════════════════════
-- An outsourced process (anodize, heat treat, wire EDM) has lived as a
-- `work_centers` row with kind='external' and a vendor_id. That was always the
-- wrong noun: a work centre is a place in YOUR shop, and no shop owner cares
-- which cell inside the plater's building does the work.
--
-- What production actually held when this was written (prod, 2026-08-23):
--
--   * In 32 of 38 external rows the work-centre name WAS the vendor's own name,
--     character for character — 'CLAS Carbide', 'Thermal One, Inc.',
--     'PerformCoat of Michigan LLC'. The six exceptions were all demo/seed data.
--     Users were not naming a process; they were naming the vendor, because the
--     row existed only to point at one. (The import wizard's same-name vendor
--     auto-creation produced much of this shape.)
--   * 'PerformCoat of Michigan LLC' backed 201 routing steps carrying 18
--     DISTINCT prices from $1.00 to $30.00 — anodize, black oxide and chem film
--     collapsed into one row, because the model offered nowhere to put a process
--     name distinct from the supplier's. Nothing in the schema forced that; it is
--     what a missing entity invites.
--   * job_operations.operation_name is a copy of the work-centre name, so the
--     traveler step the shipper reads said 'PerformCoat of Michigan LLC' where it
--     should say 'Anodize'.
--   * 861 of 966 outside routing steps (89.1%) carried no price at all, and
--     get_priceable_part_ids excludes any part with an unpriced outside op — so
--     this was silently suppressing quotability at scale.
--
-- So: `vendor_services` becomes a real table owned by a vendor, every external
-- row MOVES into it (same uuid, so archive state and identity survive), and
-- work_centers.kind / work_centers.vendor_id are DROPPED. No vestigial rows and
-- no discriminator nobody reads.
--
-- ── The two hazards this migration exists to close ──────────────────────────
--
-- Both are silent-data-loss failures, and both come from leaving a function to
-- infer "is this outside work?" from a join that no longer resolves. Both are
-- rewritten HERE, in the same transaction that makes the columns nullable.
--
--   1. compute_job_operation_status (20260723030452) early-returns an outside
--      op's stored status. Left joining work_centers, v_kind would come back
--      NULL, the function would fall through to the completion-quantity path
--      with v_good = 0, and EVERY sent/received outside op would reset to
--      'pending' on the next part-quantity edit — losing the send stamp. It runs
--      from a trigger over every op on a part. You would find out when the
--      plater called.
--
--   2. create_job_part_operations_from_routing (20260811233748) INNER JOINs
--      work_centers. The moment routing_operations.work_center_id is nullable,
--      every outside step is silently dropped at job creation: no error, no
--      traveler step, v_seq renumbers the survivors, and the part reads complete
--      when it was never sent out.
--
-- ── Why work_centers keeps UNIQUE (company_id, name) ────────────────────────
--
-- The rejected alternative kept the rows and hid the concept, which required
-- weakening that constraint so two vendors could both offer 'Anodize'. That one
-- change silently breaks four contracts that all assume (company_id, name) is
-- unique: the work-centres importer's ON CONFLICT (42P10 -> a bare 500),
-- reviveArchivedWorkCenterByName's .maybeSingle() (PGRST116 -> revive throws),
-- checkWorkCenterNameExists' company-wide ilike, and the routings importer's
-- last-wins name lookup (which would route steps into the wrong row, silently,
-- into cost-bearing data). Giving vendor_services its own UNIQUE (vendor_id,
-- name) solves the name problem in the entity that should have owned it and
-- leaves all four contracts valid.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.vendor_services (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vendor_id   uuid NOT NULL REFERENCES public.vendors(id)   ON DELETE RESTRICT,
    name        text NOT NULL,
    description text,
    unit_price  numeric(12,4),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz,
    -- FULL, not partial: the importer upserts on it and PostgREST cannot target
    -- a partial index. Scoped to the VENDOR, not the company — two vendors may
    -- both offer 'Anodize', which is the whole point, while one vendor may not
    -- list the same service twice.
    CONSTRAINT vendor_services_unique_per_vendor UNIQUE (vendor_id, name)
);

COMMENT ON TABLE public.vendor_services IS
  'A process a vendor performs on your parts (anodize, heat treat, wire EDM). Replaces work_centers rows that carried kind=''external''. Referenced by routing_operations.vendor_service_id and job_operations.vendor_service_id. Archive via deleted_at; never hard-deleted.';

COMMENT ON COLUMN public.vendor_services.unit_price IS
  'Price per piece the vendor charges for this service. INHERITED by routing operations: cost reads COALESCE(routing_operations.external_unit_price, vendor_services.unit_price), exactly as an internal op reads COALESCE(labor_rate_override, work_centers.labor_rate). Raising it here moves every routing step that has not overridden it. NULL = not set, which makes the part unpriceable rather than free.';

COMMENT ON COLUMN public.vendor_services.name IS
  'The PROCESS, not the supplier — "Anodize", not "PerformCoat of Michigan LLC". The vendor is the parent row. job_operations.operation_name is snapshot from this, so it is what the printed traveler shows in the Work Center column.';

CREATE INDEX idx_vendor_services_company ON public.vendor_services (company_id);
CREATE INDEX idx_vendor_services_vendor   ON public.vendor_services (vendor_id);

CREATE TRIGGER vendor_services_updated_at
    BEFORE UPDATE ON public.vendor_services
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. GRANTS, RLS, POLICIES, BILLING GATE
-- ═══════════════════════════════════════════════════════════════════════════════
-- Nothing in public is exposed to the Data API automatically (20260716025048
-- revoked the permissive defaults), so these are required, not decorative.
-- anon needs nothing: a vendor's services are tenant data behind a login.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_services TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_services TO service_role;
GRANT SELECT                          ON public.vendor_services TO jigged_ai_readonly;

ALTER TABLE public.vendor_services ENABLE ROW LEVEL SECURITY;

-- The four policies mirror work_centers (baseline 5821-5845) exactly: a grant
-- decides whether a role may touch the table, RLS decides which rows.
CREATE POLICY vendor_services_select ON public.vendor_services
    FOR SELECT USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_services_insert ON public.vendor_services
    FOR INSERT WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_services_update ON public.vendor_services
    FOR UPDATE USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY vendor_services_delete ON public.vendor_services
    FOR DELETE USING (company_id IN (SELECT public.get_user_company_ids()));

-- The AI SQL surface reads work_centers this way; services are the same class of
-- data and the same scoping (baseline 5575).
CREATE POLICY ai_readonly_select ON public.vendor_services
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- Browser-writable tenant table -> it needs the restrictive billing gate, or a
-- new company_id table silently bypasses billing.
SELECT public.apply_billing_write_gate('public.vendor_services');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE POLYMORPHIC TARGET, MADE A DATABASE FACT
-- ═══════════════════════════════════════════════════════════════════════════════
-- A routing step targets exactly one of: an in-house station, or a vendor
-- service. A CHECK says so, so "both" and "neither" are unrepresentable rather
-- than a convention every future query has to remember.

ALTER TABLE public.routing_operations
    ADD COLUMN vendor_service_id uuid REFERENCES public.vendor_services(id) ON DELETE RESTRICT;

ALTER TABLE public.job_operations
    ADD COLUMN vendor_service_id uuid REFERENCES public.vendor_services(id) ON DELETE SET NULL;

CREATE INDEX idx_routing_ops_vendor_service ON public.routing_operations (vendor_service_id)
    WHERE vendor_service_id IS NOT NULL;
CREATE INDEX idx_job_ops_vendor_service ON public.job_operations (vendor_service_id)
    WHERE vendor_service_id IS NOT NULL;

COMMENT ON COLUMN public.routing_operations.vendor_service_id IS
  'Set when this step is performed by an outside vendor; work_center_id is then NULL. Exactly one of the two is set (routing_operations_exactly_one_target).';

COMMENT ON COLUMN public.job_operations.vendor_service_id IS
  'Set when this op is performed by an outside vendor. THIS is what marks an op as outside work: compute_job_operation_status branches on it, and the send/receive lifecycle applies only to these.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. ASSERT BEFORE DESTROYING
-- ═══════════════════════════════════════════════════════════════════════════════
-- Three tables hold ON DELETE RESTRICT FKs to work_centers that the UI keeps
-- internal-only but the DB never has: notes (maintenance logs),
-- work_center_attachments (machine manuals), job_operation_intervals (the
-- machine time chain). All three were verified EMPTY of external references in
-- production on 2026-08-23, but a tenant added between then and deploy is not
-- covered by that check, so assert rather than assume. Raising with the counts
-- beats a silent fallback (architecture rule: fix data at rest, never paper
-- over it at runtime).

DO $checks$
DECLARE
    v_notes       bigint;
    v_attachments bigint;
    v_intervals   bigint;
    v_snapshot    bigint;
BEGIN
    SELECT count(*) INTO v_notes
      FROM public.notes n JOIN public.work_centers w ON w.id = n.work_center_id
     WHERE w.kind = 'external';
    SELECT count(*) INTO v_attachments
      FROM public.work_center_attachments a JOIN public.work_centers w ON w.id = a.work_center_id
     WHERE w.kind = 'external';
    SELECT count(*) INTO v_intervals
      FROM public.job_operation_intervals i JOIN public.work_centers w ON w.id = i.work_center_id
     WHERE w.kind = 'external';

    IF v_notes > 0 OR v_attachments > 0 OR v_intervals > 0 THEN
        RAISE EXCEPTION
            'Cannot split vendor services: % maintenance note(s), % attachment(s) and % time interval(s) reference an external work centre. These are machine-only records with no home on a vendor service. Resolve them before running this migration.',
            v_notes, v_attachments, v_intervals
            USING ERRCODE = 'check_violation';
    END IF;

    -- A disagreement here means a work centre was flipped internal<->external
    -- after ops were cloned from it, which the kind-toggle lock was supposed to
    -- prevent. Repointing on current kind would then mis-cost frozen history, so
    -- a human decides, not this migration.
    SELECT count(*) INTO v_snapshot
      FROM public.job_operations jo JOIN public.work_centers w ON w.id = jo.work_center_id
     WHERE jo.work_center_kind_snapshot IS NOT NULL
       AND jo.work_center_kind_snapshot <> w.kind;

    IF v_snapshot > 0 THEN
        RAISE EXCEPTION
            'Cannot split vendor services: % job operation(s) carry a work_center_kind_snapshot that disagrees with their work centre current kind. Resolve which is true before running this migration.',
            v_snapshot
            USING ERRCODE = 'check_violation';
    END IF;
END
$checks$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. MOVE THE ROWS
-- ═══════════════════════════════════════════════════════════════════════════════
-- The uuid is PRESERVED. These rows are moved, not deleted and recreated, so
-- deleted_at (archive state), created_at, and every id anyone has bookmarked or
-- stored survive the change. The repoint below is then a pure column copy.
--
-- Names move VERBATIM, including the 32-of-38 that are the vendor's own name.
-- Inventing a process name here would be fabricating data the shop never
-- entered. Renaming them is a data-quality pass for the office, and the new
-- vendor page is where it happens.

INSERT INTO public.vendor_services (id, company_id, vendor_id, name, description,
                                    created_at, updated_at, deleted_at)
SELECT id, company_id, vendor_id, name, description, created_at, updated_at, deleted_at
  FROM public.work_centers
 WHERE kind = 'external';

UPDATE public.routing_operations ro
   SET vendor_service_id = ro.work_center_id,
       work_center_id    = NULL
  FROM public.work_centers wc
 WHERE wc.id = ro.work_center_id
   AND wc.kind = 'external';

UPDATE public.job_operations jo
   SET vendor_service_id = jo.work_center_id,
       work_center_id    = NULL
  FROM public.work_centers wc
 WHERE wc.id = jo.work_center_id
   AND wc.kind = 'external';

-- Only now can the CHECKs be added: they must be true of every row, and until
-- the repoint above ran, an outside op had work_center_id pointing at a row that
-- is about to stop being a work centre.
ALTER TABLE public.routing_operations
    ALTER COLUMN work_center_id DROP NOT NULL,
    ADD CONSTRAINT routing_operations_exactly_one_target
        CHECK (num_nonnulls(work_center_id, vendor_service_id) = 1);

-- job_operations.work_center_id was ALREADY nullable (its FK is ON DELETE SET
-- NULL, baseline 2599), so an op can legitimately end up with neither target if
-- its work centre is ever hard-deleted. Hence <= 1, not = 1.
ALTER TABLE public.job_operations
    ADD CONSTRAINT job_operations_at_most_one_target
        CHECK (num_nonnulls(work_center_id, vendor_service_id) <= 1);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. DROP THE CONCEPT
-- ═══════════════════════════════════════════════════════════════════════════════
-- The rows now live in vendor_services under the same ids. Deleting them here
-- completes a MOVE; it is not the archive-vs-delete question, because nothing a
-- user can see is being destroyed and deleted_at came across with the row.

DELETE FROM public.work_centers WHERE kind = 'external';

ALTER TABLE public.work_centers
    DROP CONSTRAINT work_centers_external_requires_vendor,
    DROP CONSTRAINT work_centers_internal_no_vendor,
    DROP CONSTRAINT work_centers_kind_check,
    DROP COLUMN kind,
    DROP COLUMN vendor_id;

COMMENT ON TABLE public.work_centers IS
  'A unit of in-house production capacity: a machine, cell or station with an hourly labor_rate. An operator "station" IS one of these rows. Outsourced processes are NOT here: they are vendor_services, owned by the vendor that performs them.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. REWRITE EVERY FUNCTION THAT RESOLVED "IS THIS OUTSIDE WORK?" THROUGH kind
-- ═══════════════════════════════════════════════════════════════════════════════
-- Each of these is rebuilt from its NEWEST definition, not the migration that
-- created it. Rebuilding from a creating migration silently reverts every fix
-- applied since, which this repo has been bitten by.
--
-- HAZARD 1. compute_job_operation_status used to LEFT JOIN work_centers and
-- early-return when kind='external'. After the split that join resolves to NULL
-- for outside ops, the guard would stop firing, and the completion-quantity path
-- would reset every sent/received op to 'pending' (v_good = 0) on the next
-- part-quantity edit. Branching on vendor_service_id is both the fix and simpler
-- than what it replaces: the column IS the discriminator, no join required.

CREATE OR REPLACE FUNCTION public.compute_job_operation_status(p_job_operation_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_target numeric;
    v_good numeric;
    v_vendor_service_id uuid;
    v_status text;
BEGIN
    SELECT jp.quantity, o.vendor_service_id, o.status
      INTO v_target, v_vendor_service_id, v_status
      FROM public.job_operations o
      JOIN public.job_parts jp ON jp.id = o.job_part_id
     WHERE o.id = p_job_operation_id;

    -- Outside ops are driven by the send/receive lifecycle (status set
    -- directly), NOT by completion-quantity events. Preserve their stored status
    -- so a part-quantity edit (or any completion recompute) cannot reset a
    -- sent/received op and lose its send stamp.
    IF v_vendor_service_id IS NOT NULL THEN
        RETURN v_status;
    END IF;

    SELECT COALESCE(SUM(c.quantity_good), 0) INTO v_good
      FROM public.job_operation_completions c
     WHERE c.job_operation_id = p_job_operation_id
       AND c.voided_at IS NULL;

    IF v_good <= 0 THEN
        RETURN 'pending';
    END IF;
    IF v_target IS NOT NULL AND v_good >= v_target THEN
        RETURN 'completed';
    END IF;
    RETURN 'in_progress';
END $function$;

-- HAZARD 2. create_job_part_operations_from_routing INNER JOINed work_centers.
-- With work_center_id nullable, that join would silently DROP every outside step
-- at job creation: no error, no traveler step, v_seq renumbering the survivors,
-- and the part reading complete when it was never sent out. Two LEFT JOINs, and
-- the operation_name now comes from the SERVICE ("Anodize") rather than the
-- work centre that used to carry the vendor's legal name.
--
-- work_center_kind_snapshot is still written ('external'/'internal') because it
-- is frozen history on every shipped job and insights_service.py still reads it.
-- It becomes derivable from vendor_service_id and is dropped in a later
-- migration, once this one has run clean in production.
CREATE OR REPLACE FUNCTION public.create_job_part_operations_from_routing(
    p_job_part_id uuid,
    p_routing_id uuid
) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_count integer := 0;
    v_op record;
    v_seq integer := 10;
    v_job_id uuid;
    v_part_id uuid;
    v_min_seq integer;
BEGIN
    SELECT job_id INTO v_job_id FROM job_parts WHERE id = p_job_part_id;
    IF v_job_id IS NULL THEN
        RAISE EXCEPTION 'job_part % not found', p_job_part_id;
    END IF;

    -- The routing's part_id is the parent for any BOM snapshot below.
    SELECT part_id INTO v_part_id FROM routings WHERE id = p_routing_id;
    IF v_part_id IS NULL THEN
        RAISE EXCEPTION 'routing % not found', p_routing_id;
    END IF;

    -- Snapshot routing_operations → job_operations, now including the RATES the
    -- cost of this operation will forever be measured against.
    FOR v_op IN
        SELECT ro.*,
               COALESCE(wc.name, vs.name) AS operation_name,
               (ro.vendor_service_id IS NOT NULL) AS is_outside,
               wc.labor_rate AS work_center_labor_rate,
               vs.unit_price AS vendor_service_unit_price
        FROM routing_operations ro
        LEFT JOIN work_centers    wc ON wc.id = ro.work_center_id
        LEFT JOIN vendor_services vs ON vs.id = ro.vendor_service_id
        WHERE ro.routing_id = p_routing_id
          AND NOT EXISTS (
              SELECT 1 FROM job_operations jo
              WHERE jo.job_part_id = p_job_part_id
                AND jo.routing_operation_id = ro.id
          )
        ORDER BY ro.sequence, ro.created_at
    LOOP
        INSERT INTO job_operations (
            job_id, job_part_id, sequence, operation_name, work_center_id,
            vendor_service_id,
            instructions, estimated_setup_minutes, estimated_run_minutes_per_unit,
            status, routing_operation_id,
            work_center_kind_snapshot, labor_rate_snapshot, external_unit_price_snapshot
        ) VALUES (
            v_job_id, p_job_part_id, v_seq, v_op.operation_name, v_op.work_center_id,
            v_op.vendor_service_id,
            v_op.instructions, COALESCE(v_op.setup_minutes, 0), v_op.cycle_minutes_per_unit,
            'pending', v_op.id,
            CASE WHEN v_op.is_outside THEN 'external' ELSE 'internal' END,
            CASE WHEN NOT v_op.is_outside
                 THEN COALESCE(v_op.labor_rate_override, v_op.work_center_labor_rate) END,
            -- The EFFECTIVE price, so a shipped job freezes what was actually
            -- charged rather than a NULL that later reads as "never priced".
            CASE WHEN v_op.is_outside
                 THEN COALESCE(v_op.external_unit_price, v_op.vendor_service_unit_price) END
        );
        v_seq := v_seq + 10;
        v_count := v_count + 1;
    END LOOP;

    -- Snapshot parts_bom (the part's BOM) → job_materials. Idempotent on
    -- parts_bom_id. The BOM is now part-attached, not routing-attached, so
    -- we read parts_bom WHERE parent_part_id = the routing's part.
    INSERT INTO job_materials (job_id, job_part_id, parts_bom_id, material_part_id, expected_quantity, unit)
    SELECT v_job_id, p_job_part_id, b.id, b.child_part_id, b.quantity, b.unit
    FROM parts_bom b
    WHERE b.parent_part_id = v_part_id
      AND NOT EXISTS (
          SELECT 1 FROM job_materials jm
          WHERE jm.job_part_id = p_job_part_id
            AND jm.parts_bom_id = b.id
      );

    -- Set the job_part's current operation cursor to the lowest sequence we wrote.
    SELECT MIN(sequence) INTO v_min_seq FROM job_operations WHERE job_part_id = p_job_part_id;
    IF v_min_seq IS NOT NULL THEN
        UPDATE job_parts SET current_operation_sequence = v_min_seq WHERE id = p_job_part_id;
    END IF;

    RETURN v_count;
END;
$$;

-- ── The cost engine ─────────────────────────────────────────────────────────
-- Rebuilt from 20260810180134 (bom_line_charge_basis), its newest definition.
-- Two changes only: the routing-op loop LEFT JOINs both targets and branches on
-- vendor_service_id instead of wc.kind, and the outside arm now INHERITS the
-- service price. Everything else - the material yield rules, the charge-basis
-- handling, the made-vs-bought valuation - is byte-identical.
CREATE OR REPLACE FUNCTION public.part_rollup_at_qty(
    p_part_id uuid,
    p_qty numeric,
    p_apply_charge_basis boolean
)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_source text;
    v_part_name text;
    v_routing_id uuid;
    v_total numeric := 0;
    v_op RECORD;
    v_op_cost numeric;
    v_bom RECORD;
    v_to_primary_factor numeric;
    v_qty_in_primary_unit numeric;
    v_consumed numeric;
    v_child_val_qty numeric;
    v_pinned boolean;
    v_child_cost numeric;
    v_tier_cost numeric;
BEGIN
    IF p_qty IS NULL OR p_qty <= 0 THEN
        RAISE EXCEPTION 'part_rollup_at_qty: p_qty must be > 0 (got %)', p_qty
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT source, part_name
      INTO v_source, v_part_name
      FROM public.parts
     WHERE id = p_part_id;
    IF v_source IS NULL THEN
        RAISE EXCEPTION 'part_rollup_at_qty: part % not found', p_part_id;
    END IF;

    -- ---------- Bought parts: resolve to the part's own tier sheet ----------
    -- A bought part has no BOM, so the charge-basis flag cannot apply here. Its
    -- own markup is added by the CALLER (the price rung), never by itself.
    IF v_source = 'bought' THEN
        SELECT t.cost_per_unit
          INTO v_tier_cost
          FROM public.part_procurement_tiers t
         WHERE t.part_id = p_part_id
           AND t.min_quantity <= p_qty
           AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
         ORDER BY t.cost_per_unit ASC,
                  t.min_quantity DESC
         LIMIT 1;
        -- Below every break: floor to the lowest-min tier (smallest pack you can
        -- buy) so the part is still costable, rather than returning NULL.
        IF v_tier_cost IS NULL THEN
            SELECT t.cost_per_unit
              INTO v_tier_cost
              FROM public.part_procurement_tiers t
             WHERE t.part_id = p_part_id
               AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
             ORDER BY t.min_quantity ASC,
                      t.cost_per_unit ASC
             LIMIT 1;
        END IF;
        RETURN v_tier_cost;
    END IF;

    -- ---------- Made parts: own routing + BOM rollup ----------
    SELECT id INTO v_routing_id FROM public.routings WHERE part_id = p_part_id;

    IF v_routing_id IS NOT NULL THEN
        FOR v_op IN
            SELECT ro.setup_minutes,
                   ro.cycle_minutes_per_unit,
                   ro.labor_rate_override,
                   ro.external_unit_price,
                   ro.vendor_service_id,
                   wc.labor_rate    AS wc_labor_rate,
                   vs.unit_price    AS vs_unit_price
              FROM public.routing_operations ro
              LEFT JOIN public.work_centers    wc ON wc.id = ro.work_center_id
              LEFT JOIN public.vendor_services vs ON vs.id = ro.vendor_service_id
             WHERE ro.routing_id = v_routing_id
        LOOP
            IF v_op.vendor_service_id IS NULL THEN
                IF v_op.labor_rate_override IS NULL AND v_op.wc_labor_rate IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: internal routing op has no labor rate (neither override nor work_center default)',
                        v_part_name
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := (COALESCE(v_op.setup_minutes, 0) / p_qty
                              + COALESCE(v_op.cycle_minutes_per_unit, 0))
                             * COALESCE(v_op.labor_rate_override, v_op.wc_labor_rate)
                             / 60.0;
            ELSE
                -- INHERITANCE, symmetric with the internal arm above: the step's
                -- own price wins, else the service's. Raising a vendor's price
                -- moves every step that never overrode it, exactly as raising a
                -- station's labor_rate does.
                IF v_op.external_unit_price IS NULL AND v_op.vs_unit_price IS NULL THEN
                    RAISE EXCEPTION
                        'Cannot compute cost for part %: outside routing op has no unit price (neither a step override nor a price on the vendor service)',
                        v_part_name
                        USING ERRCODE = 'check_violation';
                END IF;
                v_op_cost := COALESCE(v_op.external_unit_price, v_op.vs_unit_price);
            END IF;
            v_total := v_total + v_op_cost;
        END LOOP;
    END IF;

    FOR v_bom IN
        SELECT b.quantity,
               b.unit,
               b.child_part_id,
               b.consume_whole_units,
               b.charge_basis,
               c.primary_unit          AS child_primary_unit,
               c.part_name             AS child_part_name,
               c.source                AS child_source,
               c.costing_batch_quantity AS child_costing_batch_quantity
          FROM public.parts_bom b
          JOIN public.parts c ON c.id = b.child_part_id
         WHERE b.parent_part_id = p_part_id
    LOOP
        IF v_bom.unit IS DISTINCT FROM v_bom.child_primary_unit THEN
            SELECT to_primary_factor INTO v_to_primary_factor
              FROM public.parts_unit_conversions
             WHERE part_id = v_bom.child_part_id
               AND from_unit = v_bom.unit;
            IF v_to_primary_factor IS NULL THEN
                RAISE EXCEPTION
                    'No unit conversion from % to % for part %',
                    v_bom.unit, v_bom.child_primary_unit, v_bom.child_part_name
                    USING ERRCODE = 'check_violation';
            END IF;
            v_qty_in_primary_unit := v_bom.quantity * v_to_primary_factor;
        ELSE
            v_qty_in_primary_unit := v_bom.quantity;
        END IF;

        -- Units of the child physically consumed across the parent batch of
        -- p_qty. Whole-unit lines ceiling to discrete stock; fractional lines
        -- are exact.
        IF v_bom.consume_whole_units THEN
            v_consumed := ceil(p_qty * v_qty_in_primary_unit);
        ELSE
            v_consumed := p_qty * v_qty_in_primary_unit;
        END IF;

        -- A MADE child is valued at its standard costing lot size (setup
        -- amortized over the run it's produced in), fixed regardless of how many
        -- this order draws. A BOUGHT child is valued at what we actually consume
        -- (to hit the right procurement tier / floor).
        v_pinned := (v_bom.child_source = 'made');
        IF v_pinned THEN
            v_child_val_qty := v_bom.child_costing_batch_quantity;
        ELSE
            v_child_val_qty := v_consumed;
        END IF;

        -- THE ONE NEW BRANCH. Tier resolution for the price rung uses the SAME
        -- valuation quantity the cost path already uses — any divergence produces
        -- unexplainable quotes, and for bought material the two are identical
        -- anyway (valqty IS the consumed qty).
        IF p_apply_charge_basis AND v_bom.charge_basis = 'price' THEN
            SELECT unit_price
              INTO v_child_cost
              FROM public.compute_part_price_explain_at_qty(
                       v_bom.child_part_id, v_child_val_qty);
        ELSE
            v_child_cost := public.part_rollup_at_qty(
                v_bom.child_part_id,
                v_child_val_qty,
                p_apply_charge_basis
            );
        END IF;

        IF v_child_cost IS NULL THEN
            RETURN NULL;
        END IF;

        IF NOT v_bom.consume_whole_units AND NOT v_pinned THEN
            -- Bought child, fractional consumption — textually identical to the
            -- pre-feature expression so those lines stay byte-for-byte the same.
            v_total := v_total + v_qty_in_primary_unit * v_child_cost;
        ELSE
            -- Made (lot-size valuation) and/or whole-unit ceiling: per parent
            -- unit = consumed units × unit cost, spread across the p_qty units.
            v_total := v_total + (v_consumed * v_child_cost) / p_qty;
        END IF;
    END LOOP;

    RETURN v_total;
END;
$function$;

-- ── The two priceability verdicts, which MUST agree ─────────────────────────
-- get_priceable_part_ids answers for the Parts LIST; compute_part_cost_explain
-- answers for the DETAIL page. They are separate implementations of one rule,
-- and on 2026-08-19 they gave opposite confident answers when one drifted. The
-- predicate below is byte-parallel between them on purpose, and
-- api/tests/integration/test_priceability_agreement.py is the net.
CREATE OR REPLACE FUNCTION public.get_priceable_part_ids(p_company_id uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_costable  uuid[];
    v_ready     uuid[];
    v_priceable uuid[];
    v_new       uuid[];
BEGIN
    -- COSTABLE base case: bought parts whose purchase price is on file. This is
    -- part_has_cost_basis's 'bought' arm, expressed set-based.
    SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
    INTO v_costable
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'bought'
      AND EXISTS (
          SELECT 1
            FROM public.part_procurement_tiers t
           WHERE t.part_id = p.id
             AND (t.expires_at IS NULL OR t.expires_at >= CURRENT_DATE)
      );

    -- Everything true of a made part REGARDLESS of what is costable yet. Computed
    -- once; the loop below never re-derives it.
    SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
    INTO v_ready
    FROM public.parts p
    WHERE p.company_id = p_company_id
      AND p.source = 'made'
      -- part_has_cost_basis's 'made' arm: work, materials, or both. Neither means
      -- there is no basis, NOT that the part is free.
      AND (
          EXISTS (
              SELECT 1
                FROM public.routings r
                JOIN public.routing_operations ro ON ro.routing_id = r.id
               WHERE r.part_id = p.id
          )
          OR EXISTS (
              SELECT 1 FROM public.parts_bom b WHERE b.parent_part_id = p.id
          )
      )
      -- Every routing op must have full pricing.
      AND NOT EXISTS (
          SELECT 1
            FROM public.routings r
            JOIN public.routing_operations ro ON ro.routing_id = r.id
            LEFT JOIN public.work_centers    wc ON wc.id = ro.work_center_id
            LEFT JOIN public.vendor_services vs ON vs.id = ro.vendor_service_id
           WHERE r.part_id = p.id
             AND (
                 -- Nobody said what an hour on this station costs.
                 (ro.vendor_service_id IS NULL
                     AND ro.labor_rate_override IS NULL
                     AND wc.labor_rate IS NULL)
                 -- Or nobody said how long it takes. A rate with no time multiplies
                 -- out to zero, and zero is a PRICE — it reads as "this operation is
                 -- free" rather than "we have not costed this yet".
                 OR (ro.vendor_service_id IS NULL
                     AND ro.setup_minutes IS NULL
                     AND ro.cycle_minutes_per_unit IS NULL)
                 -- An outside process is a price per unit, and its absence is the
                 -- same silence. The step may override it; the service supplies it
                 -- otherwise. Both missing is the unpriced case.
                 OR (ro.vendor_service_id IS NOT NULL
                     AND ro.external_unit_price IS NULL
                     AND vs.unit_price IS NULL)
             )
      )
      -- A BOM line that charges its child at PRICE needs that child to carry its
      -- own markup tier. Nothing covers for a missing one. (Invariant half of the
      -- original combined NOT EXISTS.)
      AND NOT EXISTS (
          SELECT 1
            FROM public.parts_bom b
           WHERE b.parent_part_id = p.id
             AND b.charge_basis = 'price'
             AND NOT EXISTS (
                 SELECT 1
                   FROM public.part_pricing_tiers t
                  WHERE t.part_id = b.child_part_id
                    AND t.markup_percent IS NOT NULL
             )
      );

    -- Fixed point over the BOM DAG (parts_bom_no_cycles guarantees a DAG, so this
    -- terminates in at most BOM-depth iterations): a ready part becomes costable
    -- once every child it consumes is costable.
    LOOP
        SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[])
        INTO v_new
        FROM unnest(v_ready) AS r(id)
        WHERE NOT (r.id = ANY(v_costable))
          AND NOT EXISTS (
              SELECT 1
                FROM public.parts_bom b
               WHERE b.parent_part_id = r.id
                 AND NOT (b.child_part_id = ANY(v_costable))
          );

        EXIT WHEN cardinality(v_new) = 0;
        v_costable := v_costable || v_new;
    END LOOP;

    -- PRICEABLE = costable AND has its own non-null-markup pricing tier. Only the
    -- part being sold needs a markup of its own; its materials need one only when
    -- a line charges them at price (handled in v_ready above).
    SELECT COALESCE(array_agg(p.id), ARRAY[]::uuid[])
    INTO v_priceable
    FROM public.parts p
    WHERE p.id = ANY(v_costable)
      AND EXISTS (
          SELECT 1
            FROM public.part_pricing_tiers t
           WHERE t.part_id = p.id
             AND t.markup_percent IS NOT NULL
      );

    RETURN v_priceable;
END;
$function$;
CREATE OR REPLACE FUNCTION public.compute_part_cost_explain(p_part_id uuid, p_qty numeric)
 RETURNS TABLE(unit_cost numeric, missing_leaves jsonb, missing_markups jsonb, missing_op_rates jsonb, is_priceable boolean)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    v_missing_leaves   jsonb;
    v_missing_markups  jsonb;
    v_missing_op_rates jsonb;
    v_unit_cost        numeric;
BEGIN
    WITH RECURSIVE tree(part_id, part_name, source, cumulative_qty, depth, charged_at_price) AS (
        SELECT p.id, p.part_name, p.source, p_qty, 0, false
          FROM public.parts p
         WHERE p.id = p_part_id

        UNION ALL

        SELECT c.id,
               c.part_name,
               c.source,
               CASE
                   -- Made child: value its subtree at its standard costing lot
                   -- size (fixed, not the cascaded consumed qty).
                   WHEN c.source = 'made' THEN
                       c.costing_batch_quantity
                   -- Bought whole-unit line: ceiling the cascaded consumption.
                   WHEN b.consume_whole_units THEN
                       ceil(
                           t.cumulative_qty *
                           CASE
                               WHEN b.unit IS DISTINCT FROM c.primary_unit THEN
                                   b.quantity * COALESCE(
                                       (SELECT uc.to_primary_factor
                                          FROM public.parts_unit_conversions uc
                                         WHERE uc.part_id = c.id
                                           AND uc.from_unit = b.unit),
                                       1
                                   )
                               ELSE b.quantity
                           END
                       )
                   -- Bought fractional cascade.
                   ELSE
                       t.cumulative_qty *
                       CASE
                           WHEN b.unit IS DISTINCT FROM c.primary_unit THEN
                               b.quantity * COALESCE(
                                   (SELECT uc.to_primary_factor
                                      FROM public.parts_unit_conversions uc
                                     WHERE uc.part_id = c.id
                                       AND uc.from_unit = b.unit),
                                   1
                               )
                           ELSE b.quantity
                       END
               END,
               t.depth + 1,
               -- Is THIS node charged into its parent at price? Per-edge, so the
               -- same part can be cost-charged in one BOM and price-charged in
               -- another.
               b.charge_basis = 'price'
          FROM tree t
          JOIN public.parts_bom b ON b.parent_part_id = t.part_id
          JOIN public.parts c     ON c.id = b.child_part_id
         WHERE t.source = 'made'
           AND t.depth < 50
    ),
    -- A leaf is "missing" when it has NO COST BASIS AT ALL. Shared with
    -- get_priceable_part_ids via public.part_has_cost_basis so the rule cannot
    -- drift between the detail view and the list view.
    leaves AS (
        SELECT tr.part_id, tr.part_name, tr.depth, tr.cumulative_qty AS qty_required
          FROM tree tr
         WHERE NOT public.part_has_cost_basis(tr.part_id)
    ),
    -- Markup is needed by the ROOT (the part being quoted) and by any child
    -- CHARGED AT PRICE — its markup is what the parent pays, and there is no
    -- shop-wide fallback to cover for a missing tier.
    markups AS (
        SELECT tr.part_id, tr.part_name, tr.source, MIN(tr.depth) AS depth
          FROM tree tr
         WHERE (tr.depth = 0 OR tr.charged_at_price)
           AND NOT EXISTS (
                   SELECT 1 FROM public.part_pricing_tiers pt
                    WHERE pt.part_id = tr.part_id
                      AND pt.markup_percent IS NOT NULL
               )
         GROUP BY tr.part_id, tr.part_name, tr.source
    ),
    op_rates AS (
        SELECT tr.part_id, tr.part_name, MIN(tr.depth) AS depth
          FROM tree tr
          JOIN public.routings r            ON r.part_id = tr.part_id
          JOIN public.routing_operations ro ON ro.routing_id = r.id
          LEFT JOIN public.work_centers    wc ON wc.id = ro.work_center_id
          LEFT JOIN public.vendor_services vs ON vs.id = ro.vendor_service_id
         WHERE tr.source = 'made'
           AND (
               -- Nobody said what an hour on this station costs.
               (ro.vendor_service_id IS NULL
                   AND ro.labor_rate_override IS NULL
                   AND wc.labor_rate IS NULL)
               -- Or nobody said how long it takes. A rate with no time multiplies
               -- out to zero, and zero is a PRICE — it reads as "this operation is
               -- free" rather than "we have not costed this yet".
               OR (ro.vendor_service_id IS NULL
                   AND ro.setup_minutes IS NULL
                   AND ro.cycle_minutes_per_unit IS NULL)
               -- An outside process is a price per unit, and its absence is the
               -- same silence. The step may override it; the service supplies it
               -- otherwise. Both missing is the unpriced case.
               OR (ro.vendor_service_id IS NOT NULL
                   AND ro.external_unit_price IS NULL
                   AND vs.unit_price IS NULL)
           )
         GROUP BY tr.part_id, tr.part_name
    )
    SELECT
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',      l.part_id,
                            'part_name',    l.part_name,
                            'depth',        l.depth,
                            'qty_required', l.qty_required
                        )
                        ORDER BY l.depth DESC, l.part_name ASC
                    ), '[]'::jsonb)
           FROM leaves l),
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',   m.part_id,
                            'part_name', m.part_name,
                            'depth',     m.depth,
                            'source',    m.source
                        )
                        ORDER BY m.depth ASC, m.part_name ASC
                    ), '[]'::jsonb)
           FROM markups m),
        (SELECT COALESCE(
                    jsonb_agg(
                        jsonb_build_object(
                            'part_id',   o.part_id,
                            'part_name', o.part_name,
                            'depth',     o.depth
                        )
                        ORDER BY o.depth ASC, o.part_name ASC
                    ), '[]'::jsonb)
           FROM op_rates o)
      INTO v_missing_leaves, v_missing_markups, v_missing_op_rates;

    BEGIN
        v_unit_cost := public.compute_part_cost_at_qty(p_part_id, p_qty);
    EXCEPTION WHEN OTHERS THEN
        v_unit_cost := NULL;
    END;

    unit_cost        := v_unit_cost;
    missing_leaves   := v_missing_leaves;
    missing_markups  := v_missing_markups;
    missing_op_rates := v_missing_op_rates;
    is_priceable     := (v_missing_leaves = '[]'::jsonb
                         AND v_missing_markups = '[]'::jsonb
                         AND v_missing_op_rates = '[]'::jsonb);
    RETURN NEXT;
END;
$function$;
