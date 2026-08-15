-- ═══════════════════════════════════════════════════════════════════════════════
-- A location tree is at most 5 levels deep, and now the database says so
-- ═══════════════════════════════════════════════════════════════════════════════
-- `LevelConfigStep.MAX_LEVELS` is 4 — four levels UNDER a unit, five counting it — and that number
-- has been a disabled button and nothing else. Nothing stopped `create_location_tree`,
-- `apply_location_layout` or a plain INSERT from going deeper.
--
-- ## Why the cap is real rather than tidy
--
-- `readUnitLayout` decides how a unit is drawn, and it can draw four levels below a unit: a grid,
-- then one chooser, then two. Past that it gives up and renders a flat list captioned "this one
-- nests deeper than the grid draws" — and until 2026-08-15 clicking a row of that list made the row
-- the pane's subject, which on a wide screen had no path back to the cabinet it came from. So the
-- founder built a 320-location cabinet with the wizard, at exactly the depth the wizard allowed,
-- and the app could neither draw it nor let him move between its rows.
--
-- The two numbers now agree deliberately: the editor allows what the grid draws, and the database
-- refuses the rest. Better a refusal at the one moment someone is building a shape nothing can
-- render than a cabinet that is already wrong.
--
-- ## Existing data is NOT migrated
--
-- Audited before writing this: production holds nothing deeper than 3 levels below a unit. A shop
-- that somehow has one keeps it — the constraint is a trigger on write, not a CHECK, so nothing
-- existing is invalidated and `readUnitLayout` still has its list fallback for exactly that row.
-- Rewriting somebody's cabinet to satisfy a new rule is not a migration, it is data loss.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The rule
-- ─────────────────────────────────────────────────────────────────────────────
-- Depth is counted from the ROOT: a root is 1, its children 2, and 5 is the floor of the deepest
-- unit the grid draws. Checking on the way DOWN (this row's own depth) rather than measuring the
-- whole subtree keeps it O(depth) per insert instead of O(subtree).
CREATE OR REPLACE FUNCTION public.assert_location_depth()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    MAX_DEPTH constant integer := 5;   -- root + 4 levels, matching LevelConfigStep.MAX_LEVELS
    v_depth   integer := 1;
    v_cursor  uuid := NEW.parent_id;
    v_guard   integer := 0;
BEGIN
    WHILE v_cursor IS NOT NULL LOOP
        v_guard := v_guard + 1;
        -- `inventory_locations_parent_fkey` cannot express acyclicity, so a cycle is representable
        -- and would spin here forever. Bail well inside the depth we care about.
        IF v_guard > 100 THEN
            RAISE EXCEPTION 'location % sits in a cycle', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        v_depth := v_depth + 1;
        SELECT parent_id INTO v_cursor FROM public.inventory_locations WHERE id = v_cursor;
    END LOOP;

    IF v_depth > MAX_DEPTH THEN
        RAISE EXCEPTION
          'Storage can be % levels deep at most, and % would be level %. Put it in one of the levels above instead.',
          MAX_DEPTH, NEW.name, v_depth
          USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$$;

COMMENT ON FUNCTION public.assert_location_depth() IS
  'Constraint-trigger body capping a location tree at 5 levels (a root plus 4), which is what readUnitLayout can draw and what LevelConfigStep.MAX_LEVELS allows. Counts up from the row rather than down through the subtree, so an insert costs O(depth). Does not invalidate existing deeper rows — it fires on write only.';

-- Trigger functions are invoked by the trigger machinery, not by callers, so they need no EXECUTE
-- grant. Revoking anyway, per the standing idiom: correct under either default-privilege state.
REVOKE EXECUTE ON FUNCTION public.assert_location_depth() FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The trigger
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFERRABLE INITIALLY IMMEDIATE, matching `location_children_hold_no_stock`. `apply_location_layout`
-- defers that one by name and does not defer this one — it has no reason to pass through an
-- over-deep intermediate state, and a depth check that could be waived by any caller would be the
-- guard-shaped hole 20260806160053 warns about.
--
-- Fires on INSERT and on a parent change, which are the only two ways a row's depth can move. A
-- rename cannot deepen anything.
DROP TRIGGER IF EXISTS location_depth_capped ON public.inventory_locations;
CREATE CONSTRAINT TRIGGER location_depth_capped
    AFTER INSERT OR UPDATE OF parent_id ON public.inventory_locations
    DEFERRABLE INITIALLY IMMEDIATE
    FOR EACH ROW EXECUTE FUNCTION public.assert_location_depth();
