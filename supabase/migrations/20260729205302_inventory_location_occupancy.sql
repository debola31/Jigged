-- Per-location occupancy, for the storage board (Phase 2 / J2, docs/modules/inventory.md §5.5).
--
-- The board needs "is there anything in this bin?" for every location at once. Reading
-- part_location_stock flat and counting client-side is not merely slower — supabase/config.toml
-- sets `max_rows = 1000`, so on a shop with a few thousand stocked parts (every one of which
-- gets an Unassigned balance row from trg_auto_track_stocked_part) the read would **silently
-- stop at 1000** and render wrong fill state with no error. Aggregating here is constant-size:
-- one row per occupied location, ~22 for the shop we serve.
--
-- Counts DISTINCT LIVE PARTS, never a quantity sum. Quantities at one location are per-part in
-- each part's own primary_unit, so 40 bearings + 3 castings does not sum to anything meaningful.
-- "Occupied" is the honest signal, and it is exactly the two-bin kanban state §5.5 wants: an
-- absent row means empty.
--
-- Deliberately NOT filtered on parts.is_stocked. If a part was de-stocked but material is still
-- physically on the shelf, the shelf is occupied. Truth over tidiness.
--
-- security_invoker: the view runs with the CALLER's permissions, so part_location_stock's
-- existing company-scoped SELECT policy applies and this needs no policy of its own.
CREATE OR REPLACE VIEW public.inventory_location_occupancy
WITH (security_invoker = true) AS
  SELECT pls.company_id,
         pls.location_id,
         count(DISTINCT pls.part_id)::integer AS part_count
    FROM public.part_location_stock pls
    JOIN public.parts p ON p.id = pls.part_id
   WHERE pls.quantity > 0
     AND p.deleted_at IS NULL          -- archived parts are not stock on a shelf
   GROUP BY pls.company_id, pls.location_id;

COMMENT ON VIEW public.inventory_location_occupancy IS
  'Distinct live parts held directly at each location (quantity > 0). Absent row = empty. '
  'Never a quantity sum — per-part units are not summable. Read by the storage board.';

-- No `anon` grant: this is never read logged out.
-- No billing write-gate: tenant_tables_missing_write_gate() filters relkind = 'r', so a view is
-- invisible to it, and a view has nothing to write to anyway.
GRANT SELECT ON public.inventory_location_occupancy TO authenticated;
GRANT SELECT ON public.inventory_location_occupancy TO service_role;
