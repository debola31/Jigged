-- Bump parts.updated_at when a part's *satellite* data changes.
--
-- Why: the parts list and the quote part-picker now default to "most recently
-- updated", but the existing parts_updated_at trigger only fires on edits to the
-- parts row itself (name, description, stock, etc.). Editing a part's routing,
-- pricing tiers, BOM, or procurement cost — which is most of the real
-- post-creation work — lives in separate tables and never touched
-- parts.updated_at, so recency-sort would miss the parts people just worked on.
--
-- These AFTER triggers bump the owning part's updated_at on any write to its
-- satellite tables. We do it in the DB (not the access layer) so the importer
-- and re-import upsert paths are covered too, and so every current and future
-- writer stays consistent — mirroring how update_updated_at_column already works.
--
-- No schema/column change (updated_at already exists), so types/database.ts is
-- unaffected. SECURITY INVOKER (the default): the bump runs under the caller who
-- was already allowed to write the satellite row, so parts RLS is respected and
-- no GRANT is needed (trigger functions don't require EXECUTE to fire).

-- Tables with a direct part_id (routings, part_pricing_tiers, part_procurement_tiers).
CREATE OR REPLACE FUNCTION public.touch_part_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_part_id uuid;
BEGIN
  v_part_id := COALESCE(NEW.part_id, OLD.part_id);
  IF v_part_id IS NOT NULL THEN
    UPDATE public.parts SET updated_at = now() WHERE id = v_part_id;
  END IF;
  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$$;

-- parts_bom: the edited part is the PARENT (its cost/composition changed); the
-- child part itself is unchanged, so only the parent's updated_at bumps.
CREATE OR REPLACE FUNCTION public.touch_parent_part_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_part_id uuid;
BEGIN
  v_part_id := COALESCE(NEW.parent_part_id, OLD.parent_part_id);
  IF v_part_id IS NOT NULL THEN
    UPDATE public.parts SET updated_at = now() WHERE id = v_part_id;
  END IF;
  RETURN NULL;
END;
$$;

-- routing_operations link to a routing, not a part — resolve the part via the
-- routing. If the routing is already gone (e.g. a cascading delete), the lookup
-- yields nothing and we simply skip (the part is being removed anyway).
CREATE OR REPLACE FUNCTION public.touch_part_from_routing_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_routing_id uuid;
  v_part_id uuid;
BEGIN
  v_routing_id := COALESCE(NEW.routing_id, OLD.routing_id);
  IF v_routing_id IS NOT NULL THEN
    SELECT part_id INTO v_part_id FROM public.routings WHERE id = v_routing_id;
    IF v_part_id IS NOT NULL THEN
      UPDATE public.parts SET updated_at = now() WHERE id = v_part_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_touch_part_on_routings
  AFTER INSERT OR UPDATE OR DELETE ON public.routings
  FOR EACH ROW EXECUTE FUNCTION public.touch_part_updated_at();

CREATE TRIGGER trg_touch_part_on_pricing_tiers
  AFTER INSERT OR UPDATE OR DELETE ON public.part_pricing_tiers
  FOR EACH ROW EXECUTE FUNCTION public.touch_part_updated_at();

CREATE TRIGGER trg_touch_part_on_procurement_tiers
  AFTER INSERT OR UPDATE OR DELETE ON public.part_procurement_tiers
  FOR EACH ROW EXECUTE FUNCTION public.touch_part_updated_at();

CREATE TRIGGER trg_touch_part_on_bom
  AFTER INSERT OR UPDATE OR DELETE ON public.parts_bom
  FOR EACH ROW EXECUTE FUNCTION public.touch_parent_part_updated_at();

CREATE TRIGGER trg_touch_part_on_routing_operations
  AFTER INSERT OR UPDATE OR DELETE ON public.routing_operations
  FOR EACH ROW EXECUTE FUNCTION public.touch_part_from_routing_operation();
