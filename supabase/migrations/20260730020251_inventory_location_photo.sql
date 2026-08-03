-- One photo per storage location.
--
-- `docs/modules/inventory.md` §5.5 decision 5: "A photo of the actual rack beats any icon." The
-- board draws furniture from a `kind` string, which is a guess at what the thing looks like; a
-- photograph of the actual shelf is how someone recognises it from across the shop.
--
-- **A column, not a table.** `part_attachments` and `note_media` are tables because they hold MANY
-- files per parent, with their own kinds, uploaders and ordering. A location has one photo — the
-- decision asks for one, and a gallery of a shelf is not a thing anyone wants. A column also
-- inherits everything already true of this table: its RLS policies and, importantly, its
-- `billing_gate_*` restrictive policies. A new table would have needed all of that rebuilt, plus
-- grants, plus an entry in the CI write-gate check.
--
-- The value is a path into the existing private `attachments` bucket, whose `storage.objects`
-- policies gate on the FIRST path segment being a company the caller belongs to — so the path must
-- always start `{company_id}/`. `generateStoragePath` enforces that shape.
--
-- Nullable and unconstrained on purpose: no photo is the normal state, and a location whose file
-- was removed from the bucket should read as "no photo" rather than error. Deleting the row leaves
-- the object orphaned in the bucket, which is the same trade `note_media` makes deliberately (an
-- invisible orphan beats a visible 404).

ALTER TABLE public.inventory_locations
  ADD COLUMN IF NOT EXISTS photo_path text;

COMMENT ON COLUMN public.inventory_locations.photo_path IS
  'Path in the private `attachments` bucket to a photo of this place, or NULL. Always begins '
  '{company_id}/ — the storage.objects RLS policies gate on that first segment. One per location '
  'by design (inventory.md §5.5 decision 5); use a table if that ever needs to be many.';
