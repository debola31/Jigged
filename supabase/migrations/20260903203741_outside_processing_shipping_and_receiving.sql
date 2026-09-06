-- ============================================================================
-- OUTSIDE PROCESSING: SHIPPING & RECEIVING
-- ============================================================================
-- An outside operation (vendor_service_id IS NOT NULL) means parts physically
-- leave the building. Until now that was recorded as four columns on
-- job_operations -- sent_at/sent_by, completed_at/completed_by -- flipped by a
-- Mark Sent Out / Mark Received button pair. A state flag, not a record: no
-- document, no quantity, no ship-to address, no due-back date, and an Undo that
-- erased the only trace a send ever happened.
--
-- This migration makes the SEND a row. Four decisions drive everything below:
--
--   1. GRAIN. One outside_shipments row = one job_operations row + a quantity.
--      An operation may have MANY: send 50 now, 50 next week.
--   2. SHIPPING IS THE SEND. There is no state-only write left. job_operations
--      .status/.sent_at/.sent_by are DERIVED from these tables and a guard
--      trigger refuses a hand-written one, so paperwork and status cannot
--      diverge.
--   3. QUANTITIES DRIVE STATUS, exactly as in-house completions do. This
--      REVERSES the outside-op exemption in compute_job_operation_status.
--   4. NO PURCHASE ORDERS. The slip is the outside-work document and it works
--      with no accounting system connected.
--
-- WHY THE 20260823163931 HAZARD DOES NOT COME BACK. That migration added an
-- early return for outside ops because recompute_job_ops_status_from_part_qty()
-- runs the status function over EVERY op on a part when job_parts.quantity is
-- edited, and with v_good = 0 a sent op reset to 'pending' and lost its stamp.
-- Removing the exemption is safe now BY CONSTRUCTION: the outside arm reads
-- outside_shipments and outside_shipment_receipts, and a quantity edit writes
-- neither. sent_at survives for the same reason -- it is a mirror of the
-- shipment row, so there is nothing left on job_operations to lose.
--
-- ORDERING IS DELIBERATE (see section 7): the backfill runs BEFORE the triggers
-- are attached, so it is a pure data move, and one reconcile sweep settles every
-- status at rest afterward.
-- ============================================================================


-- ============================================================================
-- 1. outside_shipments -- one send, one operation, one quantity
-- ============================================================================

CREATE TABLE public.outside_shipments (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

    -- Denormalized from the operation, as job_operation_completions carries
    -- job_part_id. job_id is not convenience: the per-job slip counter reads it
    -- under an advisory lock and must not need a two-hop join to do it.
    job_id             uuid NOT NULL REFERENCES public.jobs(id)           ON DELETE CASCADE,
    job_part_id        uuid NOT NULL REFERENCES public.job_parts(id)      ON DELETE CASCADE,
    job_operation_id   uuid NOT NULL REFERENCES public.job_operations(id) ON DELETE CASCADE,

    -- WHERE IT WENT, resolved from the op's vendor_service at send time.
    -- RESTRICT on the vendor, like vendor_services.vendor_id: vendors archive,
    -- they do not hard-delete, and a delete that silently took shipping history
    -- with it would be data loss with no warning.
    vendor_id          uuid NOT NULL REFERENCES public.vendors(id)          ON DELETE RESTRICT,
    vendor_address_id  uuid          REFERENCES public.vendor_addresses(id) ON DELETE SET NULL,
    vendor_contact_id  uuid          REFERENCES public.vendor_contacts(id)  ON DELETE SET NULL,

    -- Document Snapshot Standard (docs/architecture.md). The slip left the
    -- building; renaming a vendor or archiving a service must not rewrite it.
    -- jsonb shapes are AddressSnapshot / ContactSnapshot in types/documentSnapshot.ts.
    vendor_name        text NOT NULL,
    service_name       text NOT NULL,
    ship_to_address    jsonb,
    ship_to_contact    jsonb,

    slip_number        text NOT NULL,
    quantity           numeric NOT NULL,

    -- ONE COLUMN, timestamptz, not a (date, time) pair and not a bare date.
    -- job_operations.sent_at is timestamptz and the /activity feed sorts on it
    -- (utils/dashboardAccess.ts fetchOperationActivity); a date here would force
    -- a lossy cast on the one reader that matters. Backdating a send writes an
    -- earlier timestamptz; the printed slip renders shipped_at::date.
    shipped_at         timestamptz NOT NULL DEFAULT now(),
    -- A PROMISE, not an event, so a date is the honest type -- the same
    -- asymmetry jobs.due_date has beside jobs.created_at.
    due_back_on        date,

    carrier            text,
    notes              text,

    created_by         uuid REFERENCES auth.users(id),
    voided_at          timestamptz,
    voided_by          uuid REFERENCES auth.users(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    -- The only hard quantity floor, following shipments rather than invoices:
    -- over-sending 110 of a 100-piece order is legitimate (you made extras) and
    -- is warned in the UI, never blocked here.
    CONSTRAINT outside_shipments_quantity_positive CHECK (quantity > 0),
    CONSTRAINT outside_shipments_notes_not_blank
        CHECK (notes IS NULL OR length(btrim(notes)) > 0),
    -- Voided is ONE fact in two columns and they may not disagree.
    CONSTRAINT outside_shipments_voided_pair
        CHECK ((voided_at IS NULL) = (voided_by IS NULL)),
    -- A minting bug surfaces as 23505 rather than as two slips the plater cannot
    -- tell apart. Company-scoped because the number embeds the job base, which is.
    CONSTRAINT outside_shipments_slip_unique UNIQUE (company_id, slip_number),
    -- The target of the receipts' composite FK below. It makes a receipt whose
    -- denormalized ids disagree with its shipment UNREPRESENTABLE, rather than a
    -- rule three future queries have to remember.
    CONSTRAINT outside_shipments_identity_unique
        UNIQUE (id, company_id, job_operation_id, job_part_id)
);

-- DELIBERATELY ABSENT: a CHECK (due_back_on >= shipped_at::date).
-- timestamptz::date is STABLE, not IMMUTABLE (it reads TimeZone), so Postgres
-- refuses it in a CHECK with an error that reads like a typo. It is validated in
-- create_outside_shipment instead.
--
-- DELIBERATELY ABSENT: deleted_at. A shipment is VOIDED, never archived -- the
-- same posture as `shipments`, and for the same reason: it is a document the
-- vendor is holding, so a correction is a void plus a new slip.

COMMENT ON TABLE public.outside_shipments IS
  'One send of a quantity of parts to an outside vendor for ONE job_operations row. An operation may have many: send 50 now, 50 next week. THIS TABLE IS THE SEND -- there is no separate "mark sent out" write, and job_operations.sent_at/sent_by are a trigger-maintained mirror of the first live row here, never a source. Voided, never archived (no deleted_at). Slip numbers are VPS-{jobBase}-{n}, minted in create_outside_shipment under an advisory lock.';

COMMENT ON COLUMN public.outside_shipments.quantity IS
  'Pieces that physically left the building on this slip. Summed over live rows this is "how many went out"; minus the receipts it is "how many are still at the vendor", which is what makes compute_job_operation_status return ''sent''. Only quantity > 0 is enforced -- over-sending is warned in the UI, never blocked, following shipments rather than invoices.';

COMMENT ON COLUMN public.outside_shipments.shipped_at IS
  'When the parts left. timestamptz so job_operations.sent_at can mirror it exactly and the /activity feed can sort on it. Backdating writes an earlier value; the printed slip renders shipped_at::date. There is deliberately no separate date column -- two columns for one fact drift.';

COMMENT ON COLUMN public.outside_shipments.slip_number IS
  'VPS-{jobBase}-{n} -- Vendor Packing Slip. BOTH documents print the title "PACKING SLIP", because that is what each one is to the person opening the box, so the NUMBER is the only thing that says which is which and it has to carry that alone. V names who it is for, the distinction that actually matters. Deliberately not PSV- or SPS-, which share PS-''s opening sound over a shop phone; not OP-, which collides with "OP 10 / OP 20" on the traveler this slip rides with; not OPS-, which reads as operations.';

COMMENT ON COLUMN public.outside_shipments.ship_to_address IS
  'AddressSnapshot frozen from vendor_addresses at send time. The FIRST consumer of that table, which 20260824022226 created noting "nothing consumes it YET". NULL when the vendor has no address on file: the slip prints "(No address on file)" and the send dialog warns, but neither blocks.';

CREATE INDEX idx_outside_shipments_operation
    ON public.outside_shipments (job_operation_id) WHERE voided_at IS NULL;
-- FULL, not partial: the slip counter does count(*) over ALL rows including
-- voided, so a voided VPS-0141-2 is never reissued to a vendor holding the paper.
CREATE INDEX idx_outside_shipments_job
    ON public.outside_shipments (job_id);
CREATE INDEX idx_outside_shipments_open
    ON public.outside_shipments (company_id, shipped_at DESC) WHERE voided_at IS NULL;
CREATE INDEX idx_outside_shipments_vendor
    ON public.outside_shipments (company_id, vendor_id) WHERE voided_at IS NULL;

CREATE TRIGGER outside_shipments_updated_at
    BEFORE UPDATE ON public.outside_shipments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 2. outside_shipment_receipts -- parts coming back, append-only
-- ============================================================================

CREATE TABLE public.outside_shipment_receipts (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    outside_shipment_id uuid NOT NULL,

    -- Denormalized so compute_job_operation_status sums one column with no join
    -- and -- the load-bearing reason -- so this table can carry the SAME trigger
    -- function as job_operation_completions, which reads only job_operation_id.
    job_operation_id    uuid NOT NULL,
    job_part_id         uuid NOT NULL,

    -- SEPARATE, and both are needed. quantity_good drives status against
    -- job_parts.quantity exactly as an in-house completion does.
    -- quantity_scrapped is what closes the 100-out/98-back case: it retires the
    -- vendor's outstanding balance without counting toward the good total, so
    -- the missing 2 stop reading forever as "still at the plater".
    quantity_good       numeric NOT NULL DEFAULT 0,
    quantity_scrapped   numeric NOT NULL DEFAULT 0,

    received_at         timestamptz NOT NULL DEFAULT now(),
    received_by         uuid REFERENCES auth.users(id),
    note                text,

    voided_at           timestamptz,
    voided_by           uuid REFERENCES auth.users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    -- >= 0, not > 0, on each: a vendor that ruined the whole lot returns
    -- (good 0, scrapped 50). job_op_completions_quantity_positive makes that
    -- unrepresentable, which is one of the reasons receipts are not that table.
    CONSTRAINT outside_receipts_quantities_non_negative
        CHECK (quantity_good >= 0 AND quantity_scrapped >= 0),
    -- ...but an empty receipt is still meaningless.
    CONSTRAINT outside_receipts_something_came_back
        CHECK (quantity_good + quantity_scrapped > 0),
    CONSTRAINT outside_receipts_note_not_blank
        CHECK (note IS NULL OR length(btrim(note)) > 0),
    CONSTRAINT outside_receipts_voided_pair
        CHECK ((voided_at IS NULL) = (voided_by IS NULL)),

    -- ONE FK FOR ALL FOUR IDS. A denormalized column can drift; this makes drift
    -- unrepresentable instead of asserting it in a comment. It also gives
    -- "a receipt cannot exist without a send" for free -- NOT NULL plus a
    -- resolvable parent -- which folding receipts into job_operation_completions
    -- would have needed a BEFORE trigger to express.
    CONSTRAINT outside_receipts_matches_its_shipment
        FOREIGN KEY (outside_shipment_id, company_id, job_operation_id, job_part_id)
        REFERENCES public.outside_shipments (id, company_id, job_operation_id, job_part_id)
        ON DELETE CASCADE
);

COMMENT ON TABLE public.outside_shipment_receipts IS
  'Parts coming back from a vendor against ONE outside_shipments row. Many per shipment: a plater returns what is done. Append-only -- corrections are void (voided_at) plus a new row, never an edit, exactly as job_operation_completions works. quantity_good drives job_operations.status against job_parts.quantity; quantity_scrapped is what the vendor lost, and it counts toward "nothing more is coming back" without counting toward "the step is done".';

COMMENT ON COLUMN public.outside_shipment_receipts.quantity_scrapped IS
  'Pieces the vendor consumed or ruined. Counts against the shipment''s outstanding balance (so the op stops reading ''sent'') but NOT toward the operation''s good total (so 98 of 100 reads in_progress, the same answer an in-house op gives at 98 good). The shop then re-runs and re-sends the 2, or drops job_parts.quantity to 98 and the part-quantity trigger derives completed. There is deliberately NO "close this shipment out" flag: it would be a second mechanism for a fact these two numbers already carry, and the two would eventually disagree.';

CREATE INDEX idx_outside_receipts_shipment
    ON public.outside_shipment_receipts (outside_shipment_id);
CREATE INDEX idx_outside_receipts_operation
    ON public.outside_shipment_receipts (job_operation_id) WHERE voided_at IS NULL;
CREATE INDEX idx_outside_receipts_company_recent
    ON public.outside_shipment_receipts (company_id, received_at DESC) WHERE voided_at IS NULL;

CREATE TRIGGER outside_shipment_receipts_updated_at
    BEFORE UPDATE ON public.outside_shipment_receipts
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 3. GRANTS, RLS, POLICIES, AI READ ACCESS, BILLING GATE
-- ============================================================================
-- Nothing in public reaches the Data API automatically -- 20260716025048 revoked
-- the permissive defaults -- so these grants are load-bearing, not decorative.
-- anon gets nothing: outside shipping is tenant data behind a login.
--
-- REVOKE FIRST, and specifically from jigged_ai_readonly. The baseline's
-- ALTER DEFAULT PRIVILEGES hands that role a TABLE-level SELECT on every new
-- public table, and a table-level grant SUPERSEDES the column lists below -- so
-- without this the column scoping is silently a no-op. apply_ai_read_access
-- gets this ordering right internally; a hand-written block has to do it by hand.

REVOKE ALL    ON public.outside_shipments          FROM anon, authenticated;
REVOKE ALL    ON public.outside_shipment_receipts  FROM anon, authenticated;
REVOKE SELECT ON public.outside_shipments          FROM jigged_ai_readonly;
REVOKE SELECT ON public.outside_shipment_receipts  FROM jigged_ai_readonly;

-- ---- outside_shipments: SELECT only for the browser -----------------------
-- NO INSERT, and that is the chokepoint decision #2 needs. A send must mint
-- VPS-{jobBase}-{n} under an advisory lock and freeze the vendor address block;
-- neither is expressible in a PostgREST insert, so a direct write could only
-- produce a slip with no number or a snapshot that later rewrites itself.
-- NO UPDATE either: voiding must void the receipts FIRST (see section 10 and the
-- trigger-depth note there). Same shape and reasoning as job_operation_intervals,
-- which grants SELECT and routes every write through an RPC.
GRANT SELECT                         ON public.outside_shipments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outside_shipments TO service_role;

-- ---- outside_shipment_receipts: receiving IS simple CRUD ------------------
-- An insert plus a trigger, so it goes straight through the Supabase client per
-- the Supabase-first rule, exactly like createOperationCompletion. The UPDATE
-- grant NAMES its columns rather than excluding a denylist, so a column added to
-- this table next year is non-updatable by default: quantities are corrected by
-- void-and-re-enter, never by edit, and a column-scoped grant is what makes that
-- a privilege rather than a promise.
GRANT SELECT, INSERT                 ON public.outside_shipment_receipts TO authenticated;
GRANT UPDATE (voided_at, voided_by)  ON public.outside_shipment_receipts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outside_shipment_receipts TO service_role;

ALTER TABLE public.outside_shipments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outside_shipment_receipts ENABLE ROW LEVEL SECURITY;

-- The four policies mirror vendor_services. A grant decides whether a role may
-- touch the table at all; RLS decides which rows -- you need both. The
-- INSERT/UPDATE/DELETE policies on outside_shipments will never be evaluated for
-- `authenticated` (there is no grant for them to attach to); that is the same
-- harmless redundancy job_operation_intervals carries, and it keeps the table
-- correct if a grant is ever widened.
CREATE POLICY outside_shipments_select ON public.outside_shipments
    FOR SELECT USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY outside_shipments_insert ON public.outside_shipments
    FOR INSERT WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY outside_shipments_update ON public.outside_shipments
    FOR UPDATE USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY outside_shipments_delete ON public.outside_shipments
    FOR DELETE USING (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY outside_shipment_receipts_select ON public.outside_shipment_receipts
    FOR SELECT USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY outside_shipment_receipts_insert ON public.outside_shipment_receipts
    FOR INSERT WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY outside_shipment_receipts_update ON public.outside_shipment_receipts
    FOR UPDATE USING (company_id IN (SELECT public.get_user_company_ids()));
CREATE POLICY outside_shipment_receipts_delete ON public.outside_shipment_receipts
    FOR DELETE USING (company_id IN (SELECT public.get_user_company_ids()));

-- ---- The insights sandbox: READABLE, column-scoped ------------------------
-- This is the half of the argument that decided receipts get their own table.
-- job_operation_completions is on the PERMANENT exempt list in
-- tenant_tables_missing_ai_decision() (20260826103645) under "Per-operator pace
-- and attention data. Excluded on the surveillance guardrail." Outside
-- processing is exactly what an owner asks the chat about -- what is out at
-- PerformCoat, how long does Thermal One take, which vendor returns short -- so
-- receipts living in that table would put those numbers behind a door that has
-- to stay shut, with no column-list escape.
--
-- The ACTOR columns are withheld (created_by, received_by, voided_by): no
-- business question needs the name of the person who signed for a box, and
-- withholding them keeps the guardrail's spirit while still making the table
-- answerable. Same shape as `shipments`, which is readable under a column list.
--
-- NO `AND deleted_at IS NULL`: neither table is soft-deletable, so
-- ai_policies_missing_soft_delete_filter() (which only inspects tables that HAVE
-- the column) is satisfied vacuously. api/tools/schema_context.py carries the
-- `filter voided_at IS NULL for any count` note instead, as it already does for
-- shipments.
GRANT SELECT (id, company_id, job_id, job_part_id, job_operation_id,
              vendor_id, vendor_name, service_name, slip_number, quantity,
              shipped_at, due_back_on, carrier, voided_at, created_at)
    ON public.outside_shipments TO jigged_ai_readonly;

CREATE POLICY ai_readonly_select ON public.outside_shipments
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

GRANT SELECT (id, company_id, outside_shipment_id, job_operation_id, job_part_id,
              quantity_good, quantity_scrapped, received_at, voided_at, created_at)
    ON public.outside_shipment_receipts TO jigged_ai_readonly;

CREATE POLICY ai_readonly_select ON public.outside_shipment_receipts
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid);

-- ---- The billing write gate ----------------------------------------------
-- Both carry a direct company_id, so both take the helper. On outside_shipments
-- the restrictive policies will never be evaluated for the browser (no write
-- grant) -- but the helper is still what satisfies
-- tenant_tables_missing_write_gate(), and the alternative (an exempt-list entry)
-- is a claim a reviewer then has to re-check by hand.
-- The two RPCs in section 10 call company_can_write BY HAND, because
-- SECURITY DEFINER bypasses RLS and the restrictive gate with it.
SELECT public.apply_billing_write_gate('public.outside_shipments');
SELECT public.apply_billing_write_gate('public.outside_shipment_receipts');


-- ============================================================================
-- 4. VENDOR SNAPSHOT HELPERS
-- ============================================================================
-- Siblings of address_block_snapshot / contact_block_snapshot (20260623021524),
-- which are customer-side only. Same AddressSnapshot / ContactSnapshot output
-- shapes (types/documentSnapshot.ts) so the PDF renders both document families
-- through one address renderer.
--
-- Called ONLY from the SECURITY DEFINER parent below, which runs as its owner --
-- so no EXECUTE grant is needed. Revoking anyway: it is free, correct under
-- either default-privilege state, and #640 is what happens when eight migrations
-- claim "service-role only" without naming the roles.

CREATE OR REPLACE FUNCTION public.vendor_address_block_snapshot(p_address_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
           'address_line1', a.address_line1,
           'address_line2', a.address_line2,
           'city',          a.city,
           'state',         a.state,
           'postal_code',   a.postal_code,
           'country',       a.country,
           'attention_to',  a.attention_to
         )
    FROM public.vendor_addresses a
   WHERE a.id = p_address_id;
$function$;

CREATE OR REPLACE FUNCTION public.vendor_contact_block_snapshot(p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
           'name',  c.name,
           'email', c.email,
           'phone', c.phone
         )
    FROM public.vendor_contacts c
   WHERE c.id = p_contact_id;
$function$;

REVOKE EXECUTE ON FUNCTION public.vendor_address_block_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vendor_contact_block_snapshot(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.vendor_address_block_snapshot(uuid) TO service_role;
GRANT  EXECUTE ON FUNCTION public.vendor_contact_block_snapshot(uuid) TO service_role;


-- ============================================================================
-- 5. compute_job_operation_status -- the outside arm now derives
-- ============================================================================
-- REBUILT FROM ITS NEWEST DEFINITION, 20260823163931:316. Not from 20260723030452
-- and not from 20260721023953: either of those reintroduces the LEFT JOIN on
-- work_centers.kind, a column that no longer exists. It would apply clean and
-- fail at runtime, which is how this repo has been bitten four times.
--
-- The IN-HOUSE arm below is byte-identical to 20260823163931. Only the outside
-- arm changes: it stops early-returning the stored status and derives one.
--
-- WHY THE 20260823163931 HAZARD STAYS CLOSED, and it is closed by CONSTRUCTION
-- now rather than by a guard. That early return existed because
-- recompute_job_ops_status_from_part_qty() runs this over EVERY op on a part
-- when job_parts.quantity is edited, and with v_good = 0 a sent op reset to
-- 'pending' and lost its stamp. It cannot happen here: the outside arm reads
-- outside_shipments and outside_shipment_receipts, and a quantity edit writes
-- neither. An op with 100 out and 0 back re-derives to 'sent' no matter how many
-- times this is called, and sent_at survives because it is now a mirror of the
-- shipment row rather than the record itself.
CREATE OR REPLACE FUNCTION public.compute_job_operation_status(p_job_operation_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_target            numeric;
    v_vendor_service_id uuid;
    v_good              numeric;
    v_sent              numeric;
    v_back              numeric;
BEGIN
    SELECT jp.quantity, o.vendor_service_id
      INTO v_target, v_vendor_service_id
      FROM public.job_operations o
      JOIN public.job_parts jp ON jp.id = o.job_part_id
     WHERE o.id = p_job_operation_id;

    -- ---- IN-HOUSE ---------------------------------------------------------
    IF v_vendor_service_id IS NULL THEN
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
    END IF;

    -- ---- OUTSIDE: the same three thresholds, plus 'sent' for what is away --
    SELECT COALESCE(SUM(s.quantity), 0) INTO v_sent
      FROM public.outside_shipments s
     WHERE s.job_operation_id = p_job_operation_id
       AND s.voided_at IS NULL;

    -- v_good drives status. v_back (good + scrapped) is what has PHYSICALLY come
    -- back, and only v_back can retire the vendor's outstanding balance -- that
    -- distinction is the whole reason quantity_scrapped exists.
    SELECT COALESCE(SUM(r.quantity_good), 0),
           COALESCE(SUM(r.quantity_good + r.quantity_scrapped), 0)
      INTO v_good, v_back
      FROM public.outside_shipment_receipts r
     WHERE r.job_operation_id = p_job_operation_id
       AND r.voided_at IS NULL;

    -- COMPLETED IS TESTED FIRST, and the order is load-bearing. Send 120 for a
    -- 100-piece order, get 100 good back and 20 never returned: the op is done,
    -- and testing outstanding first would hold it at 'sent' over 20 pieces
    -- nobody is waiting for.
    IF v_target IS NOT NULL AND v_good >= v_target THEN
        RETURN 'completed';
    END IF;

    -- SOMETHING IS PHYSICALLY AT THE VENDOR. This is what keeps the op on the
    -- At-vendor side of getOutsideOpsForCompany and keeps the jobs-list chip
    -- honest. 100 out with 50 back is still 'sent', because 50 are on the
    -- plater's rack -- which reading it as 'in_progress' would hide.
    IF v_sent - v_back > 0 THEN
        RETURN 'sent';
    END IF;

    -- Everything that went out has come back, and it was not enough.
    -- 100 out, 98 good + 2 scrapped: outstanding is 0 so nothing is at the
    -- vendor, and 98 < 100 so the step is not done -- exactly what an in-house
    -- op says at 98 good of 100. The shop re-runs and sends a second shipment,
    -- or drops job_parts.quantity to 98 and the part-qty trigger derives
    -- 'completed'. There is deliberately no close-out flag.
    IF v_good > 0 THEN
        RETURN 'in_progress';
    END IF;

    RETURN 'pending';
END $function$;

COMMENT ON FUNCTION public.compute_job_operation_status(uuid) IS
  'Single source of truth for a job_operation''s status. IN-HOUSE: SUM(non-void quantity_good) from job_operation_completions vs job_parts.quantity. OUTSIDE (vendor_service_id set): the same thresholds against outside_shipment_receipts.quantity_good, plus ''sent'' whenever SUM(live outside_shipments.quantity) exceeds SUM(live receipts good+scrapped) -- i.e. whenever pieces are physically at the vendor. An outside op is NO LONGER exempt from the quantity recompute: that exemption existed only to stop a part-quantity edit resetting a sent op, and it is unnecessary now that the send lives in rows a quantity edit cannot touch.';


-- ============================================================================
-- 6. recompute_job_operation_status_from_completion -- one cascade, three tables
-- ============================================================================
-- REBUILT FROM ITS NEWEST DEFINITION, 20260721023953:177 (verified sole
-- definition: no other migration replaces it).
--
-- THREE EDITS, everything else is the original:
--
--   1. completed_by now BRANCHES ON THE OP'S KIND. An outside op has zero
--      job_operation_completions rows, so the original subquery would leave
--      completed_by NULL on every received outside op -- a SILENT loss of the
--      attribution markOperationReceived writes today, visible nowhere until an
--      owner asks who signed for it.
--   2. sent_at / sent_by are refreshed in the SAME UPDATE from the first live
--      shipment. This is what makes job_operations.sent_at a mirror with exactly
--      one writer, and it is why dashboardAccess.fetchOperationActivity, the
--      vendor detail page, OperationCard and api/tools/schema_context.py keep
--      working untouched.
--   3. The write guard widens from "status changed" to "status OR stamps
--      changed". A second shipment on an already-sent op moves no status but
--      does move the stamp, and a status-only guard drops that write on the floor.
--
-- SECURITY DEFINER is added, and it is load-bearing twice over: it lets the
-- guard trigger in section 10 tell a derived write from a hand-written one by
-- current_user alone, with no pg_trigger_depth() subtlety in a WHEN clause; and
-- it fixes a latent bug where an RLS-restricted caller's cascade could match
-- zero rows and no-op silently.
--
-- THE PART ROLLUP STAYS IN THIS FUNCTION (depth 1). Splitting it into its own
-- trigger would push the part->job sync to depth 3, where
-- sync_job_production_status_from_parts() bails at `> 2` -- silently, with the
-- job status frozen and nothing in the logs.
CREATE OR REPLACE FUNCTION public.recompute_job_operation_status_from_completion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_op          uuid;
    v_jp          uuid;
    v_op_new      text;
    v_op_old      text;
    v_is_outside  boolean;
    v_sent_at     timestamptz;
    v_sent_by     uuid;
    v_old_sent_at timestamptz;
    v_old_sent_by uuid;
    v_completer   uuid;
    v_part_new    text;
    v_part_old    text;
BEGIN
    IF pg_trigger_depth() > 4 THEN RETURN NULL; END IF;
    v_op := COALESCE(NEW.job_operation_id, OLD.job_operation_id);

    -- 6a. operation status + stamps
    SELECT status, job_part_id, (vendor_service_id IS NOT NULL), sent_at, sent_by
      INTO v_op_old, v_jp, v_is_outside, v_old_sent_at, v_old_sent_by
      FROM public.job_operations WHERE id = v_op;
    IF v_jp IS NULL THEN RETURN NULL; END IF;   -- op was deleted (CASCADE)

    v_op_new := public.compute_job_operation_status(v_op);

    IF v_is_outside THEN
        -- The FIRST live shipment is the send. Voiding every shipment nulls this
        -- back out, which is exactly right: nothing was ever sent.
        SELECT s.shipped_at, s.created_by INTO v_sent_at, v_sent_by
          FROM public.outside_shipments s
         WHERE s.job_operation_id = v_op AND s.voided_at IS NULL
         ORDER BY s.shipped_at, s.created_at
         LIMIT 1;
        SELECT r.received_by INTO v_completer
          FROM public.outside_shipment_receipts r
         WHERE r.job_operation_id = v_op AND r.voided_at IS NULL
         ORDER BY r.received_at DESC LIMIT 1;
    ELSE
        v_sent_at := v_old_sent_at;   -- an in-house op has no send; leave it alone
        v_sent_by := v_old_sent_by;
        SELECT c.completed_by INTO v_completer
          FROM public.job_operation_completions c
         WHERE c.job_operation_id = v_op AND c.voided_at IS NULL
         ORDER BY c.completed_at DESC LIMIT 1;
    END IF;

    IF v_op_new IS DISTINCT FROM v_op_old
       OR v_sent_at IS DISTINCT FROM v_old_sent_at
       OR v_sent_by IS DISTINCT FROM v_old_sent_by THEN
        UPDATE public.job_operations SET
            status  = v_op_new,
            sent_at = v_sent_at,
            sent_by = v_sent_by,
            -- COALESCE, not a bare now(): with the widened guard this UPDATE now
            -- also fires when only the stamp moved, and a bare now() would
            -- rewrite completed_at on an op that was already complete. Every
            -- not-completed branch nulls it, so on a genuine transition INTO
            -- completed the COALESCE still resolves to now().
            completed_at = CASE WHEN v_op_new = 'completed' THEN COALESCE(completed_at, now()) END,
            completed_by = CASE WHEN v_op_new = 'completed' THEN v_completer END,
            updated_at = now()
        WHERE id = v_op;
    END IF;

    -- 6b. job_part production_status (fires the existing part->job trigger at depth 2)
    v_part_new := public.compute_job_part_production_status(v_jp);
    SELECT production_status INTO v_part_old FROM public.job_parts WHERE id = v_jp;
    IF v_part_new IS DISTINCT FROM v_part_old THEN
        UPDATE public.job_parts SET
            production_status = v_part_new,
            started_at = CASE
                WHEN v_part_new IN ('in_progress', 'completed') AND started_at IS NULL
                THEN now() ELSE started_at END,
            completed_at = CASE
                WHEN v_part_new = 'completed' THEN COALESCE(completed_at, now())
                ELSE NULL END,
            status_changed_at = now(),
            updated_at = now()
        WHERE id = v_jp;
    END IF;

    RETURN NULL;
END $function$;

-- A trigger function needs no EXECUTE grant -- permission is checked when the
-- trigger is CREATED, not when it fires. Revoking is free and keeps the claim
-- true under either default-privilege state.
REVOKE EXECUTE ON FUNCTION public.recompute_job_operation_status_from_completion()
  FROM PUBLIC, anon, authenticated;

-- NB: the triggers on the two new tables are attached in section 8, AFTER the
-- backfill. See the section 7 header for why.


-- ============================================================================
-- 7. THE BACKFILL -- before the triggers are attached, deliberately
-- ============================================================================
-- Every outside op that was ever sent gets the shipment row that should always
-- have existed. MINTING, NOT RESETTING: the send HAPPENED -- somebody put those
-- parts in a box -- and resetting those ops to 'pending' would destroy the fact.
-- CLAUDE.md's "fix the data at rest, never a silent runtime fallback" cuts
-- toward inventing the row, not toward forgetting the event.
--
-- *** ITS FIRST REAL RUN IS PRODUCTION. ***
-- Every pre-merge gate replays migrations on an EMPTY database: `supabase db
-- reset`, the preview branch and the E2E stack all match ZERO rows here, because
-- seed.sql runs after migrations and demo companies are created at RUNTIME by
-- create_demo_company. Verified against prod before writing this: Contour has 37
-- outside ops, all 'pending', none ever sent; the ~24 sent/received rows are all
-- in demo companies. That asymmetry is what made 20260823163931 green in CI and
-- 23502 in production, so this was hand-checked rather than trusted to the gates.
--
-- WHY BEFORE SECTION 8. With the triggers unattached this is a pure data move:
-- no recompute fires mid-flight, no status is disturbed while half the rows
-- exist, and no cascade can wedge on trigger depth while job_parts rows are
-- being touched. Section 9 then reconciles everything at rest in ONE
-- deterministic sweep -- the shape 20260721023953 section 5c established --
-- rather than making correctness depend on ~24 individual cascades.

INSERT INTO public.outside_shipments (
    company_id, job_id, job_part_id, job_operation_id,
    vendor_id, vendor_address_id, vendor_contact_id,
    vendor_name, service_name, ship_to_address, ship_to_contact,
    slip_number, quantity, shipped_at, created_by, created_at)
SELECT jp.company_id, o.job_id, o.job_part_id, o.id,
       v.id,
       (SELECT a.id FROM public.vendor_addresses a
         WHERE a.vendor_id = v.id AND a.is_default LIMIT 1),
       (SELECT c.id FROM public.vendor_contacts c
         WHERE c.vendor_id = v.id AND c.role = 'shipping_receiving'
         ORDER BY c.is_primary DESC, c.created_at LIMIT 1),
       v.name, vs.name,
       public.vendor_address_block_snapshot(
         (SELECT a.id FROM public.vendor_addresses a
           WHERE a.vendor_id = v.id AND a.is_default LIMIT 1)),
       public.vendor_contact_block_snapshot(
         (SELECT c.id FROM public.vendor_contacts c
           WHERE c.vendor_id = v.id AND c.role = 'shipping_receiving'
           ORDER BY c.is_primary DESC, c.created_at LIMIT 1)),
       -- Always -1: a backfilled op can have at most ONE prior send, because the
       -- retired model had exactly one sent_at column to record it in. No
       -- advisory lock needed -- this is a single statement in a migration and
       -- nothing else is minting.
       'VPS-' || regexp_replace(j.job_number, '^[A-Za-z]+-?', '') || '-1',
       -- The WHOLE part quantity. The retired model had no partial send, so
       -- "sent" meant all of it; recording anything else would invent a number.
       jp.quantity,
       -- COALESCE because a demo template can leave a 'completed' outside op
       -- with completed_at set and sent_at null.
       COALESCE(o.sent_at, o.completed_at, o.updated_at, now()),
       COALESCE(o.sent_by, o.completed_by),
       COALESCE(o.sent_at, o.completed_at, o.updated_at, now())
  FROM public.job_operations o
  JOIN public.job_parts jp       ON jp.id = o.job_part_id
  JOIN public.jobs j             ON j.id  = o.job_id
  JOIN public.vendor_services vs ON vs.id = o.vendor_service_id
  JOIN public.vendors v          ON v.id  = vs.vendor_id
 WHERE o.vendor_service_id IS NOT NULL
   AND (o.sent_at IS NOT NULL OR o.status IN ('sent', 'completed'))
   AND jp.quantity > 0
   AND NOT EXISTS (SELECT 1 FROM public.outside_shipments s
                    WHERE s.job_operation_id = o.id);

-- ...and a receipt for every op that was already RECEIVED, or section 9 would
-- derive it back to 'sent' and the shop would be told parts are still at the
-- plater. quantity_scrapped 0: the retired model could not express scrap, and
-- inventing some would be fabricating data.
INSERT INTO public.outside_shipment_receipts (
    company_id, outside_shipment_id, job_operation_id, job_part_id,
    quantity_good, quantity_scrapped, received_at, received_by, created_at)
SELECT s.company_id, s.id, s.job_operation_id, s.job_part_id,
       s.quantity, 0,
       COALESCE(o.completed_at, s.shipped_at), o.completed_by,
       COALESCE(o.completed_at, s.shipped_at)
  FROM public.outside_shipments s
  JOIN public.job_operations o ON o.id = s.job_operation_id
 WHERE o.status = 'completed'
   AND NOT EXISTS (SELECT 1 FROM public.outside_shipment_receipts r
                    WHERE r.outside_shipment_id = s.id);


-- ============================================================================
-- 8. ATTACH THE CASCADE TO THE NEW TABLES
-- ============================================================================
-- The same function the completions tables already use. It reads only
-- NEW/OLD.job_operation_id, so it works verbatim: one cascade implementation,
-- one trigger-depth budget, no second copy of the op -> part -> job rollup.

CREATE TRIGGER trigger_recompute_op_status_on_outside_shipment_ins
    AFTER INSERT ON public.outside_shipments
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_operation_status_from_completion();

-- THE `UPDATE OF` LIST IS THE CONTRACT: it names every column the derivation
-- reads. quantity feeds v_sent, voided_at retires it, shipped_at/created_by are
-- the sent stamp, and job_operation_id would move the whole row's contribution
-- to a different op. A column absent from this list is a column the derivation
-- must not depend on.
CREATE TRIGGER trigger_recompute_op_status_on_outside_shipment_upd
    AFTER UPDATE OF quantity, voided_at, shipped_at, created_by, job_operation_id
    ON public.outside_shipments
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_operation_status_from_completion();

CREATE TRIGGER trigger_recompute_op_status_on_outside_shipment_del
    AFTER DELETE ON public.outside_shipments
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_operation_status_from_completion();

CREATE TRIGGER trigger_recompute_op_status_on_outside_receipt_ins
    AFTER INSERT ON public.outside_shipment_receipts
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_operation_status_from_completion();

-- quantity_scrapped IS IN THIS LIST and it is the easy one to leave out: it
-- never moves the good total, so it looks status-irrelevant -- but it retires
-- the vendor's outstanding balance, which is the difference between 'sent' and
-- 'in_progress'.
CREATE TRIGGER trigger_recompute_op_status_on_outside_receipt_upd
    AFTER UPDATE OF quantity_good, quantity_scrapped, voided_at, received_by, job_operation_id
    ON public.outside_shipment_receipts
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_operation_status_from_completion();

CREATE TRIGGER trigger_recompute_op_status_on_outside_receipt_del
    AFTER DELETE ON public.outside_shipment_receipts
    FOR EACH ROW EXECUTE FUNCTION public.recompute_job_operation_status_from_completion();


-- ============================================================================
-- 9. RECONCILE AT REST, THEN ASSERT
-- ============================================================================
-- Make every stored status match the new derivation now, so the read path has
-- ONE shape with no "what if it disagrees" branch. No runtime fallback.

UPDATE public.job_operations o
   SET status = public.compute_job_operation_status(o.id),
       updated_at = now()
 WHERE o.vendor_service_id IS NOT NULL
   AND o.status IS DISTINCT FROM public.compute_job_operation_status(o.id);

UPDATE public.job_parts jp
   SET production_status = public.compute_job_part_production_status(jp.id),
       status_changed_at = now()
 WHERE jp.production_status <> 'cancelled'
   AND jp.production_status IS DISTINCT FROM public.compute_job_part_production_status(jp.id);

-- ASSERT, do not hope. If an op that carried a send stamp came out of this as
-- 'pending', the backfill lost the send and the shop would be told to ship parts
-- that are already at the vendor. Raising here beats discovering it when the
-- plater calls.
DO $check$
DECLARE v_lost bigint; v_made bigint; v_receipts bigint;
BEGIN
    SELECT count(*) INTO v_lost
      FROM public.job_operations o
     WHERE o.vendor_service_id IS NOT NULL
       AND o.sent_at IS NOT NULL
       AND o.status = 'pending';
    IF v_lost > 0 THEN
        RAISE EXCEPTION
          'outside-shipping backfill lost the send on % operation(s). Refusing to finish.', v_lost
          USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*) INTO v_made     FROM public.outside_shipments;
    SELECT count(*) INTO v_receipts FROM public.outside_shipment_receipts;
    RAISE NOTICE 'outside shipping: backfilled % shipment(s) and % receipt(s) from the retired sent_at model',
                 v_made, v_receipts;
END $check$;


-- ============================================================================
-- 10. THE WRITE SURFACE -- two RPCs and two guard triggers
-- ============================================================================
-- Deliberately minimal. Send is an RPC because minting a per-job sequence under
-- an advisory lock and freezing an address block is not simple CRUD -- the same
-- reason create_shipment_with_line_items is one. Void is an RPC because its two
-- statements must be atomic AND ordered. RECEIVING IS NOT AN RPC: an insert plus
-- a trigger is simple CRUD, and createOperationCompletion's own comment says
-- moving such an insert into an RPC would be a Supabase-first violation.
-- Voiding a receipt is not one either -- it is the column-scoped UPDATE granted
-- in section 3, mirroring voidOperationCompletion.

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

    INSERT INTO public.outside_shipments (
        company_id, job_id, job_part_id, job_operation_id,
        vendor_id, vendor_address_id, vendor_contact_id,
        vendor_name, service_name, ship_to_address, ship_to_contact,
        slip_number, quantity, shipped_at, due_back_on, carrier, notes, created_by
    ) VALUES (
        v_company_id, v_job_id, v_job_part_id, p_job_operation_id,
        v_vendor_id, v_address_id, v_contact_id,
        v_vendor_name, v_service_name,
        public.vendor_address_block_snapshot(v_address_id),
        public.vendor_contact_block_snapshot(v_contact_id),
        v_slip, p_quantity, COALESCE(p_shipped_at, now()), p_due_back_on,
        p_carrier, NULLIF(btrim(COALESCE(p_notes, '')), ''), v_user
    ) RETURNING id INTO v_id;
    -- The AFTER INSERT trigger derives status = 'sent' and mirrors sent_at/by.

    RETURN QUERY SELECT v_id, v_slip;
END $function$;

-- KEEP THE DEFAULT ON EVERY OPTIONAL ARGUMENT. PostgREST resolves an RPC by the
-- SET OF ARGUMENT NAMES SUPPLIED, so a TypeScript caller that omits p_carrier
-- needs the default to exist or the call returns PGRST202. 20260801030048
-- records what happened the last time that was learned the hard way.
--
-- Named roles rather than FROM PUBLIC alone: correct under either
-- default-privilege state, and #640 is what happens when a migration claims a
-- grant posture it never actually established.
REVOKE EXECUTE ON FUNCTION public.create_outside_shipment(uuid, numeric, uuid, uuid, timestamptz, date, text, text)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_outside_shipment(uuid, numeric, uuid, uuid, timestamptz, date, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.create_outside_shipment(uuid, numeric, uuid, uuid, timestamptz, date, text, text) IS
  'THE send. Mints VPS-{jobBase}-{n} under a per-job advisory lock, freezes the vendor address/contact blocks, and inserts one outside_shipments row; the AFTER INSERT trigger derives the operation status. company_id is derived from the operation, never passed, so a caller cannot name a tenant it does not own. Browser-callable by design: this is the only way an outside operation can be sent.';


CREATE OR REPLACE FUNCTION public.void_outside_shipment(p_shipment_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_company_id uuid; v_user uuid := auth.uid(); v_count integer;
BEGIN
    SELECT company_id INTO v_company_id
      FROM public.outside_shipments
     WHERE id = p_shipment_id AND voided_at IS NULL;
    IF v_company_id IS NULL THEN RETURN 0; END IF;   -- idempotent, like voidShipment

    IF NOT (v_company_id IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'You do not have access to this company'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT public.company_can_write(v_company_id) THEN
        RAISE EXCEPTION 'Your subscription is not active (billing_gate_update)'
            USING ERRCODE = '42501';
    END IF;

    -- ---- TWO STATEMENTS, IN THIS ORDER, AND THAT IS THE WHOLE FUNCTION ----
    -- Receipts FIRST. Both are top-level within this body, so each fires its
    -- triggers at pg_trigger_depth() = 1 and the part->job sync lands at 2,
    -- inside sync_job_production_status_from_parts()'s `> 2` bail.
    --
    -- DOING THIS FROM A TRIGGER ON outside_shipments INSTEAD WOULD BREAK IT
    -- SILENTLY: the cascade trigger fires at 1, its UPDATE on receipts fires the
    -- receipt trigger at 2, and that trigger's UPDATE on job_parts fires the job
    -- sync at 3 -- suppressed, job status frozen, nothing in the logs. That is
    -- the exact failure 20260721023953's header warns about. pg_trigger_depth()
    -- counts TRIGGER nesting, not function nesting, which is why the plpgsql
    -- body works and the trigger does not.
    UPDATE public.outside_shipment_receipts
       SET voided_at = now(), voided_by = v_user
     WHERE outside_shipment_id = p_shipment_id AND voided_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE public.outside_shipments
       SET voided_at = now(), voided_by = v_user
     WHERE id = p_shipment_id AND voided_at IS NULL;

    RETURN v_count;
END $function$;

REVOKE EXECUTE ON FUNCTION public.void_outside_shipment(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.void_outside_shipment(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.void_outside_shipment(uuid) IS
  'Voids one outside shipment and every live receipt against it, RECEIPTS FIRST, as two top-level statements so the op -> part -> job cascade stays inside the pg_trigger_depth() > 2 bail. Idempotent: a shipment already voided returns 0. Browser-callable by design -- voiding a slip is the document''s own lifecycle, reached from its preview.';


-- ---- The ordering, enforced -----------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_orphaning_outside_receipts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF EXISTS (SELECT 1 FROM public.outside_shipment_receipts
                WHERE outside_shipment_id = NEW.id AND voided_at IS NULL) THEN
        RAISE EXCEPTION
          'Cannot void outside shipment %: it still has live receipts. Void them first - void_outside_shipment() does, in that order.',
          NEW.slip_number USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $function$;

-- `authenticated` has no UPDATE grant on outside_shipments, so the only caller
-- this can ever fire against is service_role -- i.e. a repair script that got
-- the order wrong. It turns a silently frozen job status into an error.
-- void_outside_shipment passes because its first statement already ran.
CREATE TRIGGER outside_shipments_void_requires_receipts_voided
    BEFORE UPDATE OF voided_at ON public.outside_shipments
    FOR EACH ROW WHEN (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL)
    EXECUTE FUNCTION public.reject_orphaning_outside_receipts();

REVOKE EXECUTE ON FUNCTION public.reject_orphaning_outside_receipts()
  FROM PUBLIC, anon, authenticated;


-- ---- "One writer of the sent state" becomes a database fact ---------------
CREATE OR REPLACE FUNCTION public.reject_hand_written_outside_op_state()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION
      'An outside operation''s status and send stamp are derived from outside_shipments and outside_shipment_receipts. Create or void a shipment (create_outside_shipment / void_outside_shipment), or record a receipt.'
      USING ERRCODE = '42501';
END $function$;

-- current_user, NOT pg_trigger_depth(), is the discriminator -- the idiom
-- reject_gate_key_change() uses. Section 6 made the recompute SECURITY DEFINER
-- precisely so its writes arrive as the owner and fall outside this WHEN,
-- rather than depending on where the depth counter has been incremented.
--
-- This is what makes the three retired app writes -- markOperationSent,
-- markOperationReceived and revertOperationCompletion's outside branch -- fail
-- LOUDLY instead of writing a status the next recompute silently reverts.
CREATE TRIGGER job_operations_outside_state_is_derived
    BEFORE UPDATE OF status, sent_at, sent_by, completed_at, completed_by
    ON public.job_operations
    FOR EACH ROW
    WHEN (NEW.vendor_service_id IS NOT NULL
          AND current_user IN ('authenticated', 'anon')
          AND (NEW.status       IS DISTINCT FROM OLD.status
            OR NEW.sent_at      IS DISTINCT FROM OLD.sent_at
            OR NEW.sent_by      IS DISTINCT FROM OLD.sent_by
            OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
            OR NEW.completed_by IS DISTINCT FROM OLD.completed_by))
    EXECUTE FUNCTION public.reject_hand_written_outside_op_state();

REVOKE EXECUTE ON FUNCTION public.reject_hand_written_outside_op_state()
  FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- 11. REBUILD THE DEMO FUNCTIONS
-- ============================================================================
-- Both rebuilt from their NEWEST definitions, 20260824022226:168 and :774.
-- Rebuilding seed_demo_data from 20260823172300 instead would silently revert
-- the vendor-address work that migration did.
--
-- seed_demo_data's outside-op block wrote job_operations.status and sent_at
-- DIRECTLY. That is exactly what section 10's guard trigger now refuses, and it
-- is the reason the stale-plpgsql audit in section 13 is placed after this.

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
    v_os_id      uuid;      -- outside_shipments.id (20260903203741)
    v_os_base    text;      -- job number minus its alpha prefix
    v_os_seq     integer;   -- per-job outside slip counter
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
                                   notes, consume_whole_units)
            VALUES ((v_ref_map->>(v_item->>'parent_ref'))::uuid,
                    (v_ref_map->>(v_item->>'child_ref'))::uuid,
                    (v_item->>'quantity')::numeric,
                    v_item->>'unit',
                    COALESCE((v_item->>'sequence')::integer, 0),
                    v_item->>'notes',
                    COALESCE((v_item->>'consume_whole_units')::boolean, false));
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
                              due_date, customer_po_number, is_hot,
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
                    COALESCE((v_item->>'is_hot')::boolean, false),
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

                    -- Outside ops are the send/receive lifecycle -- and since
                    -- 20260903203741 that lifecycle IS outside_shipments plus
                    -- outside_shipment_receipts. Writing job_operations.status
                    -- here directly is now refused for browser roles by
                    -- job_operations_outside_state_is_derived, and would be
                    -- re-derived away by the next recompute regardless. So the
                    -- demo creates the same rows the app creates, which is what
                    -- keeps it structurally unable to hold a state combination
                    -- the product cannot produce.
                    IF v_leaf->>'status' IN ('sent', 'completed') THEN
                        SELECT j.job_number INTO v_os_base FROM jobs j WHERE j.id = v_job_id;
                        v_os_base := regexp_replace(v_os_base, '^[A-Za-z]+-?', '');
                        SELECT count(*) + 1 INTO v_os_seq
                          FROM outside_shipments WHERE job_id = v_job_id;

                        -- The JOIN on vendor_services is the outside filter: an
                        -- in-house op inserts nothing rather than inventing a
                        -- vendor. Every status leaf in the template is an
                        -- outside step, and this keeps that true by construction.
                        INSERT INTO outside_shipments (
                            company_id, job_id, job_part_id, job_operation_id,
                            vendor_id, vendor_address_id, vendor_contact_id,
                            vendor_name, service_name, ship_to_address, ship_to_contact,
                            slip_number, quantity, shipped_at, due_back_on, created_by)
                        SELECT p_company_id, v_job_id, v_job_part_id, v_op_id,
                               v.id, a.id, c.id, v.name, vs.name,
                               vendor_address_block_snapshot(a.id),
                               vendor_contact_block_snapshot(c.id),
                               'VPS-' || v_os_base || '-' || v_os_seq::text,
                               jp.quantity,
                               now() - make_interval(days =>
                                       COALESCE((v_leaf->>'days_ago')::integer, 1)),
                               (now() + interval '7 days')::date,
                               p_user_id
                          FROM job_operations o
                          JOIN job_parts jp       ON jp.id = o.job_part_id
                          JOIN vendor_services vs ON vs.id = o.vendor_service_id
                          JOIN vendors v          ON v.id  = vs.vendor_id
                          LEFT JOIN LATERAL (
                              SELECT a2.id FROM vendor_addresses a2
                               WHERE a2.vendor_id = v.id AND a2.is_default LIMIT 1) a ON true
                          LEFT JOIN LATERAL (
                              SELECT c2.id FROM vendor_contacts c2
                               WHERE c2.vendor_id = v.id AND c2.role = 'shipping_receiving'
                               ORDER BY c2.is_primary DESC, c2.created_at LIMIT 1) c ON true
                         WHERE o.id = v_op_id
                        RETURNING id INTO v_os_id;

                        -- 'completed' means it came back: a full receipt, no
                        -- scrap. The triggers derive 'sent' or 'completed' from
                        -- these two rows -- neither status is ever asserted.
                        IF v_leaf->>'status' = 'completed' AND v_os_id IS NOT NULL THEN
                            INSERT INTO outside_shipment_receipts (
                                company_id, outside_shipment_id, job_operation_id,
                                job_part_id, quantity_good, quantity_scrapped,
                                received_at, received_by)
                            SELECT s.company_id, s.id, s.job_operation_id, s.job_part_id,
                                   s.quantity, 0,
                                   now() - make_interval(days =>
                                           COALESCE((v_leaf->>'days_ago')::integer, 0)),
                                   p_user_id
                              FROM outside_shipments s WHERE s.id = v_os_id;
                        END IF;
                        v_os_id := NULL;
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
-- 12. REBUILD THE CI GUARDS
-- ============================================================================
-- Both rebuilt from their NEWEST definitions -- function_execute_leaks from
-- 20260828124806 and definer_writers_missing_write_gate from 20260819012414.
-- Rebuilding an allowlist from the migration that CREATED it silently reverts
-- every entry added since, which has happened four times in this repo.

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
      'start_operation_interval', 'close_operation_interval',
      'cancel_operation_interval', 'void_open_intervals_for_operation',
      'get_operation_actuals', 'get_open_intervals',
      -- Called BY a browser-callable SECURITY INVOKER function, which runs as the
      -- caller — so the caller genuinely needs EXECUTE on this one.
      -- (generate_quote_number / generate_direct_job_number -> next_order_number)
      -- (get_ready_operations_for_station -> get_running_operation_ids_for_station,
      --  added 20260826010648)
      'next_order_number', 'get_running_operation_ids_for_station',
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
      'create_outside_shipment', 'void_outside_shipment'
    )
  ORDER BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION public.definer_writers_missing_write_gate()
RETURNS TABLE(function_name text)
LANGUAGE sql
STABLE
AS $$
  WITH gated AS (
    SELECT DISTINCT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'billing_gate_insert'
  )
  SELECT p.proname::text
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'
    AND p.prosecdef
    AND EXISTS (
      SELECT 1 FROM gated g
      WHERE pg_get_functiondef(p.oid) ~* ('(insert into|update)\s+(public\.)?' || g.tablename)
    )
    AND pg_get_functiondef(p.oid) NOT LIKE '%company_can_write%'
    AND pg_get_functiondef(p.oid) NOT LIKE '%inv_assert_can_write%'
    AND p.proname NOT IN (
      -- triggers: the statement that fired them was gated
      'seed_new_part_balance', 'note_views_bump_counts',
      'void_intervals_with_completion',
      -- Added 20260903203741: recompute_job_operation_status_from_completion
      -- became SECURITY DEFINER so the guard trigger on job_operations can tell
      -- a derived write from a hand-written one by current_user alone. It writes
      -- job_parts (gated), but it only ever runs FROM a trigger, so the
      -- statement that fired it was itself gated.
      'recompute_job_operation_status_from_completion',
      -- internal helpers: no browser EXECUTE, always called post-assertion
      'inv_get_or_create_unassigned', 'recompute_part_quantity_from_locations',
      -- demo bootstrap: company_can_write() is true for is_demo by design
      'seed_demo_data',
      -- known gap, filed separately: browser-callable, genuinely ungated
      'create_shipment_with_line_items'
    )
  ORDER BY 1;
$$;


-- ============================================================================
-- 13. THE STALE-PLPGSQL AUDIT -- ask the database, do not reason about it
-- ============================================================================
-- CREATE OR REPLACE FUNCTION does NOT validate a plpgsql body, so a function
-- still writing the retired state applies clean and fails at runtime. That is
-- exactly how start_operation_interval survived the work_centers.kind drop and
-- had to be caught by an E2E test instead (20260824003328). A grep over the
-- migration files cannot answer this either -- only pg_proc knows what is
-- actually installed.
--
-- Placed AFTER section 11 so it proves the demo rewrite landed: before that
-- rewrite, seed_demo_data trips checks (1) and (3).

DO $audit$
DECLARE v_bad text;
BEGIN
    -- (1) Anything still writing the retired send stamp by hand. Only the
    --     recompute trigger may touch it now, and only as a mirror.
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc ~* '(sent_at|sent_by)\s*='
       AND p.proname <> 'recompute_job_operation_status_from_completion';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
          'These function bodies still write the send stamp by hand: %. outside_shipments is the only writer now.', v_bad;
    END IF;

    -- (2) Anything still carrying the outside-op early return this migration
    --     reverses. Leaving one behind means quantities silently stop driving
    --     status on whatever path calls it. NB: 255 is Postgres's hard cap on a
    --     regex repetition count -- {0,300} raises 2201B "invalid repetition
    --     count(s)" when the migration RUNS, not when it is written.
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc ~* 'vendor_service_id IS NOT NULL[\s\S]{0,255}RETURN\s+v_status';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
          'These function bodies still exempt outside ops from the quantity recompute: %', v_bad;
    END IF;

    -- (3) Anything still asserting an outside op's status directly.
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc ~* 'job_operations[\s\S]{0,200}status\s*=\s*''sent''';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
          'These function bodies still set job_operations.status = ''sent'' directly: %', v_bad;
    END IF;
END $audit$;


-- ============================================================================
-- 14. RE-DOCUMENT THE COLUMNS THAT CHANGED MEANING
-- ============================================================================
-- These three columns still exist and still hold the same values. What changed
-- is who writes them, and a reader who does not know that will reach for an
-- UPDATE and get a 42501 they cannot explain.

COMMENT ON COLUMN public.job_operations.sent_at IS
  'DERIVED, not written. For an outside op this mirrors the shipped_at of the FIRST live outside_shipments row, maintained by recompute_job_operation_status_from_completion. Voiding every shipment nulls it back out, which is correct -- nothing was ever sent. A hand-written UPDATE is refused by job_operations_outside_state_is_derived. Always NULL for an in-house op.';

COMMENT ON COLUMN public.job_operations.sent_by IS
  'DERIVED, not written -- the created_by of the same first live outside_shipments row that sets sent_at. See that column.';

COMMENT ON COLUMN public.job_operations.status IS
  'pending | in_progress | completed | sent. ALWAYS derived by compute_job_operation_status, never asserted: in-house from job_operation_completions.quantity_good, outside from outside_shipments and outside_shipment_receipts. ''sent'' means pieces are physically at a vendor (sent minus good-plus-scrapped received is above zero) and is reachable only for an outside op. Since 20260903203741 an outside op is NO LONGER exempt from the quantity recompute.';
