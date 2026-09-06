-- ============================================================================
-- LOT-TRACKED MATERIAL: heats become a thing you hold, not a note you wrote
-- ============================================================================
-- 20260904063844 put the heat number on the MOVEMENT: text on the receipt row
-- and on the take-to-a-job row, deliberately at ledger grain, with stock left as
-- "a quantity of an item at a place". That shipped the packing-slip line, and it
-- has two faults the founder found by driving it:
--
--   1. A removal could name a heat that never came in, because the field was
--      free text. That is how "4471" becomes "4417" on a document a customer
--      keeps.
--   2. It cannot answer "how much of heat 4471 is on Shelf A", so the picker
--      offered every heat ever received -- most of them long consumed -- and a
--      move or a count had nothing sensible to say about heats at all.
--
-- Both are the same missing fact: a BALANCE per heat. So this migration builds
-- the lot layer that inventory.md 5.6 cut in July, now that a customer needs it.
-- Confirmed against how the three job-shop ERPs in this market work (JobBOSS,
-- ProShop, Fulcrum): all three key inventory by item + lot + location, all three
-- make lot control a per-item flag, and all three attach the mill cert to the
-- lot rather than to a transaction.
--
-- FOUR DECISIONS, each of which could reasonably have gone the other way:
--
--   A. A LOT IS (part, lot_code), NOT (receipt). JobBOSS keys lots to receipts
--      and its most-requested open issue -- 136 votes, unresolved since 2017 --
--      is shops complaining that one shipment under one cert carries several
--      mill heats, so the lot they are given is not the thing they need to
--      trace. The heat is the atom. Two deliveries of heat 4471 are one lot.
--
--   B. `lot_code` IS NOT NULL, `heat_number` IS. Material arrives untagged, and
--      an operator who cannot name it must still be able to put it away. When no
--      heat is given we MINT a code, which is what Fulcrum does. So every lot has
--      a handle, and `heat_number IS NULL` says honestly "we do not know the mill
--      heat", rather than a blank that reads as "nobody typed it yet".
--
--   C. UNTRACKED STOCK KEEPS A NULL lot_id, AND UNIQUENESS IS ON A GENERATED
--      COLUMN. `UNIQUE (part_id, location_id, lot_id)` would be a lie: NULLs
--      compare distinct, so a part with no lot could accumulate unlimited
--      duplicate balance rows at one place and the rollup would double. The
--      stored `lot_key` collapses NULL to a sentinel uuid so the constraint is
--      FULL -- which it must be anyway, because PostgREST cannot target a partial
--      index and every one of these RPCs upserts through ON CONFLICT.
--
--   D. TURNING TRACKING ON MINTS A LOT FOR WHAT IS ALREADY THERE. The whole
--      point of the flag is that a removal from a tracked part can then REQUIRE a
--      lot. That is only true if nothing tracked is sitting in a NULL-lot row --
--      otherwise the first operator to touch pre-existing stock is blocked by a
--      rule about material that predates the rule. So `set_part_lot_tracking()`
--      migrates the balances in the same statement that sets the flag, into a lot
--      whose code says exactly what it is. CLAUDE.md's "no silent runtime
--      fallbacks" is the rule being honoured: the invariant holds at rest rather
--      than being patched by an `IF lot IS NULL` branch on every read.
--
-- WHAT THIS MIGRATION DOES NOT DO: enforce lots on transfer or adjust for
-- untracked parts, touch the count sheet's grain, or change any surface for a
-- shop that never sets the flag. A company that ignores lot tracking sees the
-- same inventory it saw yesterday, because every existing row keeps lot_id NULL
-- and `lot_tracked` defaults false.
-- ============================================================================


-- ============================================================================
-- 1. material_lots -- the heat, as a row
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.material_lots (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

    -- RESTRICT, not CASCADE. A lot is the evidence trail for material that has
    -- shipped; deleting the part must not silently take the proof with it.
    -- Parts archive rather than delete (architecture.md 16), so this is a guard
    -- against a hard delete nobody intended, not an obstacle to ordinary work.
    part_id      uuid NOT NULL REFERENCES public.parts(id) ON DELETE RESTRICT,

    -- What we address it by: the mill heat when there is one, else minted.
    lot_code     text NOT NULL,
    -- The mill's own heat number. NULL is meaningful and is NOT the same as a
    -- blank lot_code: it says the material arrived without a heat we could read.
    heat_number  text,

    -- Where it came from. Navigation only, and nullable, because J6 receiving
    -- does not exist yet (#571) -- today a lot is born at an ad-hoc stock-in with
    -- no PO behind it. A later receipt flow fills these in without a migration.
    vendor_id    uuid REFERENCES public.vendors(id) ON DELETE SET NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    notes        text,

    deleted_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT material_lots_lot_code_shape
        CHECK (lot_code = btrim(lot_code) AND lot_code <> '' AND length(lot_code) <= 64),
    CONSTRAINT material_lots_heat_number_shape
        CHECK (heat_number IS NULL
               OR (heat_number = btrim(heat_number) AND heat_number <> '' AND length(heat_number) <= 64))
);

COMMENT ON TABLE public.material_lots IS
  'One lot of one material -- in a machine shop, one mill heat. Identity is (part_id, lot_code): two deliveries of heat 4471 of the same bar are ONE lot, because the heat is the physical fact and the delivery is not. Deliberately NOT keyed to a receipt: JobBOSS keys lots to receipts and its longest-standing open request is shops explaining that one shipment under one cert carries several heats. Balances live on part_location_stock.lot_id; certs on lot_certificates.';

COMMENT ON COLUMN public.material_lots.lot_code IS
  'The handle: the mill heat number when the material carries one, otherwise minted by mint_lot_code(). Never blank -- material that arrives untagged must still be storable, and a lot with no handle cannot be picked from a list.';

COMMENT ON COLUMN public.material_lots.heat_number IS
  'The mill''s heat number, or NULL when the material arrived without one. NULL is a fact, not a gap: it distinguishes "no heat on this bar" from "nobody has typed it yet", and a lot in that state is the one thing a cert cannot be matched to.';

-- Name is identity, and the constraint is FULL rather than partial: the archived
-- namesake keeps the code. Reviving vs renaming is decided in app code the way
-- customers and parts each decide it, and a partial index could not be targeted
-- by an upsert anyway (CLAUDE.md, "Name is identity").
CREATE UNIQUE INDEX IF NOT EXISTS material_lots_part_code_key
    ON public.material_lots (part_id, lower(btrim(lot_code)));

CREATE INDEX IF NOT EXISTS material_lots_company_idx ON public.material_lots (company_id);
CREATE INDEX IF NOT EXISTS material_lots_part_idx    ON public.material_lots (part_id);

CREATE TRIGGER material_lots_updated_at
    BEFORE UPDATE ON public.material_lots
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_lots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_lots TO service_role;
GRANT SELECT                          ON public.material_lots TO jigged_ai_readonly;

ALTER TABLE public.material_lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company members manage their material lots" ON public.material_lots
    USING (company_id IN (SELECT public.get_user_company_ids()))
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

-- Archived lots are invisible to the insights sandbox whatever SQL a model
-- writes -- the structural half of the soft-delete rule (CLAUDE.md).
CREATE POLICY ai_readonly_select ON public.material_lots
    FOR SELECT TO jigged_ai_readonly
    USING (company_id = (current_setting('jigged.company_id', true))::uuid
           AND deleted_at IS NULL);

SELECT public.apply_billing_write_gate('public.material_lots');


-- ============================================================================
-- 2. lot_certificates -- the mill cert, on the lot, never on a movement
-- ============================================================================
-- Issue #642 argued this shape before any of it was built, and the market
-- confirms it: Fulcrum attaches certs to the item lot at receiving; ProShop
-- scans them at purchase and links them to every job that uses them.
--
-- SEPARATE TABLE, not a path column on material_lots, for the reason the same
-- issue gave for keeping certs off inventory_transactions.photo_path: a movement
-- photo is one image tied to one event, while a cert is a DOCUMENT -- there may
-- be several per lot (mill cert plus a plating cert plus a re-test), they are
-- replaced when a supplier reissues, and they outlive the material by years.
CREATE TABLE IF NOT EXISTS public.lot_certificates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    lot_id       uuid NOT NULL REFERENCES public.material_lots(id) ON DELETE CASCADE,

    -- Path in the `attachments` bucket, which already accepts any mime type and
    -- has no size cap (20260728212230) -- it was built for drawings and STEP
    -- files, so a PDF or a phone photo of a paper cert both land unchanged.
    file_path    text NOT NULL,
    file_name    text NOT NULL,
    mime_type    text,
    size_bytes   bigint,

    uploaded_at  timestamptz NOT NULL DEFAULT now(),
    uploaded_by  uuid REFERENCES public.user_company_access(id) ON DELETE SET NULL,

    CONSTRAINT lot_certificates_file_path_present CHECK (btrim(file_path) <> ''),
    CONSTRAINT lot_certificates_file_name_present CHECK (btrim(file_name) <> '')
);

COMMENT ON TABLE public.lot_certificates IS
  'Mill test reports (MTRs) and any other certificate belonging to a lot. Attached to the LOT, never to a movement: a cert is a document that outlives the material, can be reissued, and can arrive days after the truck. Nothing here blocks receiving -- a lot with no rows is the normal state on the day material lands, and chasing it is an office task, not a dock task.';

CREATE INDEX IF NOT EXISTS lot_certificates_lot_idx ON public.lot_certificates (lot_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lot_certificates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lot_certificates TO service_role;

ALTER TABLE public.lot_certificates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company members manage their lot certificates" ON public.lot_certificates
    USING (company_id IN (SELECT public.get_user_company_ids()))
    WITH CHECK (company_id IN (SELECT public.get_user_company_ids()));

-- Deliberately NOT readable by the insights sandbox, matching every other upload
-- table (job_attachments, part_attachments, note_media): each wants its own look
-- at what a document contains before its text can reach a prompt.
SELECT public.apply_billing_write_gate('public.lot_certificates');


-- ============================================================================
-- 3. parts.lot_tracked -- the per-item flag every one of the three ERPs has
-- ============================================================================
ALTER TABLE public.parts
    ADD COLUMN IF NOT EXISTS lot_tracked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.parts.lot_tracked IS
  'When true, every movement of this part names a lot, and a removal REFUSES to proceed without one. Off by default and per part, because a shop holds ~9,000 parts and a handful of bar and plate stock is what needs tracing -- the same call JobBOSS makes ("once a part has been flagged as requiring lot control"). Never set directly: set_part_lot_tracking() flips it AND migrates existing balances into a lot, because the enforcement is only honest if nothing tracked is left sitting in a lot-less row.';


-- ============================================================================
-- 4. part_location_stock.lot_id -- the balance gains its third dimension
-- ============================================================================
ALTER TABLE public.part_location_stock
    ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.material_lots(id) ON DELETE RESTRICT;

-- Decision C. A stored generated column, so the unique constraint is FULL and an
-- upsert can infer it. Collapsing NULL to a fixed sentinel is what stops a
-- lot-less part accumulating duplicate rows at one place -- which would not error,
-- it would just make parts.quantity (a trigger rollup, SUM over these rows) count
-- the same material twice, silently, exactly the class of fault 20260802144310
-- was written to end.
ALTER TABLE public.part_location_stock
    ADD COLUMN IF NOT EXISTS lot_key uuid
    GENERATED ALWAYS AS (COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED;

COMMENT ON COLUMN public.part_location_stock.lot_id IS
  'Which lot this balance is. NULL means the part is not lot-tracked -- the state every row is in until someone turns tracking on for its part. RESTRICT on delete: a lot with stock against it cannot be removed out from under the balance.';

COMMENT ON COLUMN public.part_location_stock.lot_key IS
  'lot_id with NULL collapsed to the zero uuid, so UNIQUE (part_id, location_id, lot_key) is a FULL constraint. Generated, never written. Without it the NULL-lot rows would compare distinct from each other and one part could hold several balances at one place, double-counting into the parts.quantity rollup with no error anywhere.';

-- Swap the key: (part, location) -> (part, location, lot_key). The old one has to go
-- first, or a part could not legitimately hold two heats in one bin -- which is the
-- entire point of this migration.
--
-- ⚠️ ITS NAME IS `part_location_stock_part_location_unique`, and getting that wrong
-- is silent. A first cut guessed the Postgres default (`..._part_id_location_id_key`);
-- `DROP ... IF EXISTS` against a name that does not exist SUCCEEDS AND DOES NOTHING,
-- so the migration applied green, the new three-column index was created beside the
-- old two-column one, and the old one would have refused the second heat in a bin
-- forever -- with every RPC below looking correct. Same trap as a mismatched
-- DROP FUNCTION signature (20260801030048), and the assertion at the end of this file
-- is what turns it back into a failure.
ALTER TABLE public.part_location_stock
    DROP CONSTRAINT IF EXISTS part_location_stock_part_location_unique;
DROP INDEX IF EXISTS public.part_location_stock_part_location_unique;

CREATE UNIQUE INDEX IF NOT EXISTS part_location_stock_part_location_lot_key
    ON public.part_location_stock (part_id, location_id, lot_key);

CREATE INDEX IF NOT EXISTS part_location_stock_lot_idx
    ON public.part_location_stock (lot_id) WHERE lot_id IS NOT NULL;


-- ============================================================================
-- 5. inventory_transactions.lot_id -- the ledger points at the lot it moved
-- ============================================================================
-- `heat_number` STAYS, and is not redundant. It is the denormalised snapshot,
-- exactly as `item_name` and `location_name` are: the durable record of what was
-- recorded at the time, readable after the lot is renamed or archived. `lot_id`
-- is the live FK for navigation. That pairing is the Document Snapshot Standard
-- (architecture.md 15) and the reason `location_id` is ON DELETE SET NULL here too.
ALTER TABLE public.inventory_transactions
    ADD COLUMN IF NOT EXISTS lot_id uuid REFERENCES public.material_lots(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.inventory_transactions.lot_id IS
  'The lot this movement moved, for navigation. The durable record of WHICH heat is heat_number beside it, snapshotted at write time -- so a renamed or archived lot never rewrites history, and a deleted one leaves the ledger still readable (ON DELETE SET NULL, same as location_id).';

CREATE INDEX IF NOT EXISTS inventory_transactions_lot_idx
    ON public.inventory_transactions (lot_id) WHERE lot_id IS NOT NULL;


-- ============================================================================
-- 6. mint_lot_code -- a handle for material that arrives without a heat
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mint_lot_code(p_part_id uuid, p_prefix text DEFAULT 'LOT')
RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_code text;
    v_n    int := 0;
BEGIN
    -- Date-stamped and sequential within the part, so a person reading a label can
    -- tell two minted lots apart and roughly when each landed. Not a UUID: this is
    -- written on a tag and read back off a bar by hand.
    LOOP
        v_n := v_n + 1;
        v_code := p_prefix || '-' || to_char(now(), 'YYMMDD') || '-' || lpad(v_n::text, 2, '0');
        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM public.material_lots
             WHERE part_id = p_part_id AND lower(btrim(lot_code)) = lower(v_code)
        );
        IF v_n > 99 THEN
            RAISE EXCEPTION 'could not mint a lot code for part % today', p_part_id;
        END IF;
    END LOOP;
    RETURN v_code;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mint_lot_code(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.mint_lot_code(uuid, text) TO service_role;

COMMENT ON FUNCTION public.mint_lot_code(uuid, text) IS
  'A human-readable handle for a lot with no mill heat -- LOT-260906-01, unique within the part. Backend-only: it is called from inside the SECURITY DEFINER stock RPCs, never by the browser.';


-- ============================================================================
-- 7. set_part_lot_tracking -- decision D, as one atomic act
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_part_lot_tracking(p_part_id uuid, p_tracked boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company  uuid;
    v_lot      uuid;
    v_migrated int := 0;
BEGIN
    SELECT company_id INTO v_company FROM public.parts WHERE id = p_part_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'part % not found', p_part_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.inv_assert_can_write(v_company);

    UPDATE public.parts SET lot_tracked = p_tracked WHERE id = p_part_id;

    -- Turning it ON: everything already on a shelf needs a lot, or the first
    -- operator to remove any of it hits a rule about material that predates the
    -- rule. The code says what it is rather than inventing a heat -- this material
    -- genuinely has no known one, and a made-up number on a packing slip is worse
    -- than an honest "not known".
    IF p_tracked THEN
        SELECT id INTO v_lot
          FROM public.material_lots
         WHERE part_id = p_part_id AND lower(btrim(lot_code)) = 'pre-tracking';

        IF v_lot IS NULL AND EXISTS (
            SELECT 1 FROM public.part_location_stock
             WHERE part_id = p_part_id AND lot_id IS NULL
        ) THEN
            INSERT INTO public.material_lots (company_id, part_id, lot_code, heat_number, notes, created_by)
            VALUES (v_company, p_part_id, 'PRE-TRACKING', NULL,
                    'Stock already on hand when heat tracking was switched on for this part. Its mill heat is not known.',
                    auth.uid())
            RETURNING id INTO v_lot;
        END IF;

        IF v_lot IS NOT NULL THEN
            UPDATE public.part_location_stock
               SET lot_id = v_lot
             WHERE part_id = p_part_id AND lot_id IS NULL;
            GET DIAGNOSTICS v_migrated = ROW_COUNT;
        END IF;
    END IF;

    -- Turning it OFF deliberately leaves the balances alone. Collapsing several
    -- lots back into one row would have to pick a survivor and silently merge
    -- quantities under it, destroying the split that was the record of what is
    -- physically on the shelf. The flag stops future ENFORCEMENT; it is not an
    -- instruction to forget what has been traced.
    RETURN jsonb_build_object('lot_tracked', p_tracked, 'balances_migrated', v_migrated);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.set_part_lot_tracking(uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_part_lot_tracking(uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_part_lot_tracking(uuid, boolean) IS
  'Turn heat/lot tracking on or off for one part. Switching ON also moves every lot-less balance of that part into a PRE-TRACKING lot, in the same transaction, so the "a removal must name a lot" rule is true the instant the flag is -- rather than being papered over by a runtime branch (CLAUDE.md, no silent runtime fallbacks). Switching OFF leaves balances split, because merging them would pick a survivor and destroy a physical fact.';


-- ============================================================================
-- 8. resolve_lot -- one place that turns "4471" into a lot row
-- ============================================================================
-- Called from inside the DEFINER stock RPCs, so a receipt and the lot it creates
-- are one transaction: a failed put-away leaves no orphan lot, and two operators
-- receiving the same heat at once cannot make two rows for it (the unique index
-- decides, and the loser re-reads).
CREATE OR REPLACE FUNCTION public.resolve_lot(
    p_company_id  uuid,
    p_part_id     uuid,
    p_lot_id      uuid,
    p_heat_number text,
    p_create      boolean,
    p_mint        boolean
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_heat text := NULLIF(upper(btrim(p_heat_number)), '');
    v_lot  uuid;
BEGIN
    -- An explicit lot always wins, and is verified to belong to this part: a lot id
    -- from another part would silently file this movement under someone else's heat.
    IF p_lot_id IS NOT NULL THEN
        SELECT id INTO v_lot FROM public.material_lots
         WHERE id = p_lot_id AND part_id = p_part_id;
        IF v_lot IS NULL THEN
            RAISE EXCEPTION 'lot % does not belong to part %', p_lot_id, p_part_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        RETURN v_lot;
    END IF;

    IF v_heat IS NOT NULL THEN
        SELECT id INTO v_lot FROM public.material_lots
         WHERE part_id = p_part_id AND lower(btrim(lot_code)) = lower(v_heat);
        -- ON THE WAY OUT, AN UNKNOWN HEAT STAYS UNKNOWN. This is the whole of the
        -- founder's "you should not be able to consume a heat that isn't already
        -- there". Creating it here is what a free-text box did: a mistyped 4417
        -- became a real lot, was gracefully depleted from a zero balance, and
        -- printed on a packing slip as though it had been received.
        IF v_lot IS NULL AND NOT p_create THEN
            RETURN NULL;
        END IF;
        IF v_lot IS NULL THEN
            INSERT INTO public.material_lots (company_id, part_id, lot_code, heat_number, created_by)
            VALUES (p_company_id, p_part_id, v_heat, v_heat, auth.uid())
            ON CONFLICT DO NOTHING
            RETURNING id INTO v_lot;
            -- ON CONFLICT returns nothing when a concurrent receipt won the race.
            IF v_lot IS NULL THEN
                SELECT id INTO v_lot FROM public.material_lots
                 WHERE part_id = p_part_id AND lower(btrim(lot_code)) = lower(v_heat);
            END IF;
        END IF;
        -- An archived lot receiving stock again is un-archived rather than duplicated:
        -- the heat is a physical fact and a second row for it would split the balance.
        UPDATE public.material_lots SET deleted_at = NULL
         WHERE id = v_lot AND deleted_at IS NOT NULL;
        RETURN v_lot;
    END IF;

    -- No heat given. A tracked part still needs a handle on the way IN, so mint one;
    -- everything else gets NULL and behaves exactly as it did before this migration.
    IF p_mint THEN
        INSERT INTO public.material_lots (company_id, part_id, lot_code, heat_number, notes, created_by)
        VALUES (p_company_id, p_part_id, public.mint_lot_code(p_part_id), NULL,
                'Received without a mill heat number.', auth.uid())
        RETURNING id INTO v_lot;
        RETURN v_lot;
    END IF;

    RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.resolve_lot(uuid, uuid, uuid, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_lot(uuid, uuid, uuid, text, boolean, boolean) TO service_role;

COMMENT ON FUNCTION public.resolve_lot(uuid, uuid, uuid, text, boolean, boolean) IS
  'Turn a lot id, or a typed heat number, or nothing, into the lot a movement belongs to -- creating it on first sight of a heat when p_create (inbound only), and minting a code when p_mint and the material arrived untagged. Outbound callers pass false to both, so a heat nobody received resolves to NULL and the take is refused rather than inventing the lot it claims to consume. Backend-only: called from inside the SECURITY DEFINER stock RPCs so the lot and the stock that justifies it are written in one transaction.';


-- ============================================================================
-- 9. add_stock_at_location -- a receipt, now carrying its lot
-- ============================================================================
DROP FUNCTION IF EXISTS public.add_stock_at_location(
    uuid, uuid, numeric, text, numeric, text, uuid, text, text);

CREATE FUNCTION public.add_stock_at_location(
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
         p_location_id, p_notes, p_operator_id, p_photo_path, v_heat, v_lot, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', v_new_balance, 'part_quantity', v_rollup,
                              'lot_id', v_lot);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text, uuid)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text, uuid)
    TO authenticated, service_role;

COMMENT ON FUNCTION public.add_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, text, text, uuid) IS
  'Stock a part into a location. Resolves the lot first -- an explicit p_lot_id, else the typed heat, else a minted code when the part is tracked, else none -- so the balance is keyed by (part, location, lot). The ledger row carries lot_id for navigation and the heat_number snapshot for history.';


-- ============================================================================
-- 10. deplete_stock_at_location -- a take, which must name its lot
-- ============================================================================
DROP FUNCTION IF EXISTS public.deplete_stock_at_location(
    uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text);

CREATE FUNCTION public.deplete_stock_at_location(
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
         v_heat, v_lot, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object(
        'location_balance', v_new, 'part_quantity', v_rollup,
        'has_discrepancy', v_discrepancy, 'shortfall', v_shortfall, 'lot_id', v_lot);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text, uuid)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text, uuid)
    TO authenticated, service_role;

COMMENT ON FUNCTION public.deplete_stock_at_location(uuid, uuid, numeric, text, numeric, boolean, text, uuid, uuid, uuid, text, uuid) IS
  'Take stock out of a location, from ONE lot. Refuses a lot-less take off a lot-tracked part -- the only non-arithmetic refusal in this module, and it can strand nobody because set_part_lot_tracking() gives every existing balance a lot the moment the flag goes on. Never mints: a take names material already here, and minting on the way out is how free text became a heat nobody received.';


-- ============================================================================
-- 11. transfer_stock -- a move carries the bar's tag with it
-- ============================================================================
-- The three statements below are the ones that would have failed SILENTLY if this
-- function had been left lot-blind: `SELECT quantity INTO` from a now-multi-row
-- query takes an ARBITRARY lot with no error, and the DELETE and UPDATE would have
-- hit EVERY lot at the source. A shelf holding two heats would have had one of them
-- deleted and the other's quantity overwritten, with two correct-looking ledger rows.
DROP FUNCTION IF EXISTS public.transfer_stock(
    uuid, uuid, uuid, numeric, text, numeric, text, uuid, text);

CREATE FUNCTION public.transfer_stock(
    p_part_id uuid,
    p_from_location_id uuid,
    p_to_location_id uuid,
    p_quantity numeric,
    p_unit text,
    p_converted_quantity numeric,
    p_notes text DEFAULT NULL::text,
    p_operator_id uuid DEFAULT NULL::uuid,
    p_photo_path text DEFAULT NULL::text,
    p_lot_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company uuid; v_item_name text; v_tracked boolean;
    v_lot uuid; v_heat text; v_sentinel constant uuid := '00000000-0000-0000-0000-000000000000';
    v_src numeric; v_from_balance numeric; v_to_balance numeric;
    v_group uuid; v_from_name text; v_to_name text;
    v_from_notes text; v_to_notes text; v_base text;
BEGIN
    IF p_quantity <= 0 OR p_converted_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be positive' USING ERRCODE = 'check_violation';
    END IF;
    IF p_from_location_id = p_to_location_id THEN
        RAISE EXCEPTION 'Source and destination locations must differ' USING ERRCODE = 'check_violation';
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
    PERFORM public.inv_assert_location_in_company(p_from_location_id, v_company);
    PERFORM public.inv_assert_location_in_company(p_to_location_id, v_company);

    v_lot := public.resolve_lot(v_company, p_part_id, p_lot_id, NULL, false, false);

    -- A tracked part moves ONE lot at a time, and the caller has to say which. The
    -- alternative -- move "the part" and split it across whatever lots happen to be
    -- there -- is a guess about which physical bars were carried, and the tag on the
    -- bar is the fact. Untracked parts keep their single NULL-lot row and move whole.
    IF v_tracked AND v_lot IS NULL THEN
        RAISE EXCEPTION 'This part is heat-tracked, so a move has to say which heat is being moved'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT heat_number INTO v_heat FROM public.material_lots WHERE id = v_lot;

    SELECT quantity INTO v_src
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_from_location_id
       AND lot_key = COALESCE(v_lot, v_sentinel)
       FOR UPDATE;
    IF v_src IS NULL OR v_src < p_converted_quantity THEN
        RAISE EXCEPTION 'Insufficient stock at source location (have %, need %)',
            COALESCE(v_src, 0), p_converted_quantity USING ERRCODE = 'check_violation';
    END IF;

    v_from_balance := v_src - p_converted_quantity;
    IF v_from_balance = 0 THEN
        DELETE FROM public.part_location_stock
         WHERE part_id = p_part_id AND location_id = p_from_location_id
           AND lot_key = COALESCE(v_lot, v_sentinel);
    ELSE
        UPDATE public.part_location_stock
           SET quantity = v_from_balance
         WHERE part_id = p_part_id AND location_id = p_from_location_id
           AND lot_key = COALESCE(v_lot, v_sentinel);
    END IF;

    INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, lot_id, quantity)
    VALUES (v_company, p_part_id, p_to_location_id, v_lot, p_converted_quantity)
    ON CONFLICT (part_id, location_id, lot_key)
        DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity
    RETURNING pls.quantity INTO v_to_balance;

    v_group := gen_random_uuid();
    SELECT name INTO v_from_name FROM public.inventory_locations WHERE id = p_from_location_id;
    SELECT name INTO v_to_name   FROM public.inventory_locations WHERE id = p_to_location_id;
    v_base := COALESCE(NULLIF(p_notes, ''), '');

    v_from_notes := btrim(v_base || ' ' || format('[Transfer to %s]', v_to_name));
    v_to_notes   := btrim(v_base || ' ' || format('[Transfer from %s]', v_from_name));

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, transfer_group_id, notes, operator_id, photo_path,
         heat_number, lot_id, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'depletion', p_quantity, p_unit, p_converted_quantity,
         p_from_location_id, v_group, v_from_notes, p_operator_id, p_photo_path,
         v_heat, v_lot, auth.uid()),
        (v_company, p_part_id, v_item_name, 'addition', p_quantity, p_unit, p_converted_quantity,
         p_to_location_id, v_group, v_to_notes, p_operator_id, p_photo_path,
         v_heat, v_lot, auth.uid());

    RETURN jsonb_build_object(
        'transfer_group_id', v_group,
        'from_balance', v_from_balance, 'to_balance', v_to_balance, 'lot_id', v_lot);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.transfer_stock(uuid, uuid, uuid, numeric, text, numeric, text, uuid, text, uuid)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_stock(uuid, uuid, uuid, numeric, text, numeric, text, uuid, text, uuid)
    TO authenticated, service_role;

COMMENT ON FUNCTION public.transfer_stock(uuid, uuid, uuid, numeric, text, numeric, text, uuid, text, uuid) IS
  'Move stock between two locations, ONE lot at a time, as a depletion/addition pair sharing a transfer_group_id. A tracked part must name the lot: splitting a move across whatever lots happen to be at the source would be a guess about which bars were physically carried.';


-- ============================================================================
-- 12. adjust_stock_at_location -- a count sets ONE lot's number
-- ============================================================================
-- The subtlest of the four. An adjustment is an ABSOLUTE ("there are 12 here"), and
-- with two heats in a bin there is no such thing as "12 here" -- there is 8 of one
-- and 4 of the other. Lot-blind, this function would have deleted every heat in the
-- bin when someone counted it empty, writing ONE adjustment row for it.
DROP FUNCTION IF EXISTS public.adjust_stock_at_location(
    uuid, uuid, numeric, text, numeric, text, uuid);

CREATE FUNCTION public.adjust_stock_at_location(
    p_part_id uuid,
    p_location_id uuid,
    p_new_quantity numeric,
    p_unit text,
    p_converted_new_quantity numeric,
    p_notes text DEFAULT NULL::text,
    p_operator_id uuid DEFAULT NULL::uuid,
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
    v_current numeric; v_diff numeric; v_rollup numeric; v_notes text;
BEGIN
    IF p_converted_new_quantity < 0 THEN
        RAISE EXCEPTION 'Quantity cannot be negative' USING ERRCODE = 'check_violation';
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

    v_lot := public.resolve_lot(v_company, p_part_id, p_lot_id, NULL, false, false);
    IF v_tracked AND v_lot IS NULL THEN
        RAISE EXCEPTION 'This part is heat-tracked, so a count has to say which heat it counted'
            USING ERRCODE = 'check_violation';
    END IF;
    SELECT heat_number INTO v_heat FROM public.material_lots WHERE id = v_lot;

    SELECT quantity INTO v_current
      FROM public.part_location_stock
     WHERE part_id = p_part_id AND location_id = p_location_id
       AND lot_key = COALESCE(v_lot, v_sentinel)
       FOR UPDATE;
    v_current := COALESCE(v_current, 0);
    v_diff := p_converted_new_quantity - v_current;

    -- Counting THIS lot empty removes THIS lot's row, and leaves every other heat in
    -- the bin exactly where it was.
    IF p_converted_new_quantity = 0 THEN
        DELETE FROM public.part_location_stock
         WHERE part_id = p_part_id AND location_id = p_location_id
           AND lot_key = COALESCE(v_lot, v_sentinel);
    ELSE
        INSERT INTO public.part_location_stock (company_id, part_id, location_id, lot_id, quantity)
        VALUES (v_company, p_part_id, p_location_id, v_lot, p_converted_new_quantity)
        ON CONFLICT (part_id, location_id, lot_key) DO UPDATE SET quantity = EXCLUDED.quantity;
    END IF;

    v_notes := COALESCE(
        p_notes,
        format('Adjusted from %s to %s %s', v_current, p_converted_new_quantity, v_primary_unit));

    INSERT INTO public.inventory_transactions
        (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
         location_id, notes, operator_id, heat_number, lot_id, created_by)
    VALUES
        (v_company, p_part_id, v_item_name, 'adjustment', abs(v_diff), v_primary_unit, abs(v_diff),
         p_location_id, v_notes, p_operator_id, v_heat, v_lot, auth.uid());

    SELECT quantity INTO v_rollup FROM public.parts WHERE id = p_part_id;
    RETURN jsonb_build_object('location_balance', p_converted_new_quantity, 'part_quantity', v_rollup,
                              'lot_id', v_lot);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.adjust_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, uuid)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, uuid)
    TO authenticated, service_role;

COMMENT ON FUNCTION public.adjust_stock_at_location(uuid, uuid, numeric, text, numeric, text, uuid, uuid) IS
  'Set the true quantity of ONE lot at one location. An adjustment is absolute, and "12 here" has no meaning when a bin holds two heats -- so a tracked part must say which heat was counted, and counting one empty leaves the others untouched.';


-- ============================================================================
-- 13. bulk_put_away -- the pile empties lot by lot
-- ============================================================================
-- Its cursor already returned one row per balance; with lots that is one row per
-- (part, lot). Lot-blind, the DELETE inside the loop would have removed every lot of
-- the part on the FIRST iteration, so the second would move nothing and the
-- quantities of every heat but one would vanish into a single addition row.
DROP FUNCTION IF EXISTS public.bulk_put_away(uuid, uuid, uuid[]);

CREATE FUNCTION public.bulk_put_away(p_from_location_id uuid, p_to_location_id uuid, p_part_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    PUT_AWAY_MAX constant int := 1000;
    v_company uuid;
    v_requested int;
    v_group uuid;
    v_from_name text;
    v_to_name text;
    v_moved int := 0;
    v_sentinel constant uuid := '00000000-0000-0000-0000-000000000000';
    r record;
BEGIN
    IF p_from_location_id IS NULL OR p_to_location_id IS NULL THEN
        RAISE EXCEPTION 'Both a source and a destination location are required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF p_from_location_id = p_to_location_id THEN
        RAISE EXCEPTION 'Source and destination locations must differ'
            USING ERRCODE = 'check_violation';
    END IF;

    v_requested := COALESCE(array_length(p_part_ids, 1), 0);
    IF v_requested = 0 THEN
        RAISE EXCEPTION 'Pick at least one part to put away' USING ERRCODE = 'check_violation';
    END IF;
    IF v_requested > PUT_AWAY_MAX THEN
        RAISE EXCEPTION 'Too many parts at once (% of a maximum %). Narrow your search and put them away in smaller batches.',
            v_requested, PUT_AWAY_MAX USING ERRCODE = 'check_violation';
    END IF;

    SELECT company_id INTO v_company
      FROM public.inventory_locations WHERE id = p_from_location_id;
    IF v_company IS NULL THEN
        RAISE EXCEPTION 'location % not found', p_from_location_id USING ERRCODE = 'no_data_found';
    END IF;
    IF NOT (v_company IN (SELECT public.get_user_company_ids())) THEN
        RAISE EXCEPTION 'access denied to company %', v_company USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.inv_assert_can_write(v_company);
    PERFORM public.inv_assert_location_in_company(p_from_location_id, v_company);
    PERFORM public.inv_assert_location_in_company(p_to_location_id, v_company);

    v_group := gen_random_uuid();
    SELECT name INTO v_from_name FROM public.inventory_locations WHERE id = p_from_location_id;
    SELECT name INTO v_to_name   FROM public.inventory_locations WHERE id = p_to_location_id;

    -- `ORDER BY part_id, lot_key` -- the lock order now has to include the lot, or two
    -- concurrent put-aways of the same part could take its lots in opposite orders and
    -- deadlock where before they merely queued.
    FOR r IN
        SELECT pls.part_id, pls.lot_id, pls.lot_key, pls.quantity,
               p.part_name, p.primary_unit, ml.heat_number
          FROM public.part_location_stock pls
          JOIN public.parts p ON p.id = pls.part_id
          LEFT JOIN public.material_lots ml ON ml.id = pls.lot_id
         WHERE pls.location_id = p_from_location_id
           AND pls.company_id = v_company
           AND pls.part_id = ANY(p_part_ids)
           AND pls.quantity > 0
           AND p.deleted_at IS NULL
         ORDER BY pls.part_id, pls.lot_key
           FOR UPDATE OF pls
    LOOP
        DELETE FROM public.part_location_stock
         WHERE part_id = r.part_id AND location_id = p_from_location_id
           AND lot_key = COALESCE(r.lot_id, v_sentinel);

        INSERT INTO public.part_location_stock AS pls (company_id, part_id, location_id, lot_id, quantity)
        VALUES (v_company, r.part_id, p_to_location_id, r.lot_id, r.quantity)
        ON CONFLICT (part_id, location_id, lot_key)
            DO UPDATE SET quantity = pls.quantity + EXCLUDED.quantity;

        INSERT INTO public.inventory_transactions
            (company_id, part_id, item_name, type, quantity, unit, converted_quantity,
             location_id, transfer_group_id, notes, heat_number, lot_id, created_by)
        VALUES
            (v_company, r.part_id, r.part_name, 'depletion', r.quantity, r.primary_unit, r.quantity,
             p_from_location_id, v_group, format('Put away to %s', v_to_name),
             r.heat_number, r.lot_id, auth.uid()),
            (v_company, r.part_id, r.part_name, 'addition', r.quantity, r.primary_unit, r.quantity,
             p_to_location_id, v_group, format('Put away from %s', v_from_name),
             r.heat_number, r.lot_id, auth.uid());

        v_moved := v_moved + 1;
    END LOOP;

    -- `moved` now counts BALANCE ROWS, not parts: a part sitting in the pile under two
    -- heats moves as two rows. `skipped` is left as requested-minus-moved and can
    -- therefore read negative in that case; the wrapper reports "moved" and the caller
    -- re-reads, so this stays a report rather than a promise.
    RETURN jsonb_build_object(
        'moved', v_moved,
        'skipped', GREATEST(v_requested - v_moved, 0),
        'transfer_group_id', v_group);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.bulk_put_away(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_put_away(uuid, uuid, uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.bulk_put_away(uuid, uuid, uuid[]) IS
  'Move every balance a set of parts holds at one location to another, in one transaction. Now one iteration per (part, lot): a part in the pile under two heats moves as two rows and keeps them apart at the destination. `moved` counts rows, not parts.';


-- ============================================================================
-- 14. Guards -- one overload each, browser-reachable, anon shut out
-- ============================================================================
-- Five functions were dropped and recreated here. `DROP FUNCTION IF EXISTS` against
-- a signature that does not match the live one SUCCEEDS AND DOES NOTHING, leaving a
-- second callable overload for PostgREST to choose between; and DROP destroys the
-- ACL, which for these was PUBLIC's built-in default and nothing else.
DO $$
DECLARE
    v_name text;
    v_count integer;
    v_oid oid;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'add_stock_at_location', 'deplete_stock_at_location', 'transfer_stock',
        'adjust_stock_at_location', 'bulk_put_away', 'set_part_lot_tracking'
    ] LOOP
        SELECT count(*), min(p.oid) INTO v_count, v_oid
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;
        IF v_count <> 1 THEN
            RAISE EXCEPTION '% has % overloads (expected 1) -- a DROP signature did not match the live function',
                v_name, v_count;
        END IF;
        IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% is no longer executable by authenticated -- the browser would get 42501', v_name;
        END IF;
        IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION '% is executable by anon', v_name;
        END IF;
    END LOOP;
END $$;

-- THE KEY ACTUALLY SWAPPED. Any surviving two-column unique index on
-- (part_id, location_id) makes every RPC above a lie: they would all run, and the
-- second heat into a bin would raise a duplicate-key error from a constraint no
-- comment in this file mentions.
DO $$
DECLARE v_old integer;
BEGIN
    SELECT count(*) INTO v_old
      FROM pg_index i
      JOIN pg_class c  ON c.oid = i.indexrelid
      JOIN pg_class t  ON t.oid = i.indrelid
     WHERE t.relname = 'part_location_stock'
       AND i.indisunique
       AND i.indnatts = 2
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(i.indkey::int[]) k
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k)
           = ARRAY['location_id', 'part_id'];
    IF v_old > 0 THEN
        RAISE EXCEPTION
            'a (part_id, location_id) unique index survived: two heats could never share a bin, and every RPC in this migration would be unreachable for the case it was written for';
    END IF;
END $$;

-- Every balance row still satisfies the invariant at rest: no part is tracked yet, so
-- every lot_id is NULL and every (part, location) is still unique. Asserted rather
-- than assumed, because the generated column silently changes what "unique" means.
DO $$
DECLARE v_dupes integer;
BEGIN
    SELECT count(*) INTO v_dupes FROM (
        SELECT part_id, location_id FROM public.part_location_stock
         GROUP BY part_id, location_id HAVING count(*) > 1
    ) d;
    IF v_dupes > 0 THEN
        RAISE EXCEPTION 'the lot key let % (part, location) pairs duplicate before any part is tracked', v_dupes;
    END IF;
END $$;
