-- ============================================================================
-- Stock always names a location. The `Unassigned` bucket is gone.
-- ============================================================================
-- Founder's call, 2026-09-06, on seeing 3,626 of a screw reported as "not
-- stored yet" beside 4 on a shelf:
--
--   "we should never show 'not stored yet', just show it as being in the
--    unassigned location. And technically unassigned should not exist at all
--    since once this feature is added, we should reset all counts to 0 and so
--    anything that is added as a quantity should have to be added to a
--    location."
--
-- WHAT `Unassigned` WAS. A per-company location with `kind = 'system'`, minted
-- on demand by `inv_get_or_create_unassigned()`. Every part created carrying an
-- opening quantity was dropped into it by `trg_seed_new_part_balance`, and the
-- put-away flow existed to empty it. It was the answer to "this part has stock
-- but nobody has said where", which was a real state only because a quantity
-- could be recorded without one.
--
-- WHY IT GOES. It was a second kind of place that every reader had to know
-- about and exclude: not a destination in the pickers, not a shelf in the
-- operator lookup, a special first row in the part drawer, the fallback target
-- of the count sheet, a `kind` nobody could type. Nine surfaces carried a
-- branch for it. Removing the state removes all nine branches -- the founder's
-- point exactly: if a quantity cannot exist without a location, there is
-- nothing for the bucket to hold.
--
-- THE RESET IS DELIBERATE AND DESTRUCTIVE. Every balance row is deleted, which
-- takes `parts.quantity` to 0 through the existing rollup trigger. At the time
-- of writing that is 2,409 units across 57 parts for the pilot shop, which is
-- effectively their whole recorded inventory -- they had put 9 units on shelves
-- and left the rest in the bucket. The founder was shown those figures and
-- confirmed twice. The shop re-counts from a clean slate, which is also the
-- honest state: a number nobody could point at a shelf for was never a fact
-- about the shop.
--
-- The LEDGER is not touched. `inventory_transactions` is append-only and
-- explicitly non-authoritative (inventory.md 5.8) -- it is history, not the
-- balance, and history of a real movement stays true after a recount. Its
-- `location_id` FK is ON DELETE SET NULL and every row already carries a
-- `location_name` snapshot, so rows that pointed at a deleted bucket keep
-- reading correctly.
--
-- WHAT REPLACES THE TRIGGER. Nothing, on the way in: a part is now always
-- created at 0 and stock enters only through `add_stock_at_location`, which has
-- always required a location. `enforce_tracked_part_quantity` grows an INSERT
-- arm so that rule is enforced at rest rather than by convention -- a caller
-- that tries to insert a part carrying 500 is refused rather than quietly
-- producing a `parts.quantity` no balance row supports.
-- ============================================================================


-- ============================================================================
-- 1. Reset every balance to zero
-- ============================================================================
-- DELETE rather than `SET quantity = 0`: `part_location_stock` CHECKs
-- `quantity > 0` (20260802144310), so a zero row is not a representable state.
-- "Zero" IS the absence of a row, and `trg_recompute_part_quantity` fires on
-- DELETE, so `parts.quantity` follows to 0 by the path it always uses.
DELETE FROM public.part_location_stock;


-- ============================================================================
-- 2. Delete the buckets themselves
-- ============================================================================
-- After the balances, because `part_location_stock.location_id` is ON DELETE
-- RESTRICT. `Unassigned` is always a root with no children, so the self-FK
-- (also RESTRICT) has nothing to say.
DELETE FROM public.inventory_locations WHERE kind = 'system';


-- ============================================================================
-- 3. Drop the machinery that fed it
-- ============================================================================
DROP TRIGGER IF EXISTS trg_seed_new_part_balance ON public.parts;
DROP FUNCTION IF EXISTS public.seed_new_part_balance();
DROP FUNCTION IF EXISTS public.inv_get_or_create_unassigned(uuid);


-- ============================================================================
-- 4. A part is created at zero, and that is now a rule rather than a habit
-- ============================================================================
-- Recreated from the LIVE definition (`pg_get_functiondef`) with an INSERT arm
-- added -- not from the migration that created it, which is how a body silently
-- reverts to an older state (see CLAUDE.md; this repo has done it five times).
--
-- The UPDATE arm is unchanged. The INSERT arm is new and says the thing the
-- dropped trigger used to paper over: at INSERT there are no balance rows for a
-- brand-new id, so the only quantity consistent with the rollup is 0.
CREATE OR REPLACE FUNCTION public.enforce_tracked_part_quantity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_expected numeric;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF COALESCE(NEW.quantity, 0) <> 0 THEN
            RAISE EXCEPTION 'A new part starts at 0; stock enters through add_stock_at_location, which names a location (attempted %)',
                NEW.quantity
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.quantity IS DISTINCT FROM OLD.quantity THEN
        v_expected := COALESCE(
            (SELECT SUM(quantity) FROM public.part_location_stock WHERE part_id = NEW.id),
            0);

        IF NEW.quantity IS DISTINCT FROM v_expected THEN
            RAISE EXCEPTION 'parts.quantity is maintained from part_location_stock; direct quantity writes are not allowed (attempted %, expected %)',
                NEW.quantity, v_expected
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_tracked_part_quantity() IS
  'parts.quantity is a rollup of part_location_stock and is never written directly. On INSERT the only consistent value is 0 -- a brand-new part has no balances, and stock enters through add_stock_at_location, which names a location. On UPDATE the value must equal the rollup, which is what recompute_part_quantity_from_locations writes.';

-- The trigger only fired BEFORE UPDATE, so the INSERT arm above would never run.
DROP TRIGGER IF EXISTS trg_enforce_tracked_part_quantity ON public.parts;
CREATE TRIGGER trg_enforce_tracked_part_quantity
    BEFORE INSERT OR UPDATE ON public.parts
    FOR EACH ROW EXECUTE FUNCTION public.enforce_tracked_part_quantity();


-- ============================================================================
-- 5. `system` stops being a kind anything can hold
-- ============================================================================
-- The column stays -- it is free-text describing what a place IS ("shelf",
-- "rack") -- but nothing may wear the reserved kind again, or the branches this
-- migration deleted would need to come back.
ALTER TABLE public.inventory_locations
    DROP CONSTRAINT IF EXISTS inventory_locations_kind_not_system;
ALTER TABLE public.inventory_locations
    ADD CONSTRAINT inventory_locations_kind_not_system
    CHECK (kind IS NULL OR lower(btrim(kind)) <> 'system');


-- ============================================================================
-- Guards
-- ============================================================================
DO $guard$
BEGIN
    IF EXISTS (SELECT 1 FROM public.inventory_locations WHERE kind = 'system') THEN
        RAISE EXCEPTION 'a system bucket survived the reset';
    END IF;

    IF EXISTS (SELECT 1 FROM public.part_location_stock) THEN
        RAISE EXCEPTION 'a balance survived the reset';
    END IF;

    -- The rollup followed the delete rather than being left behind as a number
    -- pointing at nothing, which is the whole reason this reset is a DELETE.
    IF EXISTS (SELECT 1 FROM public.parts WHERE quantity <> 0) THEN
        RAISE EXCEPTION 'a part kept a quantity with no balance behind it';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('inv_get_or_create_unassigned', 'seed_new_part_balance')
    ) THEN
        RAISE EXCEPTION 'the Unassigned machinery is still callable';
    END IF;
END $guard$;
