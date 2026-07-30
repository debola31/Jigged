-- Machine Maintenance, Phase 1: the schema for a machine-scoped logbook.
--
-- See docs/modules/machine-maintenance.md. The bet is that machine-scoped
-- knowledge is a container operators will fill where part-scoped knowledge was
-- not, and §2 of that doc states in advance what result would park the module.
--
-- Almost nothing here is new machinery. `notes` has carried a 'work_center'
-- subject end to end since 20260728040701 — the CHECK branch, the FK, the
-- cross-tenant trigger, the read index, RLS and the billing gate all exist and
-- nothing in the app has ever written one. This migration adds the two columns
-- that make a maintenance entry different from any other note, the machine
-- attributes a shop might want to record, and a place for manuals.
--
-- WHAT IS DELIBERATELY ABSENT: any stored notion of "open". §4.4 of the doc
-- requires open state to be DERIVED from the existence of a resolving entry, so
-- that the open list can never disagree with the timeline it is drawn from.
-- That is also the only design that fits this table: `notes` is append-only
-- (REVOKE UPDATE ... FROM authenticated, migration 20260728040701), so a stored
-- resolved flag would have needed an UPDATE grant and broken the invariant.


-- ══════════════════════════════════════════════════════════════════════════════
-- 1. MAINTENANCE COLUMNS ON notes
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.notes
  ADD COLUMN maintenance_kind text,
  ADD COLUMN resolves_note_id uuid;

-- OPTIONAL, and that is the whole point (§4.3). A forced taxonomy at capture
-- time is what stops capture: someone who cannot decide whether they cleaned or
-- adjusted something writes nothing rather than choosing wrongly. Constrained to
-- work-center notes so it can never appear on a part or job note, where it would
-- mean nothing.
ALTER TABLE public.notes ADD CONSTRAINT notes_maintenance_kind_valid CHECK (
  maintenance_kind IS NULL
  OR (subject_kind = 'work_center'
      AND maintenance_kind IN ('cleaned', 'repaired', 'replaced', 'adjusted', 'noticed'))
);

-- NOT corrects_note_id, which already exists and means something else: that this
-- note supersedes an inaccurate one. "I did the fix for the thing you noticed"
-- is a different claim, and overloading one column would make a future
-- corrections UI silently close open items.
--
-- SET NULL rather than CASCADE: deleting the observation must not delete the
-- record that somebody fixed it. The fix outlives the complaint.
ALTER TABLE public.notes ADD CONSTRAINT notes_resolves_fk
  FOREIGN KEY (resolves_note_id) REFERENCES public.notes(id) ON DELETE SET NULL;

ALTER TABLE public.notes ADD CONSTRAINT notes_no_self_resolution
  CHECK (resolves_note_id IS NULL OR resolves_note_id <> id);
ALTER TABLE public.notes ADD CONSTRAINT notes_resolves_is_machine
  CHECK (resolves_note_id IS NULL OR subject_kind = 'work_center');

COMMENT ON COLUMN public.notes.maintenance_kind IS
  'cleaned | repaired | replaced | adjusted | noticed, on work-center notes only. OPTIONAL by design: an unclassified entry is still knowledge. Only ''noticed'' can be open.';
COMMENT ON COLUMN public.notes.resolves_note_id IS
  'This entry is the fix for that ''noticed'' entry on the same machine. Open state is DERIVED from the absence of such a row and is never stored — see docs/modules/machine-maintenance.md §4.4.';

-- Supports the FK's own delete-time lookup, and any future "what closed this"
-- query. The timeline read does not need it: resolvers come back in the same
-- result set as the observations they close.
CREATE INDEX idx_notes_resolves ON public.notes (resolves_note_id)
  WHERE resolves_note_id IS NOT NULL;


-- ══════════════════════════════════════════════════════════════════════════════
-- 2. CROSS-ROW VALIDATION FOR THE RESOLUTION LINK
-- ══════════════════════════════════════════════════════════════════════════════
-- A resolver must point at a 'noticed' entry ON THE SAME MACHINE. That spans
-- rows, so no CHECK can express it, and enforcing it only in the access layer
-- would be exactly the silent runtime fallback the project forbids: the
-- derived-open read TRUSTS this invariant (it assumes every resolver arrives in
-- the same work-center result set as its target), so the database has to hold it.
--
-- Extends the existing subject validator rather than adding a second trigger:
-- it is the same class of check, and one BEFORE trigger is easier to reason
-- about than two.

CREATE OR REPLACE FUNCTION public.notes_validate_subject()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_part uuid;
  v_ok   boolean;
BEGIN
  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = NEW.job_id AND j.company_id = NEW.company_id)
  THEN
    RAISE EXCEPTION 'job % is not in company %', NEW.job_id, NEW.company_id;
  END IF;

  IF NEW.part_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.parts p
      WHERE p.id = NEW.part_id AND p.company_id = NEW.company_id)
  THEN
    RAISE EXCEPTION 'part % is not in company %', NEW.part_id, NEW.company_id;
  END IF;

  IF NEW.work_center_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.work_centers w
      WHERE w.id = NEW.work_center_id AND w.company_id = NEW.company_id)
  THEN
    RAISE EXCEPTION 'work center % is not in company %',
                    NEW.work_center_id, NEW.company_id;
  END IF;

  -- routing_operations has NO company_id; tenancy resolves through routings. The same
  -- query yields the part, so tenancy and part-consistency are checked together.
  IF NEW.routing_operation_id IS NOT NULL THEN
    SELECT r.part_id INTO v_part
    FROM public.routing_operations ro
    JOIN public.routings r ON r.id = ro.routing_id
    WHERE ro.id = NEW.routing_operation_id AND r.company_id = NEW.company_id;

    IF v_part IS NULL THEN
      RAISE EXCEPTION 'routing operation % is not in company %',
                      NEW.routing_operation_id, NEW.company_id;
    END IF;
    IF v_part IS DISTINCT FROM NEW.part_id THEN
      RAISE EXCEPTION 'routing operation % belongs to part %, not %',
                      NEW.routing_operation_id, v_part, NEW.part_id;
    END IF;
  END IF;

  -- Company, machine and kind in ONE predicate, answered with ONE message. This
  -- function is SECURITY DEFINER, so it reads past RLS: a message that
  -- distinguished "no such note" from "different company" from "not a noticed
  -- item" would be a cross-tenant existence oracle for anyone willing to guess
  -- uuids. The uniform failure is the point, not laziness.
  IF NEW.resolves_note_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.notes t
      WHERE t.id = NEW.resolves_note_id
        AND t.company_id = NEW.company_id
        AND t.subject_kind = 'work_center'
        AND t.work_center_id = NEW.work_center_id
        AND t.maintenance_kind = 'noticed'
    ) INTO v_ok;

    IF NOT v_ok THEN
      RAISE EXCEPTION 'that item is not an open observation on this machine';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- The column list decides when the trigger fires on UPDATE. `notes` has no
-- UPDATE grant for authenticated, so in practice only the INSERT path runs;
-- naming the new columns keeps that true if the grant ever changes.
DROP TRIGGER IF EXISTS notes_validate_subject_trg ON public.notes;
CREATE TRIGGER notes_validate_subject_trg
  BEFORE INSERT OR UPDATE OF company_id, job_id, part_id, routing_operation_id,
                             work_center_id, resolves_note_id, maintenance_kind
  ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.notes_validate_subject();


-- ══════════════════════════════════════════════════════════════════════════════
-- 3. FUNNEL: TWO NEW OPERATOR EVENT KINDS
-- ══════════════════════════════════════════════════════════════════════════════
-- §8 needs four moments instrumented: machine page opened, composer focused,
-- entry saved, noticed resolved. The middle two already exist and are reused with
-- workCenterId in context (which the operator_events comment already anticipates
-- as a context key). These two are new.
--
-- machine_page_opened is load-bearing for §2, not decoration. A container nobody
-- filled and a container nobody reached both look like silence from outside; this
-- is the only thing that tells them apart, and without it a null result cannot
-- honestly be recorded as a kill.

ALTER TABLE public.operator_events DROP CONSTRAINT operator_events_kind_check;
ALTER TABLE public.operator_events ADD CONSTRAINT operator_events_kind_check CHECK (kind IN (
  'app_opened',
  'station_selected',
  'op_card_opened',
  'prior_notes_opened',      -- THAT they opened prior notes, never WHICH ones
  'composer_focused',
  'composer_abandoned',
  'note_saved',
  'note_saved_with_photo',
  'photo_attached',
  'completion_recorded',
  'machine_page_opened',     -- separates "not yet tested" from a kill (§2)
  'noticed_resolved'
));


-- ══════════════════════════════════════════════════════════════════════════════
-- 4. MACHINE DETAILS ON work_centers
-- ══════════════════════════════════════════════════════════════════════════════
-- Real columns rather than the existing metadata jsonb: types/database.ts is
-- CI-diff-enforced, so real columns are type-checked through getTypedSupabase()
-- at every call site, while jsonb degrades to `Json` and checks nothing.
--
-- ALL NULLABLE, AND NOTHING EVER PROMPTS FOR THEM (§4.5). Asset data entry is a
-- leading cause of CMMS abandonment: the tool arrives, the shop is asked to
-- describe its equipment before it can do anything, and the project dies in the
-- describing. The machines are already in Jigged as work centers, so this module
-- starts with its asset list complete and its asset detail empty, which is the
-- right way round. External/vendor work centers simply leave them null, exactly
-- as they already do with labor_rate.

ALTER TABLE public.work_centers
  ADD COLUMN make          text,
  ADD COLUMN model         text,
  ADD COLUMN serial_number text,
  ADD COLUMN year_built    integer,
  ADD COLUMN purchased_on  date;

ALTER TABLE public.work_centers ADD CONSTRAINT work_centers_year_built_sane
  CHECK (year_built IS NULL OR year_built BETWEEN 1900 AND 2200);

COMMENT ON COLUMN public.work_centers.make IS
  'Optional machine detail. Never required, never prompted for, and no surface may render a machine as less ready than another because these are filled in — see docs/modules/machine-maintenance.md §4.5.';


-- ══════════════════════════════════════════════════════════════════════════════
-- 5. MANUALS: work_center_attachments
-- ══════════════════════════════════════════════════════════════════════════════
-- A twin of part_attachments rather than a polymorphic widening of it:
-- part_attachments.part_id is NOT NULL with an FK, so making it polymorphic would
-- touch every existing call site to buy nothing. job_attachments and
-- part_attachments already coexist as near-twins; this is the third sibling.

CREATE TABLE public.work_center_attachments (
    id             uuid NOT NULL DEFAULT gen_random_uuid(),
    company_id     uuid NOT NULL,
    work_center_id uuid NOT NULL,
    storage_path   text NOT NULL,
    file_name      text NOT NULL,
    kind           text NOT NULL DEFAULT 'other',
    mime_type      text,
    size_bytes     bigint,
    uploaded_by    uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT work_center_attachments_pkey PRIMARY KEY (id),
    CONSTRAINT work_center_attachments_kind_check
      CHECK (kind IN ('pdf', 'image', 'other')),
    CONSTRAINT work_center_attachments_company_fk FOREIGN KEY (company_id)
      REFERENCES public.companies(id) ON DELETE CASCADE,
    -- Work centers are soft-deleted, so RESTRICT never actually fires. It is here
    -- to state the rule: archiving a machine hides it from pickers, not its
    -- manuals. Knowledge must not be destroyable as a side effect of tidying a
    -- list (§9).
    CONSTRAINT work_center_attachments_wc_fk FOREIGN KEY (work_center_id)
      REFERENCES public.work_centers(id) ON DELETE RESTRICT,
    CONSTRAINT work_center_attachments_uploader_fk FOREIGN KEY (uploaded_by)
      REFERENCES public.user_company_access(id) ON DELETE SET NULL
);

CREATE INDEX idx_work_center_attachments_wc
  ON public.work_center_attachments (work_center_id, created_at DESC);

COMMENT ON TABLE public.work_center_attachments IS
  'Machine manuals and reference images, read on the floor from the Maintenance tab. Optional: a machine with none shows nothing at all, never a prompt to add one.';

ALTER TABLE public.work_center_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY work_center_attachments_select ON public.work_center_attachments
    FOR SELECT TO authenticated
    USING (company_id IN (SELECT public.get_user_company_ids()));

CREATE POLICY work_center_attachments_insert ON public.work_center_attachments
    FOR INSERT TO authenticated
    WITH CHECK (
      company_id IN (SELECT public.get_user_company_ids())
      -- Same rule as notes.author_id: the uploader is the acting member, resolved
      -- server-side. There is no path to attribute an upload to anyone else.
      AND uploaded_by = public.get_operator_access_id(company_id)
    );

CREATE POLICY work_center_attachments_delete ON public.work_center_attachments
    FOR DELETE TO authenticated
    USING (uploaded_by = public.get_operator_access_id(company_id)
           OR public.is_company_admin(company_id));

-- Data API grants. No UPDATE: a manual is replaced by uploading a new one and
-- deleting the old, which keeps storage_path and the row in step. No anon: the
-- operator app is always signed in.
GRANT SELECT, INSERT, DELETE ON public.work_center_attachments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_center_attachments TO service_role;

SELECT public.apply_billing_write_gate('public.work_center_attachments');
