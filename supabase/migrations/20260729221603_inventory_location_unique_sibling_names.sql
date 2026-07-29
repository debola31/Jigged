-- Two siblings can't share a name.
--
-- Free-text location names decayed exactly as predicted in the legacy data we imported from
-- Contour: `STOCK` alongside `ST0CK`, `JEFF'S DESK` alongside `JEFFS DESK`. A board is only worth
-- looking at if each tile is one place, and two rows both called "Shelf A" under the same cabinet
-- means an operator's scan and their eyes disagree.
--
-- Scoped to NAMES, not codes. A duplicate `code` has no functional consequence — QR payloads
-- carry the location UUID and nothing in the app resolves by code — so constraining codes would
-- buy nothing while risking a mid-flight insert failure inside the sequential, non-transactional
-- `materializeLocationSpec`. See docs/modules/inventory.md §5.5.
--
-- Ordering matters and is deliberate: **the data is fixed at rest before the index exists.**
-- Adding the index first would fail on any company that already has a collision, and a failing
-- migration blocks the PR's preview branch (and therefore merge). CLAUDE.md's "reuse revives"
-- rule does not apply here — `inventory_locations` has no `deleted_at`.

-- ---------------------------------------------------------------------------
-- 1. Fix the data at rest.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_new_name text;
  v_suffix int;
BEGIN
  -- Walk collision groups, keeping the OLDEST row's name and suffixing the rest.
  --
  -- `kind = 'system'` sorts first inside every group, which is the load-bearing part of this
  -- query. The pre-existing guard is `UNIQUE (company_id) WHERE name = 'Unassigned'` — an EXACT
  -- literal — so a user-created `unassigned` or `Unassigned ` can already sit beside the
  -- auto-managed bucket today, and the new case-folded index collides them.
  --
  -- If this block ever renamed the system row the failure would be silent, not loud:
  -- `inv_get_or_create_unassigned` resolves by literal name, would find nothing, and would create
  -- a SECOND empty bucket — while every existing balance stayed in the renamed one. Every stock
  -- RPC for that company would then write to a bucket sharing nothing with the stock.
  --
  -- `created_at` ordering only *usually* spares it. Sorting on kind makes it certain.
  FOR r IN
    SELECT id, company_id, parent_id, name, kind
      FROM (
        SELECT id, company_id, parent_id, name, kind,
               row_number() OVER (
                 PARTITION BY company_id,
                              coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
                              lower(btrim(name))
                 ORDER BY (kind = 'system') DESC, created_at, id
               ) AS rn
          FROM public.inventory_locations
      ) ranked
     WHERE rn > 1
     ORDER BY company_id, parent_id, name
  LOOP
    -- Find the first free suffix rather than assuming " 2" is available. `btrim` so a name that
    -- collided *because* of stray whitespace doesn't become "unassigned  2" with a double space.
    v_suffix := 2;
    LOOP
      v_new_name := btrim(r.name) || ' ' || v_suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.inventory_locations x
         WHERE x.company_id = r.company_id
           AND coalesce(x.parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce(r.parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
           AND lower(btrim(x.name)) = lower(btrim(v_new_name))
      );
      v_suffix := v_suffix + 1;
    END LOOP;

    UPDATE public.inventory_locations SET name = v_new_name, updated_at = now() WHERE id = r.id;

    -- Support has to be able to answer "why is my location called JEFFS DESK 2".
    RAISE NOTICE 'inventory_locations: renamed % (%) to % — duplicate sibling name',
      r.name, r.id, v_new_name;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Stop it happening again.
-- ---------------------------------------------------------------------------
-- An EXPRESSION index, for two reasons:
--
--  * `UNIQUE (company_id, parent_id, name)` would not constrain top-level locations at all —
--    NULLs compare distinct in a unique index, so every root would be exempt. The sentinel UUID
--    collapses NULL parents into one comparable group.
--  * `lower(btrim(...))` catches the variants a human types. It cannot catch `ST0CK` vs `STOCK`;
--    nothing exact can, which is why the form also warns live as you type.
CREATE UNIQUE INDEX IF NOT EXISTS inventory_locations_unique_sibling_name
  ON public.inventory_locations (
    company_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  );

COMMENT ON INDEX public.inventory_locations_unique_sibling_name IS
  'One name per parent per company, case- and whitespace-insensitive. Names only: duplicate codes '
  'are harmless (QR payloads are UUIDs). The backfill in this migration never renames a '
  'kind=''system'' row — see the migration body.';
